import type { ActivityLog } from '../admin/activity-log.js';
import type { AdminConnectionSnapshot } from '../admin/types.js';
import type { AdminStore } from '../admin/admin-store.js';
import type { DwnServerConfig } from '../config.js';
import type { MessageProcessedHook } from '../message-processed-hook.js';
import type { RateLimiter } from '../rate-limiter.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { RequestContext } from '../lib/json-rpc-router.js';
import type { ServerWebSocket } from 'bun';
import type { WsData } from '../http-api.js';
import type { Dwn, GenericMessage, ProgressToken, SubscriptionListener } from '@enbox/dwn-sdk-js';
import type { JsonRpcErrorResponse, JsonRpcId, JsonRpcRequest, JsonRpcResponse, JsonRpcSubscription } from '@enbox/dwn-clients';

import log from 'loglevel';

import { DwnMethodName } from '@enbox/dwn-sdk-js';
import { jsonRpcRouter } from '../json-rpc-api.js';
import { requestCounter } from '../metrics.js';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DEFAULT_MAX_IN_FLIGHT, FlowController } from './flow-controller.js';
import { DwnServerError, DwnServerErrorCode } from '../dwn-error.js';

const HEARTBEAT_INTERVAL = 30_000;

/** Local ownership of a pending subscription; never serialized into JSON-RPC. */
export type SocketSubscription = {
  subscriptionHandler: SubscriptionListener;
  signal: AbortSignal;
  register: (close: JsonRpcSubscription['close']) => Promise<void>;
  release: () => Promise<void>;
};

type ConnectionSubscription = {
  id: JsonRpcId;
  abortController: AbortController;
  flowController: FlowController;
  close?: JsonRpcSubscription['close'];
  closePromise?: Promise<void>;
};

/**
 * SocketConnection handles a WebSocket connection to a DWN using JSON RPC.
 * It also manages references to the long running RPC subscriptions for the connection.
 *
 * With Bun's native WebSocket, the message/close/error events are dispatched by the
 * Bun.serve() websocket handlers in http-api.ts, which delegate to the public `message()`
 * and `close()` methods on this class.
 */
export class SocketConnection {
  /** Unique identifier for this connection (for admin introspection). */
  public readonly id: string = crypto.randomUUID();

  /** Timestamp when the connection was established (for admin introspection). */
  public readonly connectedAt: number = Date.now();

  private readonly heartbeatInterval: ReturnType<typeof setInterval>;
  private readonly subscriptions: Map<JsonRpcId, ConnectionSubscription> = new Map();
  private isAlive: boolean = true;
  private isClosed: boolean = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly socket: ServerWebSocket<WsData>,
    private readonly dwn: Dwn,
    private readonly onCloseCallback?: () => void,
    private readonly maxInFlight: number = DEFAULT_MAX_IN_FLIGHT,
    private readonly activityLog?: ActivityLog,
    private readonly adminStore?: AdminStore,
    private readonly registrationStore?: RegistrationStore,
    private readonly serverConfig?: DwnServerConfig,
    private readonly tenantRateLimiter?: RateLimiter,
    private readonly messageProcessedHooks?: MessageProcessedHook[],
  ){
    // Bun answers peer pings automatically at the protocol level; this loop
    // originates our own protocol pings so dead peers are detected even when
    // the peer's application-level timers are throttled or frozen.
    this.heartbeatInterval = setInterval(() => {
      if (this.isAlive === false) {
        // A dead peer cannot complete a close handshake — tear the socket
        // down immediately so its resources and NAT/proxy entries free up,
        // then release subscriptions and flow controllers.
        try {
          this.socket.terminate();
        } catch { /* best effort */ }
        void this.close();
        return;
      }
      this.isAlive = false;
      this.socket.ping();
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Called when a pong is received (triggered by Bun's built-in ping/pong handling).
   */
  pong(): void {
    this.isAlive = true;
  }

  /**
   * Checks to see if the incoming `JsonRpcId` is already in use for a subscription.
   */
  hasSubscription(id: JsonRpcId): boolean {
    return this.subscriptions.has(id);
  }

  /**
   * Reserves an id before asynchronous validation or replay, keeping pending
   * and active subscriptions under the same cancellation and flow control.
   */
  public beginSubscription(id: JsonRpcId): SocketSubscription {
    if (this.isClosed) {
      throw new DwnServerError(DwnServerErrorCode.ConnectionClosed, 'cannot open a subscription on a closed connection');
    }
    if (this.subscriptions.has(id)) {
      throw new DwnServerError(
        DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdExists,
        `the subscription with id ${id} already exists`
      );
    }

    const abortController = new AbortController();
    const flowController = new FlowController(
      id,
      this.maxInFlight,
      (response): void => this.send(response),
      (): void => {
        void this.closeOwnedSubscription(subscription).catch((error): void => {
          log.error(`FlowController: error closing subscription ${String(id)} on overflow`, error);
        });
      },
    );
    const subscription: ConnectionSubscription = { id, abortController, flowController };
    this.subscriptions.set(id, subscription);

    return {
      signal              : abortController.signal,
      subscriptionHandler : (message): void | Promise<void> => flowController.push(message),
      register            : async (close): Promise<void> => {
        if (abortController.signal.aborted) {
          await close();
          abortController.signal.throwIfAborted();
        }
        subscription.close = close;
      },
      // Failed or rejected opens relinquish only their own lifetime.
      release: (): Promise<void> => this.closeOwnedSubscription(subscription),
    };
  }

  /**
   * Closes and removes the reference for a given subscription from this connection.
   *
   * @param id the `JsonRpcId` of the JSON RPC subscription request.
   */
  async closeSubscription(id: JsonRpcId): Promise<void> {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined) {
      throw new DwnServerError(
        DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdNotFound,
        `the subscription with id ${id} was not found`
      );
    }

    await this.closeOwnedSubscription(subscription);
  }

  private closeOwnedSubscription(subscription: ConnectionSubscription, reason?: Error): Promise<void> {
    if (subscription.closePromise !== undefined) {
      return subscription.closePromise;
    }
    subscription.flowController.close();
    // Publish cleanup before synchronous abort listeners can re-enter it.
    const closePromise = Promise.resolve().then(async (): Promise<void> => {
      await subscription.close?.();
    }).finally((): void => {
      // Reuse the id only after cleanup settles, including a failed close.
      if (this.subscriptions.get(subscription.id) === subscription) {
        this.subscriptions.delete(subscription.id);
      }
    });
    subscription.closePromise = closePromise;
    subscription.abortController.abort(reason ?? new DwnServerError(
      DwnServerErrorCode.ConnectionSubscriptionClosed, `subscription ${String(subscription.id)} closed`
    ));
    return closePromise;
  }

  /**
   * Acknowledges subscription events up to the given progress token, advancing
   * the flow-control window for the subscription.
   */
  ackSubscription(id: JsonRpcId, cursor: ProgressToken): void {
    const fc = this.subscriptions.get(id)?.flowController;
    if (fc) {
      fc.ack(cursor);
    }
  }

  /**
   * Closes the existing connection and cleans up any listeners or subscriptions.
   */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.isClosed = true;
    clearInterval(this.heartbeatInterval);
    // Publish ownership before abort dispatch can re-enter close().
    this.closePromise = Promise.resolve().then((): Promise<void> => this.closeConnection());
    const reason = new DwnServerError(DwnServerErrorCode.ConnectionClosed, 'socket connection closed');
    for (const subscription of this.subscriptions.values()) {
      void this.closeOwnedSubscription(subscription, reason);
    }
    return this.closePromise;
  }

  private async closeConnection(): Promise<void> {
    // Include unsubscribes already in progress, and finish all cleanup even if one fails.
    const results = await Promise.allSettled(Array.from(this.subscriptions.values(),
      (subscription): Promise<void> => this.closeOwnedSubscription(subscription)));

    // close the socket.
    this.socket.close();

    // if there was a close handler passed call it after the connection has been closed
    if (this.onCloseCallback !== undefined) {
      this.onCloseCallback();
    }
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  /**
   * Log the error and close the connection.
   */
  async error(error: Error): Promise<void> {
    log.error(`SocketConnection error, terminating connection`, error);
    this.socket.close();
    await this.close();
  }

  /**
   * Handles a `JSON RPC 2.0` encoded message.
   * This is called by Bun's websocket message handler via http-api.ts.
   */
  async message(dataBuffer: Buffer): Promise<void> {
    if (this.isClosed) {
      return;
    }
    const requestData = dataBuffer.toString();
    if (!requestData) {
      return this.send(createJsonRpcErrorResponse(
        crypto.randomUUID(),
        JsonRpcErrorCodes.BadRequest,
        'request payload required.'
      ));
    }

    let jsonRequest: JsonRpcRequest;
    try {
      jsonRequest = JSON.parse(requestData);
    } catch (error) {
      const errorResponse = createJsonRpcErrorResponse(
        crypto.randomUUID(),
        JsonRpcErrorCodes.BadRequest,
        (error as Error).message
      );
      return this.send(errorResponse);
    }

    const requestContext = await this.buildRequestContext(jsonRequest);
    const { jsonRpcResponse } = await jsonRpcRouter.handle(jsonRequest, requestContext);
    if (jsonRpcResponse.error) {
      requestCounter.inc({ method: jsonRequest.method, error: 1 });
    } else {
      requestCounter.inc({
        method : jsonRequest.method,
        status : jsonRpcResponse?.result?.reply?.status?.code || 0,
      });
    }
    this.send(jsonRpcResponse);
  }

  /**
   * Returns the number of active subscriptions on this connection.
   */
  get subscriptionCount(): number {
    return Array.from(this.subscriptions.values()).filter(subscription => subscription.close !== undefined).length;
  }

  /**
   * Returns a serializable snapshot of this connection for the admin inspector.
   */
  toSnapshot(): AdminConnectionSnapshot {
    const subscriptions = Array.from(this.subscriptions.values()).map(
      (subscription): AdminConnectionSnapshot['subscriptions'][number] => ({
        id       : subscription.id as string | number,
        inflight : subscription.flowController.inFlightCount,
        buffered : subscription.flowController.bufferCount,
      }),
    );

    return {
      id                : this.id,
      connectedAt       : new Date(this.connectedAt).toISOString(),
      subscriptionCount : this.subscriptionCount,
      subscriptions,
    };
  }

  /**
   * Sends a JSON encoded string through the WebSocket.
   */
  private send(response: JsonRpcResponse | JsonRpcErrorResponse): void {
    if (!this.isClosed) {
      this.socket.send(JSON.stringify(response));
    }
  }

  /**
   * Builds a `RequestContext` object to use with the `JSON RPC API`.
   */
  private async buildRequestContext(request: JsonRpcRequest): Promise<RequestContext> {
    const { params, method, subscription } = request;

    const requestContext: RequestContext = {
      transport             : 'ws',
      dwn                   : this.dwn,
      socketConnection      : this,
      activityLog           : this.activityLog,
      adminStore            : this.adminStore,
      registrationStore     : this.registrationStore,
      config                : this.serverConfig,
      tenantRateLimiter     : this.tenantRateLimiter,
      messageProcessedHooks : this.messageProcessedHooks,
    };

    // methods that expect a long-running subscription begin with `rpc.subscribe.`
    if (method === 'rpc.subscribe.dwn.processMessage' && subscription) {
      const message = (params as { message?: GenericMessage } | undefined)?.message;
      if (message?.descriptor?.method === DwnMethodName.Subscribe) {
        requestContext.subscriptionRequest = {
          id: subscription.id,
        };
      }
    }

    return requestContext;
  }
}
