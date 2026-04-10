import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';

import { CryptoUtils } from '@enbox/crypto';
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

  private constructor(
    private socket: WebSocket,
    private readonly responseTimeout: number,
    url: string,
    options: JsonRpcSocketOptions,
  ) {
    this.url = url;
    this.options = options;
    this._isConnected = true;
  }

  /** Whether the socket is currently connected. */
  public get isConnected(): boolean {
    return this._isConnected;
  }

  public static async connect(url: string, options: JsonRpcSocketOptions = {}): Promise<JsonRpcSocket> {
    const { connectTimeout = CONNECT_TIMEOUT, responseTimeout = RESPONSE_TIMEOUT } = options;

    let socket: WebSocket;
    try {
      socket = await JsonRpcSocket.createWebSocket(url, connectTimeout);
    } catch (error) {
      // Notify the onerror handler if one was provided, even for connection-time errors.
      options.onerror?.(error);
      throw error;
    }

    const jsonRpcSocket = new JsonRpcSocket(socket, responseTimeout, url, options);
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
    this.socket.close();
  }

  /**
   * Sends a JSON-RPC request through the socket and waits for a single response.
   */
  public async request(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      request.id ??= CryptoUtils.randomUuid();

      const handleResponse = (event: { data: any }):void => {
        const jsonRpsResponse = parseJson(toText(event.data)) as JsonRpcResponse;
        if (jsonRpsResponse.id === request.id) {
          // if the incoming response id matches the request id, we will remove the listener and resolve the response
          this.messageHandlers.delete(request.id);
          return resolve(jsonRpsResponse);
        }
      };

      // add the listener to the map of message handlers
      this.messageHandlers.set(request.id!, handleResponse);
      this.send(request);

      // reject this promise if we don't receive any response back within the timeout period
      setTimeout(() => {
        this.messageHandlers.delete(request.id!);
        reject(new Error('request timed out'));
      }, this.responseTimeout);
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
  private static createWebSocket(url: string, connectTimeout: number): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);

      const onOpen = (): void => {
        cleanup();
        resolve(ws);
      };

      const onError = (error: any): void => {
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        cleanup();
        ws.close();
        reject(new Error('connect timed out'));
      }, connectTimeout);

      const cleanup = (): void => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
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

      if (this.closedByUser) {
        this.options.onclose?.();
        return;
      }

      // Reject all pending one-shot request handlers (non-subscription).
      this.rejectPendingRequests();

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

      // Send a lightweight JSON-RPC request as the ping.
      const pingId = `hb-${Date.now()}`;
      const pingRequest: JsonRpcRequest = {
        jsonrpc : '2.0',
        id      : pingId,
        method  : 'rpc.ping',
      };

      // Register a one-shot handler for the pong response.
      this.messageHandlers.set(pingId, () => {
        this._awaitingPong = false;
        this.messageHandlers.delete(pingId);
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
        this._awaitingPong = false;
        return;
      }

      // If the pong doesn't arrive in time, force-close and reconnect.
      this._heartbeatTimeout = setTimeout(() => {
        this._heartbeatTimeout = undefined;
        this.messageHandlers.delete(pingId);
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
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
      this._heartbeatTimeout = undefined;
    }
    this._awaitingPong = false;
  }

  // ---------------------------------------------------------------------------
  // Internal: reconnection
  // ---------------------------------------------------------------------------

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
      const jitteredDelay = expDelay * (0.5 + Math.random() * 0.5);

      await new Promise(resolve => setTimeout(resolve, jitteredDelay));

      if (this.closedByUser) {
        this.reconnecting = false;
        return;
      }

      try {
        const newSocket = await JsonRpcSocket.createWebSocket(this.url, connectTimeout);
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
