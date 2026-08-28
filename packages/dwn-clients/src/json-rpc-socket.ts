import type { EnboxRpcNetworkTransport } from './network-transport.js';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';

import { CryptoUtils } from '@enbox/crypto';
import { SocketUnavailableError } from './dwn-rpc-error.js';
import { createJsonRpcSubscriptionRequest, JsonRpcErrorCodes, parseJson } from './json-rpc.js';

/**
 * Converts WebSocket message data to a string.
 * Bun's native WebSocket delivers `event.data` as an `ArrayBuffer`,
 * whereas Node.js `ws` delivers it as a `string`.
 */
function toText(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  // Buffer / Uint8Array fallback
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

// These were arbitrarily chosen, but can be modified via connect options
const CONNECT_TIMEOUT = 3_000;
const RESPONSE_TIMEOUT = 30_000;

/** Default reconnection settings. */
const DEFAULT_BASE_RECONNECT_DELAY = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = Infinity;

/** Default heartbeat settings. */
const DEFAULT_HEARTBEAT_INTERVAL = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT = 10_000;

/** Default deadline for an on-demand health probe pong. */
const DEFAULT_HEALTH_PROBE_TIMEOUT = 5_000;

export interface JsonRpcSocketOptions {
  /** socket connection timeout in milliseconds */
  connectTimeout?: number;
  /** response timeout for rpc requests in milliseconds */
  responseTimeout?: number;
  /** optional connection close handler */
  onclose?: () => void;
  /** optional socket error handler */
  onerror?: (error?: any) => void;

  /**
   * Whether to automatically reconnect on unexpected close.
   * Defaults to `true`. Set to `false` to disable auto-reconnect.
   */
  autoReconnect?: boolean;

  /** Base delay in ms for exponential backoff reconnection. Default 1000. */
  baseReconnectDelay?: number;

  /** Maximum delay in ms for exponential backoff reconnection. Default 30000. */
  maxReconnectDelay?: number;

  /** Maximum number of reconnection attempts. Default `Infinity`. */
  maxReconnectAttempts?: number;

  /** Called when a reconnection attempt is about to start. */
  onreconnecting?: (attempt: number) => void;

  /** Called when the socket has successfully reconnected. */
  onreconnected?: () => void;

  /**
   * Interval in ms between heartbeat pings. Set to `0` to disable.
   * Default 30000 (30s).
   */
  heartbeatInterval?: number;

  /**
   * How long in ms to wait for a pong before considering the connection dead.
   * Default 10000 (10s).
   */
  heartbeatTimeout?: number;

  /**
   * How long in ms an on-demand {@link JsonRpcSocket.checkHealth} probe waits
   * for a pong before force-closing the connection. Default 5000 (5s).
   */
  healthProbeTimeout?: number;
}

/**
 * JSON RPC Socket Client for WebSocket request/response and long-running subscriptions.
 *
 * Supports automatic reconnection with exponential backoff when the connection
 * drops unexpectedly. Subscription message handlers survive reconnection — they
 * are re-registered on the new underlying socket automatically.
 */
export class JsonRpcSocket {
  /**
   * Map of JSON-RPC id → message handler. For one-shot `request()` calls, the
   * handler is added before sending and removed on response or timeout.
   * For subscriptions, the handler lives until explicitly closed.
   */
  private readonly messageHandlers: Map<JsonRpcId, (event: { data: any }) => void> = new Map();

  /**
   * Set of JSON-RPC ids that belong to subscription handlers (as opposed to
   * one-shot request handlers). Subscription handlers survive reconnection;
   * one-shot handlers are rejected on unexpected close.
   */
  private readonly subscriptionHandlerIds: Set<JsonRpcId> = new Set();

  /** The URL to connect/reconnect to. */
  private readonly url: string;

  /** Stored options for reconnection. */
  private readonly options: JsonRpcSocketOptions;

  /** Whether `close()` was called intentionally by the user. */
  private closedByUser = false;

  /** Whether a reconnection attempt is currently in progress. */
  private reconnecting = false;

  /** Whether the socket is currently connected. */
  private _isConnected = false;

  /** Heartbeat interval timer. */
  private _heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  /** Heartbeat timeout timer — fires when a pong is not received in time. */
  private _heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;

  /** Whether a heartbeat pong is pending. */
  private _awaitingPong = false;

  /** Request id of the outstanding heartbeat ping — the active generation. */
  private _heartbeatPingId: JsonRpcId | undefined;

  /** In-flight on-demand health probe, deduplicating concurrent checks. */
  private _healthProbe: Promise<boolean> | undefined;

  /** Resolver that fast-forwards the pending reconnect backoff wait. */
  private _backoffWake: (() => void) | undefined;

  private constructor(
    private socket: WebSocket,
    private readonly responseTimeout: number,
    url: string,
    options: JsonRpcSocketOptions,
    private readonly createWebSocketFactory?: EnboxRpcNetworkTransport['createWebSocket'],
  ) {
    this.url = url;
    this.options = options;
    this._isConnected = true;
  }

  /** Whether the socket is currently connected. */
  public get isConnected(): boolean {
    return this._isConnected;
  }

  /** Whether {@link close} was called — a user-closed socket never reconnects. */
  public get isClosedByUser(): boolean {
    return this.closedByUser;
  }

  public static async connect(
    url: string,
    options: JsonRpcSocketOptions = {},
    createWebSocket?: EnboxRpcNetworkTransport['createWebSocket'],
  ): Promise<JsonRpcSocket> {
    const { connectTimeout = CONNECT_TIMEOUT, responseTimeout = RESPONSE_TIMEOUT } = options;

    let socket: WebSocket;
    try {
      socket = await JsonRpcSocket.createWebSocket(url, connectTimeout, createWebSocket);
    } catch (error) {
      // Notify the onerror handler if one was provided, even for connection-time errors.
      options.onerror?.(error);
      throw error;
    }

    const jsonRpcSocket = new JsonRpcSocket(socket, responseTimeout, url, options, createWebSocket);
    jsonRpcSocket.wireSocket(socket);
    jsonRpcSocket.startHeartbeat();

    return jsonRpcSocket;
  }

  /**
   * Closes the socket and stops reconnection attempts.
   */
  public close(): void {
    this.closedByUser = true;
    this._isConnected = false;
    this.stopHeartbeat();
    this._backoffWake?.();
    this.socket.close();
  }

  /**
   * Verifies the connection is actually alive right now.
   *
   * The periodic heartbeat rides on JS timers, which browsers throttle or
   * freeze in backgrounded tabs and across system sleep — a connection can be
   * dead for minutes before the next timer fires. Call this on wake signals
   * (tab became visible, browser back online) to force the verdict immediately:
   *
   * - Connected: sends an out-of-band `rpc.ping` with a short deadline. A pong
   *   resolves `true`; a miss force-closes the socket, which triggers the
   *   normal auto-reconnect (and resubscription) path, and resolves `false`.
   * - Reconnecting: fast-forwards the pending backoff wait so the next attempt
   *   starts now instead of after a (possibly throttled) delay.
   * - Disconnected with auto-reconnect enabled: starts a fresh reconnect loop.
   */
  public async checkHealth(): Promise<boolean> {
    if (this.closedByUser) {
      return false;
    }

    if (!this._isConnected) {
      if (this.reconnecting) {
        this._backoffWake?.();
      } else if (this.options.autoReconnect ?? true) {
        this.attemptReconnect();
      }
      return false;
    }

    this._healthProbe ??= this.probeConnection().finally((): void => {
      this._healthProbe = undefined;
    });
    return this._healthProbe;
  }

  /**
   * Sends a JSON-RPC request through the socket and waits for a single response.
   *
   * Rejects with {@link SocketUnavailableError} when the socket is not
   * connected. The typed pre-transmission boundary lets an explicit WebSocket
   * caller retry without implying any transport fallback policy.
   */
  public async request(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this._isConnected) {
      throw new SocketUnavailableError('JsonRpcSocket: request refused — socket is not connected');
    }

    return new Promise((resolve, reject) => {
      request.id ??= CryptoUtils.randomUuid();
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(request.id!);
        reject(new Error('request timed out'));
      }, this.responseTimeout);

      const handleResponse = (event: { data: any }):void => {
        const jsonRpsResponse = parseJson(toText(event.data)) as JsonRpcResponse;
        if (jsonRpsResponse.id === request.id) {
          // if the incoming response id matches the request id, we will remove the listener and resolve the response
          this.messageHandlers.delete(request.id);
          clearTimeout(timeout);
          return resolve(jsonRpsResponse);
        }
      };

      // add the listener to the map of message handlers
      this.messageHandlers.set(request.id!, handleResponse);
      this.send(request);
    });
  }

  /**
   * Sends a JSON-RPC request through the socket and keeps a listener open to read associated responses as they arrive.
   * Returns a close method to clean up the listener.
   */
  public async subscribe(request: JsonRpcRequest, listener: (response: JsonRpcResponse) => void): Promise<{
    response: JsonRpcResponse;
    close?: () => Promise<void>;
   }> {

    if (!request.method.startsWith('rpc.subscribe.')) {
      throw new Error('subscribe rpc requests must include the `rpc.subscribe` prefix');
    }

    if (!request.subscription) {
      throw new Error('subscribe rpc requests must include subscribe options');
    }

    const subscriptionId = request.subscription.id;

    // Preserve any existing handler for this subscriptionId so that a rejected
    // duplicate-subscribe attempt does not clobber an active subscription.
    const existingHandler = this.messageHandlers.get(subscriptionId);

    const socketEventListener = (event: { data: any }):void => {
      const jsonRpcResponse = parseJson(toText(event.data)) as JsonRpcResponse;
      if (jsonRpcResponse.id === subscriptionId) {
        if (jsonRpcResponse.error !== undefined) {
          // remove the event listener upon receipt of a JSON RPC Error.
          this.messageHandlers.delete(subscriptionId);
          this.subscriptionHandlerIds.delete(subscriptionId);
          this.closeSubscription(subscriptionId).catch(() => {
            // swallow timeout errors; the subscription is already cleaned up locally.
          });
        }
        listener(jsonRpcResponse);
      }
    };

    this.messageHandlers.set(subscriptionId, socketEventListener);
    this.subscriptionHandlerIds.add(subscriptionId);

    const response = await this.request(request);
    if (response.error) {
      // Restore the previous handler if one existed, otherwise clean up.
      if (existingHandler) {
        this.messageHandlers.set(subscriptionId, existingHandler);
      } else {
        this.messageHandlers.delete(subscriptionId);
        this.subscriptionHandlerIds.delete(subscriptionId);
      }
      return { response };
    }

    // clean up listener and create a `rpc.subscribe.close` message to use when closing this JSON RPC subscription
    const close = async (): Promise<void> => {
      this.messageHandlers.delete(subscriptionId);
      this.subscriptionHandlerIds.delete(subscriptionId);
      await this.closeSubscription(subscriptionId);
    };

    return {
      response,
      close
    };
  }

  private closeSubscription(id: JsonRpcId): Promise<JsonRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.close', {}, id);
    return this.request(request);
  }

  /**
   * Sends a JSON-RPC request through the socket. You must subscribe to a message listener separately to capture the response.
   */
  public send(request: JsonRpcRequest):void {
    this.socket.send(JSON.stringify(request));
  }

  // ---------------------------------------------------------------------------
  // Internal: socket wiring and reconnection
  // ---------------------------------------------------------------------------

  /**
   * Creates and connects a raw WebSocket, resolving when `open` fires.
   */
  private static createWebSocket(
    url: string,
    connectTimeout: number,
    createWebSocket?: EnboxRpcNetworkTransport['createWebSocket'],
  ): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket | undefined;

      const onOpen = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(ws!);
      };

      const onError = (error: any): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        settled = true;
        cleanup();
        ws?.close();
        reject(new Error('connect timed out'));
      }, connectTimeout);

      const cleanup = (): void => {
        clearTimeout(timer);
        ws?.removeEventListener('open', onOpen);
        ws?.removeEventListener('error', onError);
      };

      const socketFactory = createWebSocket ?? (async (socketUrl: string): Promise<WebSocket> => {
        return new globalThis.WebSocket(socketUrl);
      });
      Promise.resolve()
        .then((): Promise<WebSocket> => socketFactory(url))
        .then((createdSocket): void => {
          if (settled) {
            try { createdSocket.close(); } catch { /* best effort */ }
            return;
          }

          ws = createdSocket;
          ws.addEventListener('open', onOpen);
          ws.addEventListener('error', onError);

          if (ws.readyState === 1) {
            onOpen();
          } else if (ws.readyState >= 2) {
            onError(new Error('WebSocket closed before connecting'));
          }
        })
        .catch(onError);
    });
  }

  /**
   * Wires the `onmessage`, `onclose`, and `onerror` handlers for a given
   * WebSocket instance. Called both on initial connect and on reconnect.
   */
  private wireSocket(ws: WebSocket): void {
    ws.addEventListener('message', (event: { data: any }) => {
      const jsonRpcResponse = parseJson(toText(event.data)) as JsonRpcResponse;
      if (jsonRpcResponse === null) {
        return;
      }
      const handler = this.messageHandlers.get(jsonRpcResponse.id);
      if (handler) {
        handler(event);
      }
    });

    ws.addEventListener('close', () => {
      this._isConnected = false;
      this.stopHeartbeat();

      // Reject all pending one-shot request handlers (non-subscription).
      // A pending request can never complete on a closed socket, so this
      // applies to user closes too — callers fail fast instead of hanging
      // until the response timeout.
      this.rejectPendingRequests();

      if (this.closedByUser) {
        this.options.onclose?.();
        return;
      }

      // Notify the user handler if present.
      this.options.onclose?.();

      // Attempt reconnection if enabled.
      const autoReconnect = this.options.autoReconnect ?? true;
      if (autoReconnect && !this.reconnecting) {
        this.attemptReconnect();
      }
    });

    ws.addEventListener('error', (error: any) => {
      this.options.onerror?.(error);
    });
  }

  /**
   * Rejects all pending one-shot request handlers (those not in `subscriptionHandlerIds`)
   * by synthesizing a transport error event.
   */
  private rejectPendingRequests(): void {
    for (const [id, handler] of this.messageHandlers) {
      if (!this.subscriptionHandlerIds.has(id)) {
        // Synthesize an error response to reject the pending promise.
        const errorData = JSON.stringify({
          jsonrpc : '2.0',
          id,
          error   : { code: JsonRpcErrorCodes.TransportError, message: 'WebSocket connection closed unexpectedly' },
        });
        handler({ data: errorData });
        this.messageHandlers.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: application-level heartbeat (ping/pong)
  // ---------------------------------------------------------------------------

  /**
   * Starts the heartbeat interval. Sends a JSON-RPC `rpc.ping` every
   * `heartbeatInterval` ms. If no `rpc.pong` response arrives within
   * `heartbeatTimeout` ms, the socket is considered dead and closed
   * (which triggers reconnection via the `close` handler).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    const interval = this.options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    if (interval <= 0) { return; }

    const timeout = this.options.heartbeatTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT;

    this._heartbeatInterval = setInterval(() => {
      if (!this._isConnected || this._awaitingPong) { return; }

      this._awaitingPong = true;

      // Send a lightweight JSON-RPC request as the ping. The id doubles as
      // the heartbeat generation: only the pong for the ACTIVE ping may
      // mutate heartbeat state, so a late pong from a superseded ping (one a
      // health probe cleared) cannot defuse a newer ping's deadline.
      const pingId = `hb-${CryptoUtils.randomUuid()}`;
      this._heartbeatPingId = pingId;
      const pingRequest: JsonRpcRequest = {
        jsonrpc : '2.0',
        id      : pingId,
        method  : 'rpc.ping',
      };

      // Register a one-shot handler for the pong response.
      this.messageHandlers.set(pingId, () => {
        this.messageHandlers.delete(pingId);
        if (this._heartbeatPingId !== pingId) {
          return;
        }
        this._heartbeatPingId = undefined;
        this._awaitingPong = false;
        if (this._heartbeatTimeout) {
          clearTimeout(this._heartbeatTimeout);
          this._heartbeatTimeout = undefined;
        }
      });

      try {
        this.send(pingRequest);
      } catch {
        // Socket may already be closing — the close handler will deal with it.
        this.messageHandlers.delete(pingId);
        this._heartbeatPingId = undefined;
        this._awaitingPong = false;
        return;
      }

      // If the pong doesn't arrive in time, force-close and reconnect.
      this._heartbeatTimeout = setTimeout(() => {
        this._heartbeatTimeout = undefined;
        this.messageHandlers.delete(pingId);
        this._heartbeatPingId = undefined;
        this._awaitingPong = false;

        if (!this.closedByUser && this._isConnected) {
          console.warn('JsonRpcSocket: heartbeat timeout — closing dead connection');
          this._isConnected = false;
          try { this.socket.close(); } catch { /* best effort */ }
        }
      }, timeout);
    }, interval);
  }

  /** Stops the heartbeat timer and clears any pending timeout. */
  private stopHeartbeat(): void {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = undefined;
    }
    this.clearHeartbeatDeadline();
  }

  /**
   * Clears a pending heartbeat pong deadline without stopping the interval.
   *
   * Also called when an on-demand health probe proves liveness: a deadline
   * armed before a tab was frozen may otherwise fire on resume and kill a
   * connection the probe just verified. The superseded ping's pong handler
   * is removed with it — a late pong for a cleared ping must never mutate a
   * newer heartbeat's state, and superseded handlers must not accumulate
   * across wake cycles.
   */
  private clearHeartbeatDeadline(): void {
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
      this._heartbeatTimeout = undefined;
    }
    if (this._heartbeatPingId !== undefined) {
      this.messageHandlers.delete(this._heartbeatPingId);
      this._heartbeatPingId = undefined;
    }
    this._awaitingPong = false;
  }

  /**
   * Sends one out-of-band `rpc.ping` and resolves whether a pong arrived
   * within the probe deadline. A miss (or send failure) force-closes the
   * socket so the auto-reconnect path takes over.
   */
  private probeConnection(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const probeId = `hb-probe-${CryptoUtils.randomUuid()}`;
      const probeTimeout = this.options.healthProbeTimeout ?? DEFAULT_HEALTH_PROBE_TIMEOUT;

      const forceClose = (): void => {
        if (!this.closedByUser && this._isConnected) {
          console.warn('JsonRpcSocket: health probe failed — closing dead connection');
          this._isConnected = false;
          try { this.socket.close(); } catch { /* best effort */ }
        }
      };

      const timeout = setTimeout((): void => {
        this.messageHandlers.delete(probeId);
        forceClose();
        resolve(false);
      }, probeTimeout);

      this.messageHandlers.set(probeId, (event: { data: any }): void => {
        clearTimeout(timeout);
        this.messageHandlers.delete(probeId);

        // A close while the probe was pending synthesizes a transport-error
        // response for every one-shot handler — that is not a pong.
        const response = parseJson(toText(event.data)) as JsonRpcResponse | null;
        if (response?.error !== undefined) {
          resolve(false);
          return;
        }

        this.clearHeartbeatDeadline();
        resolve(true);
      });

      try {
        this.send({ jsonrpc: '2.0', id: probeId, method: 'rpc.ping' });
      } catch {
        clearTimeout(timeout);
        this.messageHandlers.delete(probeId);
        forceClose();
        resolve(false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: reconnection
  // ---------------------------------------------------------------------------

  /**
   * Waits for the given backoff delay, resolving early when
   * {@link checkHealth} fast-forwards a wake signal into the loop.
   */
  private waitForBackoff(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout((): void => {
        this._backoffWake = undefined;
        resolve();
      }, delayMs);
      this._backoffWake = (): void => {
        clearTimeout(timer);
        this._backoffWake = undefined;
        resolve();
      };
    });
  }

  /**
   * Exponential backoff reconnection loop with jitter.
   */
  private attemptReconnect(): void {
    this.reconnecting = true;

    const baseDelay = this.options.baseReconnectDelay ?? DEFAULT_BASE_RECONNECT_DELAY;
    const maxDelay = this.options.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY;
    const maxAttempts = this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const connectTimeout = this.options.connectTimeout ?? CONNECT_TIMEOUT;

    let attempt = 0;

    const tryReconnect = async (): Promise<void> => {
      if (this.closedByUser) {
        this.reconnecting = false;
        return;
      }

      attempt++;

      if (attempt > maxAttempts) {
        this.reconnecting = false;
        return;
      }

      this.options.onreconnecting?.(attempt);

      // Exponential backoff with jitter: delay = min(baseDelay * 2^(attempt-1), maxDelay) * (0.5 + random*0.5)
      const expDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const halfExpDelay = Math.floor(expDelay / 2);
      const jitteredDelay = halfExpDelay + (crypto.getRandomValues(new Uint32Array(1))[0] % (halfExpDelay || 1));

      await this.waitForBackoff(jitteredDelay);

      if (this.closedByUser) {
        this.reconnecting = false;
        return;
      }

      try {
        const newSocket = await JsonRpcSocket.createWebSocket(this.url, connectTimeout, this.createWebSocketFactory);

        // close() may have raced the connection establishment. A user-closed
        // socket must stay closed: discard the fresh WebSocket without
        // assigning it, wiring handlers, restarting the heartbeat, or
        // announcing a reconnection.
        if (this.closedByUser) {
          this.reconnecting = false;
          try { newSocket.close(); } catch { /* best effort */ }
          return;
        }

        this.socket = newSocket;
        this._isConnected = true;
        this.reconnecting = false;
        this.wireSocket(newSocket);
        this.startHeartbeat();
        this.options.onreconnected?.();
      } catch {
        // Connection failed — retry.
        await tryReconnect();
      }
    };

    tryReconnect();
  }
}
