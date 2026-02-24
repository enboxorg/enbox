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
import type { Dwn, GenericMessage, SubscriptionMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcErrorResponse, JsonRpcId, JsonRpcRequest, JsonRpcResponse, JsonRpcSubscription } from '@enbox/dwn-clients';

import log from 'loglevel';

import { DwnMethodName } from '@enbox/dwn-sdk-js';
import { jsonRpcRouter } from '../json-rpc-api.js';
import { requestCounter } from '../metrics.js';
import { v4 as uuidv4 } from 'uuid';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DEFAULT_MAX_IN_FLIGHT, FlowController } from './flow-controller.js';
import { DwnServerError, DwnServerErrorCode } from '../dwn-error.js';

const HEARTBEAT_INTERVAL = 30_000;

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
  public readonly id: string = uuidv4();

  /** Timestamp when the connection was established (for admin introspection). */
  public readonly connectedAt: number = Date.now();

  private heartbeatInterval: ReturnType<typeof setInterval>;
  private subscriptions: Map<JsonRpcId, JsonRpcSubscription> = new Map();
  private flowControllers: Map<JsonRpcId, FlowController> = new Map();
  private isAlive: boolean;

  constructor(
    private socket: ServerWebSocket<WsData>,
    private dwn: Dwn,
    private onCloseCallback?: () => void,
    private maxInFlight: number = DEFAULT_MAX_IN_FLIGHT,
    private activityLog?: ActivityLog,
    private adminStore?: AdminStore,
    private registrationStore?: RegistrationStore,
    private serverConfig?: DwnServerConfig,
    private tenantRateLimiter?: RateLimiter,
    private messageProcessedHooks?: MessageProcessedHook[],
  ){
    // Bun handles ping/pong automatically at the protocol level, but we still
    // want an application-level heartbeat to detect dead connections.
    this.isAlive = true;
    this.heartbeatInterval = setInterval(() => {
      if (this.isAlive === false) {
        this.close();
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
   * Adds a reference for the JSON RPC Subscription to this connection.
   * Used for cleanup if the connection is closed.
   */
  async addSubscription(subscription: JsonRpcSubscription): Promise<void> {
    if (this.subscriptions.has(subscription.id)) {
      throw new DwnServerError(
        DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdExists,
        `the subscription with id ${subscription.id} already exists`
      );
    }

    this.subscriptions.set(subscription.id, subscription);
  }

  /**
   * Closes and removes the reference for a given subscription from this connection.
   *
   * @param id the `JsonRpcId` of the JSON RPC subscription request.
   */
  async closeSubscription(id: JsonRpcId): Promise<void> {
    if (!this.subscriptions.has(id)) {
      throw new DwnServerError(
        DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdNotFound,
        `the subscription with id ${id} was not found`
      );
    }

    const connection = this.subscriptions.get(id);
    await connection.close();
    this.subscriptions.delete(id);
    this.flowControllers.delete(id);
  }

  /**
   * Acknowledges subscription events up to the given cursor, advancing the
   * flow-control window for the subscription.
   */
  ackSubscription(id: JsonRpcId, cursor: string): void {
    const fc = this.flowControllers.get(id);
    if (fc) {
      fc.ack(cursor);
    }
  }

  /**
   * Closes the existing connection and cleans up any listeners or subscriptions.
   */
  async close(): Promise<void> {
    clearInterval(this.heartbeatInterval);

    const closePromises: Promise<void>[] = [];
    for (const [id, subscription] of this.subscriptions) {
      closePromises.push(subscription.close());
      this.subscriptions.delete(id);
    }

    // close all of the associated subscriptions
    await Promise.all(closePromises);

    // clear all flow controllers
    this.flowControllers.clear();

    // close the socket.
    this.socket.close();

    // if there was a close handler passed call it after the connection has been closed
    if (this.onCloseCallback !== undefined) {
      this.onCloseCallback();
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
    const requestData = dataBuffer.toString();
    if (!requestData) {
      return this.send(createJsonRpcErrorResponse(
        uuidv4(),
        JsonRpcErrorCodes.BadRequest,
        'request payload required.'
      ));
    }

    let jsonRequest: JsonRpcRequest;
    try {
      jsonRequest = JSON.parse(requestData);
    } catch (error) {
      const errorResponse = createJsonRpcErrorResponse(
        uuidv4(),
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
    return this.subscriptions.size;
  }

  /**
   * Returns a serializable snapshot of this connection for the admin inspector.
   */
  toSnapshot(): AdminConnectionSnapshot {
    const subscriptions = Array.from(this.flowControllers.entries()).map(
      ([id, fc]): AdminConnectionSnapshot['subscriptions'][number] => ({
        id       : id as string | number,
        inflight : fc.inFlightCount,
        buffered : fc.bufferCount,
      }),
    );

    return {
      id                : this.id,
      connectedAt       : new Date(this.connectedAt).toISOString(),
      subscriptionCount : this.subscriptions.size,
      subscriptions,
    };
  }

  /**
   * Sends a JSON encoded string through the WebSocket.
   */
  private send(response: JsonRpcResponse | JsonRpcErrorResponse): void {
    this.socket.send(JSON.stringify(response));
  }

  /**
   * Creates a flow-controlled subscription handler that enforces the
   * `maxInFlight` window. Returns a `SubscriptionListener` to be passed
   * to the EventLog, and stores the `FlowController` for later `rpc.ack`
   * processing.
   */
  private createSubscriptionHandler(id: JsonRpcId): (message: SubscriptionMessage) => void {
    const fc = new FlowController(
      id,
      this.maxInFlight,
      (response) => {
        this.send(response);
      },
      () => {
        // overflow: close the subscription to prevent OOM
        this.closeSubscription(id).catch((err) => {
          log.error(`FlowController: error closing subscription ${String(id)} on overflow`, err);
        });
      },
    );

    this.flowControllers.set(id, fc);

    return (message) => {
      fc.push(message);
    };
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
    if (method.startsWith('rpc.subscribe.') && subscription) {
      const { message } = params as { message?: GenericMessage };
      if (message?.descriptor.method === DwnMethodName.Subscribe) {
        requestContext.subscriptionRequest = {
          id                  : subscription.id,
          subscriptionHandler : this.createSubscriptionHandler(subscription.id),
        };
      }
    }

    return requestContext;
  }
}
