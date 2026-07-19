import type {
  DwnReplicationApplyRequest,
  DwnRpc,
  DwnRpcAuthOptions,
  DwnRpcRequest,
  DwnRpcResponse,
  DwnSubscriptionHandler,
  ResubscribeFactory,
} from './dwn-rpc-types.js';
import type { DwnServerInfoRpc, ServerInfo } from './server-info-types.js';
import type {
  GenericMessage,
  MessageSubscription,
  ProgressToken,
  ReplicationApplyResult,
  SubscriptionMessage,
  UnionMessageReply,
} from '@enbox/dwn-sdk-js';

import { CryptoUtils } from '@enbox/crypto';
import { HttpDwnRpcClient } from './http-dwn-rpc-client.js';
import { JsonRpcSocket } from './json-rpc-socket.js';
import { parseReplicationApplyResult } from './replication-apply-result.js';
import { RateLimitError } from './rate-limit-error.js';
import { withLocalNodeTokenQuery } from './rpc-auth.js';
import { createJsonRpcAck, createJsonRpcRequest, createJsonRpcSubscriptionRequest, JsonRpcErrorCodes } from './json-rpc.js';
import { DataStream, Encoder } from '@enbox/dwn-sdk-js';
import { DEFAULT_MAX_WS_RAW_RECORD_DATA_BYTES, maxWsJsonRpcPayloadBytes } from './ws-payload-size.js';
import { DwnRpcError, SubscriptionHandlerTerminalError } from './dwn-rpc-error.js';

const DEFAULT_MAX_WS_JSON_RPC_PAYLOAD_BYTES = maxWsJsonRpcPayloadBytes(DEFAULT_MAX_WS_RAW_RECORD_DATA_BYTES);

/**
 * Metadata for a tracked subscription, including everything needed to
 * resubscribe after a reconnection.
 */
interface TrackedSubscription {
  /** The DWN `MessageSubscription` handle. */
  subscription: MessageSubscription;

  /** The target DID for the subscription. */
  target: string;

  /** The original DWN subscribe message (fallback when no resubscribeFactory). */
  message: GenericMessage;

  /** The application-level subscription handler. */
  handler: DwnSubscriptionHandler;

  /**
   * Factory that reconstructs and re-signs the subscribe message with a cursor.
   * When present, used instead of the original `message` during resubscription.
   */
  resubscribeFactory?: ResubscribeFactory;

  /** The progress token from the most recently received subscription event. */
  lastCursor?: ProgressToken;
}

interface SocketConnection {
  socket: JsonRpcSocket;
  subscriptions: Map<string, TrackedSubscription>;
  /** The original URL used to create this connection. */
  url: string;
}

function connectionCacheKey(url: URL): string {
  return stripTrailingSlash(url.toString());
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function redactConnectionError(error: unknown, url: URL, displayUrl: URL): string {
  let detail = error instanceof Error ? error.message : String(error);
  const unsafeUrls = new Set([url.toString(), stripTrailingSlash(url.toString())]);
  for (const unsafeUrl of unsafeUrls) {
    detail = detail.replaceAll(unsafeUrl, displayUrl.toString());
  }

  const sensitiveValues = [url.username, url.password, ...url.searchParams.values()];
  for (const value of sensitiveValues) {
    if (value.length === 0) {
      continue;
    }
    detail = detail.replaceAll(value, '[REDACTED]');
    detail = detail.replaceAll(encodeURIComponent(value), '[REDACTED]');
  }

  return detail;
}

function shouldReplaceLastCursor(current: ProgressToken | undefined, candidate: ProgressToken): boolean {
  if (current === undefined) {
    return true;
  }

  if (candidate.streamId !== current.streamId || candidate.epoch !== current.epoch) {
    return true;
  }

  return BigInt(candidate.position) > BigInt(current.position);
}

export class WebSocketDwnRpcClient implements DwnRpc {
  public get transportProtocols(): string[] { return ['ws:', 'wss:']; }
  // a map of normalized DWN WebSocket endpoint URLs to WebSocket connections
  private static readonly connections = new Map<string, SocketConnection>();
  private static readonly pendingConnections = new Map<string, Promise<SocketConnection>>();

  /**
   * Sockets evicted from the pool by an unexpected close while their
   * auto-reconnect loop runs. The pool only holds live connections, so
   * without this registry a wake signal could never reach exactly the
   * sockets that need it — the ones parked in reconnect backoff. Entries
   * move back to the pool on reconnection and leave the registry.
   */
  private static readonly reconnectingSockets = new Set<JsonRpcSocket>();

  /** Browser wake listeners (online / tab visible), registered once per process. */
  private static onWake: (() => void) | undefined;
  private static onVisibilityWake: (() => void) | undefined;

  /**
   * Force an immediate liveness verdict on every pooled connection and every
   * socket reconnecting outside the pool.
   *
   * Dead sockets are detected and torn down right away — triggering
   * auto-reconnect and resubscription — and sockets parked in reconnect
   * backoff have that wait fast-forwarded, instead of waiting out timers
   * that browsers throttle in backgrounded tabs.
   */
  public static checkAllConnections(): void {
    for (const connection of WebSocketDwnRpcClient.connections.values()) {
      void connection.socket.checkHealth();
    }
    for (const socket of WebSocketDwnRpcClient.reconnectingSockets) {
      if (socket.isClosedByUser) {
        WebSocketDwnRpcClient.reconnectingSockets.delete(socket);
        continue;
      }
      void socket.checkHealth();
    }
  }

  /**
   * Registers browser recovery listeners so wake signals (network back
   * online, tab foregrounded) trigger an immediate pooled-connection health
   * check. No-op outside browser-like environments and after the first call.
   */
  private static ensureWakeListeners(): void {
    if (WebSocketDwnRpcClient.onWake !== undefined) {
      return;
    }
    if (typeof globalThis.addEventListener !== 'function') {
      return;
    }

    const onWake = (): void => { WebSocketDwnRpcClient.checkAllConnections(); };
    WebSocketDwnRpcClient.onWake = onWake;
    globalThis.addEventListener('online', onWake);

    const visibilityDocument = typeof document === 'undefined' ? undefined : document;
    if (visibilityDocument !== undefined) {
      const onVisibilityWake = (): void => {
        if (visibilityDocument.visibilityState === 'visible') {
          onWake();
        }
      };
      WebSocketDwnRpcClient.onVisibilityWake = onVisibilityWake;
      visibilityDocument.addEventListener('visibilitychange', onVisibilityWake);
    }
  }

  /** Removes the browser wake listeners registered by {@link ensureWakeListeners}. */
  private static removeWakeListeners(): void {
    if (WebSocketDwnRpcClient.onWake !== undefined && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', WebSocketDwnRpcClient.onWake);
    }
    if (WebSocketDwnRpcClient.onVisibilityWake !== undefined && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', WebSocketDwnRpcClient.onVisibilityWake);
    }
    WebSocketDwnRpcClient.onWake = undefined;
    WebSocketDwnRpcClient.onVisibilityWake = undefined;
  }

  public constructor(
    private readonly serverInfoRpc: DwnServerInfoRpc = new HttpDwnRpcClient(),
    private readonly authOptions: DwnRpcAuthOptions = {},
  ) {}

  /**
   * Closes every pooled WebSocket connection and clears the pool.
   *
   * Each connection's tracked subscriptions are closed best-effort, then the
   * underlying socket (and its heartbeat timer) is closed. Connections still
   * being established are awaited so they cannot leak into a cleared pool.
   * The pool is process-wide, so this is intended for application shutdown.
   */
  public static async closeAllConnections(): Promise<void> {
    WebSocketDwnRpcClient.removeWakeListeners();
    const pending = [...WebSocketDwnRpcClient.pendingConnections.values()];
    WebSocketDwnRpcClient.pendingConnections.clear();
    for (const pendingConnection of pending) {
      try {
        await pendingConnection;
      } catch {
        // The connection failed to establish — nothing to close.
      }
    }

    const connections = [...WebSocketDwnRpcClient.connections.values()];
    WebSocketDwnRpcClient.connections.clear();
    for (const connection of connections) {
      for (const tracked of connection.subscriptions.values()) {
        try {
          await tracked.subscription.close();
        } catch {
          // Best-effort — closing the socket below tears down the transport.
        }
      }
      connection.subscriptions.clear();
      try {
        connection.socket.close();
      } catch {
        // Best-effort.
      }
    }

    // Sockets mid-reconnect are outside the pool; without this they would
    // keep reconnecting after shutdown and re-register into a cleared pool.
    const reconnecting = [...WebSocketDwnRpcClient.reconnectingSockets];
    WebSocketDwnRpcClient.reconnectingSockets.clear();
    for (const socket of reconnecting) {
      try {
        socket.close();
      } catch {
        // Best-effort.
      }
    }
  }

  async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {

    // validate that the dwn URL provided is a valid WebSocket URL
    const url = new URL(request.dwnUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(`Invalid websocket protocol ${url.protocol}`);
    }

    const connection = await this.getConnection(request.dwnUrl);
    const { targetDid, message, subscription } = request;

    if (subscription) {
      return WebSocketDwnRpcClient.subscriptionRequest(
        connection, targetDid, message, subscription.handler, subscription.resubscribeFactory
      );
    }

    return WebSocketDwnRpcClient.processMessage(connection, targetDid, message);
  }

  async applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> {
    WebSocketDwnRpcClient.assertReplicatedApplyDataIsPresent(request);
    const maxPayloadBytes = await this.maxPayloadBytesForReplicatedApply(request);
    WebSocketDwnRpcClient.assertReplicatedApplyDataSizeIsSupported(request, maxPayloadBytes);
    const connection = await this.getConnection(request.dwnUrl);
    const encodedData = request.data === undefined ? undefined : await dataToBase64Url(request.data);
    return WebSocketDwnRpcClient.applyReplicatedMessage(connection, request.targetDid, request.message, encodedData, maxPayloadBytes);
  }

  async getServerInfo(dwnUrl: string): Promise<ServerInfo> {
    return this.serverInfoRpc.getServerInfo(httpUrlForWsDwnUrl(dwnUrl));
  }

  private async maxPayloadBytesForReplicatedApply(request: DwnReplicationApplyRequest): Promise<number> {
    const dataSize = recordsWriteDataSize(request.message);
    if (dataSize === undefined) {
      return DEFAULT_MAX_WS_JSON_RPC_PAYLOAD_BYTES;
    }

    const serverInfo = await this.getServerInfo(request.dwnUrl);
    return maxWsJsonRpcPayloadBytes(serverInfo.maxFileSize);
  }

  private async getConnection(dwnUrl: string): Promise<SocketConnection> {
    const url = withLocalNodeTokenQuery(dwnUrl, this.authOptions);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(`Invalid websocket protocol ${url.protocol}`);
    }

    const key = connectionCacheKey(url);
    const displayUrl = new URL(url);
    displayUrl.username = '';
    displayUrl.password = '';
    displayUrl.search = '';
    displayUrl.hash = '';
    const existing = WebSocketDwnRpcClient.connections.get(key);
    if (existing !== undefined) {
      return existing;
    }

    let pending = WebSocketDwnRpcClient.pendingConnections.get(key);
    if (pending === undefined) {
      WebSocketDwnRpcClient.ensureWakeListeners();
      pending = WebSocketDwnRpcClient.createConnection(url)
        .then((connection) => {
          // Ownership: an evicted socket may have reconnected and re-taken
          // the endpoint while this replacement was being established. The
          // caller awaiting this promise will use THIS connection, so it wins
          // the pool entry and the displaced socket closes — exactly one
          // socket per endpoint survives the race.
          const displaced = WebSocketDwnRpcClient.connections.get(key);
          WebSocketDwnRpcClient.connections.set(key, connection);
          if (displaced !== undefined && displaced.socket !== connection.socket) {
            try {
              displaced.socket.close();
            } catch { /* best effort */ }
          }
          return connection;
        })
        .catch((error: unknown) => {
          throw new Error(`Error connecting to ${displayUrl.toString()}: ${redactConnectionError(error, url, displayUrl)}`);
        })
        .finally(() => {
          WebSocketDwnRpcClient.pendingConnections.delete(key);
        });
      WebSocketDwnRpcClient.pendingConnections.set(key, pending);
    }

    return pending;
  }

  /**
   * Creates a new `SocketConnection` with lifecycle wiring for reconnection.
   */
  private static async createConnection(url: URL): Promise<SocketConnection> {
    const key = connectionCacheKey(url);
    const subscriptions = new Map<string, TrackedSubscription>();

    const socket = await JsonRpcSocket.connect(url.toString(), {
      onclose: (): void => {
        // Remove the stale connection from the map so new requests create a
        // fresh one — but only while this socket still owns the endpoint's
        // pool entry: a stale close from a superseded socket must not evict
        // its replacement. Register the socket as reconnecting so wake-driven
        // health checks can still reach it and fast-forward its backoff.
        const current = WebSocketDwnRpcClient.connections.get(key);
        if (current?.socket === socket) {
          WebSocketDwnRpcClient.connections.delete(key);
        }
        if (!socket.isClosedByUser) {
          WebSocketDwnRpcClient.reconnectingSockets.add(socket);
        }

        // Notify all subscription handlers of disconnection. Invocation is
        // normalized so one throwing handler cannot skip the rest.
        for (const tracked of subscriptions.values()) {
          WebSocketDwnRpcClient.invokeHandler(tracked.handler, { type: 'disconnected' });
        }
      },

      onreconnecting: (attempt: number): void => {
        for (const tracked of subscriptions.values()) {
          WebSocketDwnRpcClient.invokeHandler(tracked.handler, { type: 'reconnecting', attempt });
        }
      },

      onreconnected: (): void => {
        WebSocketDwnRpcClient.reconnectingSockets.delete(socket);

        // A user-closed socket must never re-enter the pool: shutdown may
        // have raced an in-flight reconnection, and re-registering here would
        // resurrect networking the caller believes is stopped.
        if (socket.isClosedByUser) {
          return;
        }

        // Ownership: a request that arrived while this socket was
        // reconnecting created a replacement connection for the endpoint.
        // The pooled connection is the one with live consumers — a superseded
        // socket closes itself instead of overwriting it, so exactly one
        // socket per endpoint survives the race.
        const current = WebSocketDwnRpcClient.connections.get(key);
        if (current !== undefined && current.socket !== socket) {
          try {
            socket.close();
          } catch { /* best effort */ }
          return;
        }

        // Re-register this connection in the map (it was deleted on close).
        const conn = { socket, subscriptions, url: url.toString() };
        WebSocketDwnRpcClient.connections.set(key, conn);

        // Resubscribe all tracked subscriptions with their last known cursor.
        WebSocketDwnRpcClient.resubscribeAll(conn);
      },
    });

    return { socket, subscriptions, url: url.toString() };
  }

  private static async processMessage(
    connection: SocketConnection, target: string, message: GenericMessage
  ): Promise<DwnRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.processMessage', { target, message });

    const { socket } = connection;
    const response = await socket.request(request);

    const { error, result } = response;
    if (error !== undefined) {
      throw new Error(`error sending DWN request: ${error.message}`);
    }

    return result.reply as DwnRpcResponse;
  }

  private static async applyReplicatedMessage(
    connection: SocketConnection,
    target: string,
    message: DwnReplicationApplyRequest['message'],
    encodedData?: string,
    maxPayloadBytes: number = DEFAULT_MAX_WS_JSON_RPC_PAYLOAD_BYTES,
  ): Promise<ReplicationApplyResult> {
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      target,
      message,
      ...(encodedData === undefined ? {} : { encodedData }),
    });
    WebSocketDwnRpcClient.assertPayloadFitsFrame(request, encodedData, maxPayloadBytes);

    const { socket } = connection;
    const response = await socket.request(request);

    const { error, result } = response;
    if (error !== undefined) {
      throw new DwnRpcError(error.code, error.message, error.data);
    }

    return parseReplicationApplyResult(result.result);
  }

  /**
   * Invokes a subscription handler with every failure mode normalized into
   * the returned promise: a synchronous throw becomes a rejection instead of
   * escaping into the socket's message dispatch, and an asynchronous
   * rejection flows through unchanged. The rejection is pre-observed so call
   * sites that ignore the result (transport lifecycle notifications) cannot
   * surface it as an unhandled rejection — awaiting the returned promise
   * still sees the failure.
   */
  private static invokeHandler(
    handler: DwnSubscriptionHandler,
    message: Parameters<DwnSubscriptionHandler>[0],
  ): Promise<void> {
    const handled = Promise.resolve().then((): void | Promise<void> => handler(message));
    handled.catch((): void => {});
    return handled;
  }

  private static async subscriptionRequest(
    connection: SocketConnection,
    target: string,
    message: GenericMessage,
    handler: DwnSubscriptionHandler,
    resubscribeFactory?: ResubscribeFactory,
  ): Promise<DwnRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const subscriptionId = CryptoUtils.randomUuid();
    const request = createJsonRpcSubscriptionRequest(
      requestId, 'rpc.subscribe.dwn.processMessage', { target, message }, subscriptionId
    );

    const { socket, subscriptions } = connection;
    let terminalSubscriptionError = false;
    const closeSubscription = (subscription: MessageSubscription): void => {
      Promise.resolve(subscription.close()).catch(() => {});
    };

    const closeTrackedSubscription = (): void => {
      terminalSubscriptionError = true;
      const tracked = subscriptions.get(subscriptionId);
      if (tracked) {
        closeSubscription(tracked.subscription);
      }
      subscriptions.delete(subscriptionId);
    };

    // Acks are chained per subscription: each fires only after its event's
    // handler has fully processed (a promise-returning handler, e.g. the
    // agent's decrypting wrapper, gates it), and in arrival order — so the
    // server's flow-control window cannot outrun slow processing. The
    // reconnect cursor advances on the same completion: an event the consumer
    // never fully processed must be replayed by a resubscription, never
    // skipped, so cursor and ack move together or not at all.
    let ackChain: Promise<void> = Promise.resolve();
    let terminalHandlerFailure = false;
    const { response, close } = await socket.subscribe(request, (response) => {
      if (terminalHandlerFailure) {
        return;
      }

      const { result, error } = response;
      if (error) {
        closeTrackedSubscription();
        return;
      }

      const subscriptionMessage = result.subscription as SubscriptionMessage;
      const handled = WebSocketDwnRpcClient.invokeHandler(handler, subscriptionMessage);

      if (subscriptionMessage.type === 'error') {
        closeTrackedSubscription();
        return;
      }

      if ('cursor' in subscriptionMessage && subscriptionMessage.cursor) {
        const cursor = subscriptionMessage.cursor;
        ackChain = ackChain
          .then(async (): Promise<void> => {
            if (terminalHandlerFailure) {
              return;
            }
            try {
              await handled;
            } catch (handlerError: unknown) {
              if (handlerError instanceof SubscriptionHandlerTerminalError) {
                // The consumer pipeline is terminally failed from this event
                // on: close out the subscription and leave this event — and
                // every later one — unacknowledged and cursor-untracked so a
                // resubscription replays them. The thrower already informed
                // its own consumer.
                terminalHandlerFailure = true;
                closeTrackedSubscription();
                return;
              }
              // Ordinary handler failures keep the plain-handler convention:
              // swallowed, acknowledged, delivery continues.
            }

            const tracked = subscriptions.get(subscriptionId);
            if (tracked && shouldReplaceLastCursor(tracked.lastCursor, cursor)) {
              tracked.lastCursor = cursor;
            }

            // Send rpc.ack to advance the server's flow-control window.
            socket.send(createJsonRpcAck(subscriptionId, cursor));
          })
          .catch(() => {});
      }
    });

    const { error, result } = response;
    if (error) {
      // Preserve the rate-limit signal so callers (e.g. the sync engine) can
      // honor Retry-After, mirroring the HTTP transport. A dropped 429 here
      // would surface as a generic subscribe failure with no recovery hint.
      if (error.code === JsonRpcErrorCodes.TooManyRequests) {
        throw new RateLimitError(error.data?.retryAfterSec ?? 1);
      }
      throw new DwnRpcError(error.code, error.message, error.data);
    }

    const { reply } = result as { reply: UnionMessageReply };
    if (reply.subscription && close) {
      let closed = false;
      const wrappedClose = async (): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        subscriptions.delete(subscriptionId);
        await close();
      };

      const tracked: TrackedSubscription = {
        subscription: { ...reply.subscription, close: wrappedClose },
        target,
        message,
        handler,
        resubscribeFactory,
      };

      reply.subscription.close = wrappedClose;
      if (terminalSubscriptionError) {
        Promise.resolve(wrappedClose()).catch(() => {});
      } else {
        subscriptions.set(subscriptionId, tracked);
      }
    }

    return reply;
  }

  /**
   * Resubscribes all tracked subscriptions on a reconnected socket.
   * Uses the `resubscribeFactory` (if provided) to construct a properly signed
   * message with the last known cursor. Falls back to the original message
   * for anonymous/unsigned subscriptions.
   */
  private static async resubscribeAll(connection: SocketConnection): Promise<void> {
    // Snapshot the current subscriptions — resubscription will re-populate the map.
    const entries = [...connection.subscriptions.entries()];
    connection.subscriptions.clear();

    for (const [, tracked] of entries) {
      try {
        let resumeMessage: GenericMessage;

        if (tracked.resubscribeFactory) {
          // Reconstruct and re-sign the message with the cursor.
          resumeMessage = await tracked.resubscribeFactory(tracked.lastCursor);
        } else {
          // No factory — reuse the original message as-is.
          // This only works for anonymous (unsigned) subscriptions.
          resumeMessage = tracked.message;
        }

        await WebSocketDwnRpcClient.subscriptionRequest(
          connection,
          tracked.target,
          resumeMessage,
          tracked.handler,
          tracked.resubscribeFactory,
        );

        // Notify the handler that reconnection is complete for this subscription.
        WebSocketDwnRpcClient.invokeHandler(tracked.handler, { type: 'reconnected' });
      } catch {
        // If resubscription fails for one subscription, continue with the rest.
        // The subscription is effectively lost — the handler was already
        // notified of disconnection.
      }
    }
  }

  private static assertReplicatedApplyDataIsPresent(request: DwnReplicationApplyRequest): void {
    const dataSize = recordsWriteDataSize(request.message);
    if (dataSize !== undefined && dataSize > 0 && request.data === undefined) {
      throw new DwnRpcError(
        JsonRpcErrorCodes.InvalidParams,
        'data-bearing RecordsWrite replicated apply over WebSocket requires encoded data',
      );
    }
  }

  private static assertReplicatedApplyDataSizeIsSupported(request: DwnReplicationApplyRequest, maxPayloadBytes: number): void {
    const dataSize = recordsWriteDataSize(request.message);
    if (dataSize !== undefined && maxWsJsonRpcPayloadBytes(dataSize) > maxPayloadBytes) {
      throw new DwnRpcError(
        JsonRpcErrorCodes.InvalidParams,
        `RecordsWrite replicated apply data is too large for WebSocket JSON-RPC framing`,
      );
    }
  }

  private static assertPayloadFitsFrame(
    request: ReturnType<typeof createJsonRpcRequest>,
    encodedData: string | undefined,
    maxPayloadBytes: number,
  ): void {
    const payloadBytes = estimatedJsonRpcPayloadBytes(request, encodedData);
    if (payloadBytes > maxPayloadBytes) {
      throw new DwnRpcError(
        JsonRpcErrorCodes.InvalidParams,
        `replicated apply JSON-RPC payload is too large for WebSocket transport`,
      );
    }
  }
}

function httpUrlForWsDwnUrl(dwnUrl: string): string {
  const url = new URL(dwnUrl);
  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  }
  return url.toString();
}

function estimatedJsonRpcPayloadBytes(request: ReturnType<typeof createJsonRpcRequest>, encodedData: string | undefined): number {
  if (encodedData === undefined) {
    return utf8ByteLength(JSON.stringify(request));
  }

  const params = request.params as Record<string, unknown>;
  const requestWithoutData = {
    ...request,
    params: {
      ...params,
      encodedData: '',
    },
  };
  return utf8ByteLength(JSON.stringify(requestWithoutData)) + encodedData.length;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

async function dataToBase64Url(data: DwnReplicationApplyRequest['data']): Promise<string> {
  if (data instanceof Blob) {
    return Encoder.bytesToBase64Url(new Uint8Array(await data.arrayBuffer()));
  }

  if (data instanceof ReadableStream) {
    return Encoder.bytesToBase64Url(await DataStream.toBytes(data as ReadableStream<Uint8Array>));
  }

  if (data instanceof Uint8Array) {
    return Encoder.bytesToBase64Url(data);
  }

  return Encoder.bytesToBase64Url(new Uint8Array(await new Blob([data] as BlobPart[]).arrayBuffer()));
}

function recordsWriteDataSize(message: DwnReplicationApplyRequest['message']): number | undefined {
  const descriptor = (message as { descriptor?: { interface?: unknown; method?: unknown; dataSize?: unknown } }).descriptor;
  return descriptor?.interface === 'Records' &&
    descriptor.method === 'Write' &&
    typeof descriptor.dataSize === 'number'
    ? descriptor.dataSize
    : undefined;
}
