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
import {
  base64UrlEncodedLength,
  DEFAULT_MAX_WS_RAW_RECORD_DATA_BYTES,
  maxWsJsonRpcPayloadBytes,
  utf8ByteLength,
  WS_JSON_RPC_ENVELOPE_BYTES,
} from './ws-payload-size.js';
import { createJsonRpcAck, createJsonRpcRequest, createJsonRpcSubscriptionRequest, JsonRpcErrorCodes } from './json-rpc.js';
import { DataStream, DwnInterfaceName, DwnMethodName, Encoder } from '@enbox/dwn-sdk-js';
import { DwnRpcError, SocketUnavailableError, SubscriptionHandlerTerminalError } from './dwn-rpc-error.js';

const DEFAULT_MAX_WS_JSON_RPC_PAYLOAD_BYTES = maxWsJsonRpcPayloadBytes(DEFAULT_MAX_WS_RAW_RECORD_DATA_BYTES);
const FRAME_MEASUREMENT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The stable identity of one logical subscription across every transport
 * re-establishment (reconnects, ownership-race adoptions). The `subscription`
 * handle given to the original caller never goes stale: its close() always
 * targets the CURRENT transport subscription, and the entry — including its
 * cursor watermark — is reused rather than recreated on resubscription.
 */
interface TrackedSubscription {
  /** The stable DWN `MessageSubscription` handle handed to the caller. */
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

  /** Transport subscription id of the current establishment (map key + generation guard). */
  currentId: string;

  /** The connection whose map currently tracks this subscription. */
  currentConnection: SocketConnection;

  /** Socket-level close for the current establishment. */
  currentClose: () => Promise<void>;

  /**
   * Set when the subscription logically ends — consumer close or a terminal
   * subscription error. Recovery must never re-establish a closed entry.
   */
  closed: boolean;
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

  /** Whether a message has complete non-streaming request and response parity over WebSocket. */
  private static canSendDwnMessage(message: Partial<GenericMessage>): boolean {
    const descriptor = message.descriptor;
    if (descriptor === undefined) {
      return false;
    }
    if (descriptor.interface === DwnInterfaceName.Records && descriptor.method === DwnMethodName.Write) {
      return false;
    }
    return descriptor.method !== DwnMethodName.Read;
  }

  /** Sends an eligible ordinary request only through an existing pooled socket. */
  public async sendDwnRequestIfConnected(
    request: DwnRpcRequest,
  ): Promise<{ reply: DwnRpcResponse } | undefined> {
    if (request.data !== undefined || request.signal !== undefined || request.timeoutMs !== undefined) {
      return undefined;
    }

    const connection = this.getConnectedConnection(request.dwnUrl);
    if (connection === undefined) {
      return undefined;
    }

    const wireMessage = toWireDwnMessage(request.message);
    if (!WebSocketDwnRpcClient.canSendDwnMessage(wireMessage)) {
      return undefined;
    }

    const frame = createJsonRpcRequest(FRAME_MEASUREMENT_ID, 'dwn.processMessage', {
      target  : request.targetDid,
      message : wireMessage,
    });
    if (utf8ByteLength(JSON.stringify(frame)) > WS_JSON_RPC_ENVELOPE_BYTES) {
      return undefined;
    }

    const reply = await WebSocketDwnRpcClient.processMessage(
      connection,
      request.targetDid,
      wireMessage as GenericMessage,
    );
    return { reply };
  }

  async applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> {
    const wireRequest = toWireReplicationApplyRequest(request);
    WebSocketDwnRpcClient.assertReplicatedApplyDataIsPresent(wireRequest);
    const maxPayloadBytes = await this.maxPayloadBytesForReplicatedApply(wireRequest);
    WebSocketDwnRpcClient.assertReplicatedApplyDataSizeIsSupported(wireRequest, maxPayloadBytes);
    const connection = await this.getConnection(request.dwnUrl);
    const encodedData = wireRequest.data === undefined ? undefined : await dataToBase64Url(wireRequest.data);
    return WebSocketDwnRpcClient.applyReplicatedMessage(
      connection,
      request.targetDid,
      wireRequest.message,
      encodedData,
      maxPayloadBytes,
    );
  }

  /** Applies a replayable message through an existing socket when it fits the bounded frame budget. */
  public async applyReplicatedMessageIfConnected(
    request: DwnReplicationApplyRequest,
  ): Promise<ReplicationApplyResult | undefined> {
    if (this.getConnectedConnection(request.dwnUrl) === undefined) {
      return undefined;
    }

    const wireRequest = toWireReplicationApplyRequest(request);
    const dataBytes = replayableDataByteLength(wireRequest.data);
    if (dataBytes === undefined) {
      return undefined;
    }

    const declaredDataSize = recordsWriteDataSize(wireRequest.message);
    if (declaredDataSize !== undefined && declaredDataSize > 0 && wireRequest.data === undefined) {
      return undefined;
    }

    const encodedDataBytes = wireRequest.data === undefined ? undefined : base64UrlEncodedLength(dataBytes);
    const frame = createJsonRpcRequest(FRAME_MEASUREMENT_ID, 'dwn.applyReplicatedMessage', {
      target  : wireRequest.targetDid,
      message : wireRequest.message,
      ...(wireRequest.data === undefined ? {} : { encodedData: '' }),
    });
    const payloadBytes = estimatedJsonRpcPayloadBytes(frame, encodedDataBytes);
    if (payloadBytes > WS_JSON_RPC_ENVELOPE_BYTES) {
      return undefined;
    }

    const encodedData = wireRequest.data === undefined ? undefined : await dataToBase64Url(wireRequest.data);
    const currentConnection = this.getConnectedConnection(wireRequest.dwnUrl);
    if (currentConnection === undefined) {
      return undefined;
    }
    return WebSocketDwnRpcClient.applyReplicatedMessage(
      currentConnection,
      wireRequest.targetDid,
      wireRequest.message,
      encodedData,
      WS_JSON_RPC_ENVELOPE_BYTES,
    );
  }

  async getServerInfo(dwnUrl: string): Promise<ServerInfo> {
    return this.serverInfoRpc.getServerInfo(httpUrlForWsDwnUrl(dwnUrl));
  }

  private async maxPayloadBytesForReplicatedApply(request: DwnReplicationApplyRequest): Promise<number> {
    if (recordsWriteDataSize(request.message) === undefined) {
      return DEFAULT_MAX_WS_JSON_RPC_PAYLOAD_BYTES;
    }

    const serverInfo = await this.getServerInfo(request.dwnUrl);
    return maxWsJsonRpcPayloadBytes(serverInfo.maxFileSize);
  }

  /** Returns an existing connected pool entry without establishing a socket. */
  private getConnectedConnection(dwnUrl: string): SocketConnection | undefined {
    const url = withLocalNodeTokenQuery(dwnUrl, this.authOptions);
    const connection = WebSocketDwnRpcClient.connections.get(connectionCacheKey(url));
    return connection?.socket.isConnected === true ? connection : undefined;
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
          // the endpoint while this replacement was being established. Its
          // subscriptions are already live there, so the recovered connection
          // is reused and the redundant replacement discarded — no extra
          // resubscription, no duplicate reconnected notification. Only a
          // dead pooled entry is displaced, adopting its subscriptions.
          const current = WebSocketDwnRpcClient.connections.get(key);
          if (current !== undefined && current.socket !== connection.socket) {
            if (current.socket.isConnected) {
              try {
                connection.socket.close();
              } catch { /* best effort */ }
              return current;
            }
            WebSocketDwnRpcClient.adoptSubscriptions(current.subscriptions, connection);
            try {
              current.socket.close();
            } catch { /* best effort */ }
          }
          WebSocketDwnRpcClient.connections.set(key, connection);
          return connection;
        })
        .catch((error: unknown) => {
          // Establishment failure means nothing was ever transmitted on this
          // socket. Surface that fact as a typed rejection (with redacted
          // detail) without silently changing the caller's transport.
          throw new SocketUnavailableError(`Error connecting to ${displayUrl.toString()}: ${redactConnectionError(error, url, displayUrl)}`);
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
        // socket per endpoint survives the race. Its tracked subscriptions
        // move onto the winner first so they keep receiving updates.
        const current = WebSocketDwnRpcClient.connections.get(key);
        if (current !== undefined && current.socket !== socket) {
          WebSocketDwnRpcClient.adoptSubscriptions(subscriptions, current);
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

    // Classify JSON-RPC errors exactly as the HTTP and subscription paths
    // do, so socket-routed requests keep rate-limit and terminal semantics.
    const { error, result } = response;
    if (error !== undefined) {
      if (error.code === JsonRpcErrorCodes.TooManyRequests) {
        throw new RateLimitError(error.data?.retryAfterSec ?? 1);
      }
      throw new DwnRpcError(error.code, error.message, error.data);
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
      if (error.code === JsonRpcErrorCodes.TooManyRequests) {
        throw new RateLimitError(error.data?.retryAfterSec ?? 1);
      }
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
    existingTracked?: TrackedSubscription,
  ): Promise<DwnRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const subscriptionId = CryptoUtils.randomUuid();
    const request = createJsonRpcSubscriptionRequest(
      requestId, 'rpc.subscribe.dwn.processMessage', { target, message }, subscriptionId
    );

    const { socket, subscriptions } = connection;
    let terminalSubscriptionError = false;

    const closeTrackedSubscription = (): void => {
      terminalSubscriptionError = true;
      const tracked = subscriptions.get(subscriptionId);
      // Generation guard: only tear the logical subscription down when THIS
      // establishment is still its current transport binding — a late error
      // from a superseded establishment must not kill a recovered one.
      if (tracked && tracked.currentId === subscriptionId) {
        Promise.resolve(tracked.subscription.close()).catch(() => {});
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
      let tracked: TrackedSubscription;
      if (existingTracked !== undefined) {
        // Re-establishment: the logical subscription (its stable handle and
        // cursor watermark) carries over; only the transport binding changes.
        tracked = existingTracked;
      } else {
        tracked = {
          subscription      : reply.subscription,
          target,
          message,
          handler,
          resubscribeFactory,
          currentId         : subscriptionId,
          currentConnection : connection,
          currentClose      : close,
          closed            : false,
        };
        // The stable close facade: always closes the CURRENT transport
        // subscription and removes it from whatever map tracks it now, no
        // matter how many re-establishments happened since the caller got
        // this handle.
        const stableClose = async (): Promise<void> => {
          if (tracked.closed) {
            return;
          }
          tracked.closed = true;
          tracked.currentConnection.subscriptions.delete(tracked.currentId);
          try {
            await tracked.currentClose();
          } catch {
            // The transport already died with the subscription — closed is closed.
          }
        };
        tracked.subscription = { ...reply.subscription, close: stableClose };
      }

      tracked.currentId = subscriptionId;
      tracked.currentConnection = connection;
      tracked.currentClose = close;
      // Point this establishment's reply at the stable close so any holder of
      // it closes the logical subscription, not a stale transport id.
      reply.subscription.close = tracked.subscription.close;

      if (terminalSubscriptionError || tracked.closed) {
        // The subscription logically ended while this establishment was in
        // flight — tear the fresh server-side subscription down immediately.
        tracked.closed = true;
        Promise.resolve(close()).catch(() => {});
      } else {
        subscriptions.set(subscriptionId, tracked);
      }
    }

    return reply;
  }

  /**
   * Re-establishes one tracked subscription on `connection`, resuming from
   * its last known cursor. Uses the `resubscribeFactory` (if provided) to
   * construct a properly signed message with the cursor; falls back to the
   * original message for anonymous/unsigned subscriptions. The tracked entry
   * is REUSED — stable close handle and cursor watermark carry over — and the
   * handler is notified `reconnected` only after a verified success.
   *
   * @throws when the DWN reply is not a successful subscription (e.g. a 410
   *         progress gap) so the caller's failure handling can drive repair.
   */
  private static async resubscribeTracked(
    connection: SocketConnection,
    tracked: TrackedSubscription,
  ): Promise<void> {
    if (tracked.closed) {
      return;
    }

    let resumeMessage: GenericMessage;

    if (tracked.resubscribeFactory) {
      // Reconstruct and re-sign the message with the cursor.
      resumeMessage = await tracked.resubscribeFactory(tracked.lastCursor);
    } else {
      // No factory — reuse the original message as-is.
      // This only works for anonymous (unsigned) subscriptions.
      resumeMessage = tracked.message;
    }

    if (tracked.closed) {
      return;
    }

    const reply = await WebSocketDwnRpcClient.subscriptionRequest(
      connection,
      tracked.target,
      resumeMessage,
      tracked.handler,
      tracked.resubscribeFactory,
      tracked,
    ) as UnionMessageReply;

    // A non-success or subscription-less reply (e.g. 410 ProgressGap) is a
    // failed recovery — it must never masquerade as a reconnection.
    if (reply.status?.code !== 200 || reply.subscription === undefined) {
      throw new Error(
        `resubscription failed for ${tracked.target}: ${reply.status?.code} ${reply.status?.detail}`,
      );
    }

    if (tracked.closed) {
      // Closed while establishing — the fresh subscription was already torn
      // down; do not announce a reconnection.
      return;
    }

    // Notify the handler that reconnection is complete for this subscription.
    WebSocketDwnRpcClient.invokeHandler(tracked.handler, { type: 'reconnected' });
  }

  /**
   * Marks a subscription's recovery as terminally failed and tells its
   * consumer with a terminal `error` message carrying the last delivered
   * cursor, so higher layers can drive repair from a definitive signal
   * instead of a silent gap.
   */
  private static notifyRecoveryFailed(tracked: TrackedSubscription, error: unknown): void {
    if (tracked.closed) {
      return;
    }
    tracked.closed = true;

    const detail = error instanceof Error ? error.message : String(error);
    WebSocketDwnRpcClient.invokeHandler(tracked.handler, {
      type   : 'error',
      cursor : tracked.lastCursor,
      error  : {
        code   : 'SubscriptionRecoveryFailed',
        detail : `subscription could not be re-established: ${detail}`,
      },
    } as unknown as SubscriptionMessage);
  }

  /**
   * Moves every tracked subscription from a socket that lost the endpoint-
   * ownership race onto the winning connection, resuming each from its last
   * cursor. The losing map is drained synchronously so the loser's close
   * cannot double-notify the handlers adoption is re-establishing.
   */
  private static adoptSubscriptions(
    from: Map<string, TrackedSubscription>,
    winner: SocketConnection,
  ): void {
    const entries = [...from.values()];
    from.clear();

    for (const tracked of entries) {
      void WebSocketDwnRpcClient.resubscribeTracked(winner, tracked).catch((error: unknown): void => {
        WebSocketDwnRpcClient.notifyRecoveryFailed(tracked, error);
      });
    }
  }

  /**
   * Resubscribes all tracked subscriptions on a reconnected socket.
   */
  private static async resubscribeAll(connection: SocketConnection): Promise<void> {
    // Snapshot the current subscriptions — resubscription will re-populate the map.
    const entries = [...connection.subscriptions.entries()];
    connection.subscriptions.clear();

    for (const [, tracked] of entries) {
      try {
        await WebSocketDwnRpcClient.resubscribeTracked(connection, tracked);
      } catch (error: unknown) {
        // The connection may have lost endpoint ownership mid-resubscription —
        // hand the subscription to the current owner so it survives the race.
        const owner = WebSocketDwnRpcClient.connections.get(connectionCacheKey(new URL(connection.url)));
        if (owner !== undefined && owner !== connection) {
          try {
            await WebSocketDwnRpcClient.resubscribeTracked(owner, tracked);
            continue;
          } catch (ownerError: unknown) {
            WebSocketDwnRpcClient.notifyRecoveryFailed(tracked, ownerError);
            continue;
          }
        }
        // Recovery failed with no other owner to try — emit the terminal
        // signal so higher layers repair instead of silently losing events.
        WebSocketDwnRpcClient.notifyRecoveryFailed(tracked, error);
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
    const payloadBytes = estimatedJsonRpcPayloadBytes(request, encodedData?.length);
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

function estimatedJsonRpcPayloadBytes(request: ReturnType<typeof createJsonRpcRequest>, encodedDataLength: number | undefined): number {
  if (encodedDataLength === undefined) {
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
  return utf8ByteLength(JSON.stringify(requestWithoutData)) + encodedDataLength;
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

function replayableDataByteLength(data: DwnReplicationApplyRequest['data']): number | undefined {
  if (data === undefined) {
    return 0;
  }
  if (data instanceof Blob) {
    return data.size;
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  return undefined;
}

function toWireDwnMessage(message: DwnRpcRequest['message']): Partial<GenericMessage> {
  const candidate = message as { toJSON?: () => unknown };
  if (typeof candidate.toJSON === 'function') {
    return candidate.toJSON() as Partial<GenericMessage>;
  }
  return message as Partial<GenericMessage>;
}

function toWireReplicationApplyRequest(request: DwnReplicationApplyRequest): DwnReplicationApplyRequest {
  return { ...request, message: toWireDwnMessage(request.message) as GenericMessage };
}

function recordsWriteDataSize(message: DwnReplicationApplyRequest['message']): number | undefined {
  const descriptor = (message as { descriptor?: { interface?: unknown; method?: unknown; dataSize?: unknown } }).descriptor;
  return descriptor?.interface === 'Records' &&
    descriptor.method === 'Write' &&
    typeof descriptor.dataSize === 'number'
    ? descriptor.dataSize
    : undefined;
}
