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
import type { Dwn, GenericMessage, ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcErrorResponse, JsonRpcId, JsonRpcRequest, JsonRpcResponse } from '@enbox/dwn-clients';

import log from 'loglevel';

import { DwnMethodName } from '@enbox/dwn-sdk-js';
import { jsonRpcRouter } from '../json-rpc-api.js';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DEFAULT_MAX_IN_FLIGHT, FlowController, isProgressToken } from './flow-controller.js';
import { DwnServerError, DwnServerErrorCode } from '../dwn-error.js';
import { requestCounter, websocketSubscriptionRejections, websocketSubscriptions } from '../metrics.js';

const HEARTBEAT_INTERVAL = 30_000;
const DEFAULT_MAX_SUBSCRIPTIONS = 64;

type SubscriptionSlot = {
  close?: () => Promise<void>;
  closePromise?: Promise<void>;
  flowController: FlowController;
  state: 'active' | 'closing' | 'opening';
};

type SubscriptionOpening = {
  id: JsonRpcId;
  listener: (message: SubscriptionMessage) => void;
  slot: SubscriptionSlot;
};

export type SocketConnectionOptions = {
  activityLog? : ActivityLog;
  adminStore? : AdminStore;
  ipRateLimiter? : RateLimiter;
  maxInFlight? : number;
  maxSubscriptions? : number;
  messageProcessedHooks? : MessageProcessedHook[];
  onClose? : () => void;
  peerIp? : string;
  registrationStore? : RegistrationStore;
  serverConfig? : DwnServerConfig;
  tenantRateLimiter? : RateLimiter;
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
  private readonly maxInFlight: number;
  private readonly maxSubscriptions: number;
  private readonly subscriptionSlots: Map<JsonRpcId, SubscriptionSlot> = new Map();
  private closePromise: Promise<void> | undefined;
  private isClosed = false;
  private isAlive: boolean = true;

  constructor(
    private readonly socket: ServerWebSocket<WsData>,
    private readonly dwn: Dwn,
    private readonly options: SocketConnectionOptions = {},
  ) {
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.maxSubscriptions = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
    if (!Number.isSafeInteger(this.maxSubscriptions) || this.maxSubscriptions < 1) {
      throw new RangeError('SocketConnection: maxSubscriptions must be a positive safe integer.');
    }
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
   * Closes and removes the reference for a given subscription from this connection.
   *
   * @param id the `JsonRpcId` of the JSON RPC subscription request.
   */
  async closeSubscription(id: JsonRpcId): Promise<void> {
    const slot = this.subscriptionSlots.get(id);
    if (slot === undefined || slot.state === 'closing') {
      throw new DwnServerError(
        DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdNotFound,
        `the subscription with id ${id} was not found`
      );
    }

    this.deactivateSubscriptionSlot(slot);
    if (slot.close === undefined) {
      // The opening request cannot be cancelled inside the DWN. Keep its slot
      // counted until that request settles and closes any late handle.
      return;
    }

    await this.closeSubscriptionHandle(slot);
    this.removeSubscriptionSlot(id, slot);
  }

  /**
   * Acknowledges subscription events up to the given progress token, advancing
   * the flow-control window for the subscription.
   */
  ackSubscription(id: JsonRpcId, cursor: ProgressToken): void {
    const slot = this.subscriptionSlots.get(id);
    if (slot !== undefined && slot.state !== 'closing') {
      slot.flowController.ack(cursor);
    }
  }

  /**
   * Closes the existing connection and cleans up any listeners or subscriptions.
   */
  async close(): Promise<void> {
    this.closePromise ??= this.closeOwned();
    return this.closePromise;
  }

  /**
   * Log the error and close the connection.
   */
  async error(error: Error): Promise<void> {
    log.error(`SocketConnection error, terminating connection`, error);
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
      return this.rejectMalformedRequest('request payload required.');
    }

    let parsedRequest: unknown;
    try {
      parsedRequest = JSON.parse(requestData);
    } catch (error) {
      return this.rejectMalformedRequest((error as Error).message);
    }

    if (!SocketConnection.isJsonRpcRequest(parsedRequest)) {
      return this.rejectMalformedRequest('request payload must be a JSON object.');
    }
    const jsonRequest = parsedRequest;

    const rateLimitResponse = this.enforceIpRateLimit(jsonRequest);
    if (rateLimitResponse !== undefined) {
      return this.send(rateLimitResponse);
    }

    let subscriptionOpening: SubscriptionOpening | undefined;
    try {
      const contextResult = this.buildRequestContext(jsonRequest);
      subscriptionOpening = contextResult.subscriptionOpening;
      const { jsonRpcResponse } = await jsonRpcRouter.handle(jsonRequest, contextResult.requestContext);
      this.recordRequestMetric(jsonRequest.method, jsonRpcResponse);
      this.send(jsonRpcResponse);
    } catch (error) {
      const jsonRpcResponse = this.createRequestErrorResponse(jsonRequest, error);
      this.recordRequestMetric(jsonRequest.method, jsonRpcResponse);
      this.send(jsonRpcResponse);
    } finally {
      if (subscriptionOpening !== undefined) {
        this.finishSubscriptionOpening(subscriptionOpening);
      }
    }
  }

  /**
   * Returns the number of active subscriptions on this connection.
   */
  get subscriptionCount(): number {
    let count = 0;
    for (const slot of this.subscriptionSlots.values()) {
      if (slot.state === 'active') {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns a serializable snapshot of this connection for the admin inspector.
   */
  toSnapshot(): AdminConnectionSnapshot {
    const subscriptions: AdminConnectionSnapshot['subscriptions'] = [];
    for (const [id, slot] of this.subscriptionSlots) {
      if (slot.state === 'active') {
        subscriptions.push({
          id       : id as string | number,
          inflight : slot.flowController.inFlightCount,
          buffered : slot.flowController.bufferCount,
        });
      }
    }

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
    if (this.isClosed) {
      return;
    }
    this.socket.send(JSON.stringify(response));
  }

  /**
   * Creates a flow-controlled subscription handler that enforces the
   * `maxInFlight` window. Returns a `SubscriptionListener` to be passed
   * to the EventLog, and stores the `FlowController` for later `rpc.ack`
   * processing.
   */
  private reserveSubscription(id: JsonRpcId): SubscriptionOpening {
    if (this.subscriptionSlots.has(id)) {
      websocketSubscriptionRejections.inc({ reason: 'duplicate-id' });
      throw new DwnServerError(
        DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdExists,
        `the subscription with id ${String(id)} already exists`,
      );
    }

    if (this.subscriptionSlots.size >= this.maxSubscriptions) {
      websocketSubscriptionRejections.inc({ reason: 'connection-limit' });
      throw new DwnServerError(
        DwnServerErrorCode.ConnectionSubscriptionLimitExceeded,
        `the connection subscription limit of ${this.maxSubscriptions} was reached`,
      );
    }

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

    const slot: SubscriptionSlot = { flowController: fc, state: 'opening' };
    const opening: SubscriptionOpening = {
      id,
      slot,
      listener: (message): void => {
        fc.push(message);
      },
    };
    this.subscriptionSlots.set(id, slot);
    return opening;
  }

  /**
   * Builds a `RequestContext` object to use with the `JSON RPC API`.
   */
  private buildRequestContext(request: JsonRpcRequest): {
    subscriptionOpening?: SubscriptionOpening;
    requestContext: RequestContext;
  } {
    const { params, method, subscription } = request;

    const requestContext: RequestContext = {
      transport             : 'ws',
      dwn                   : this.dwn,
      socketConnection      : this,
      activityLog           : this.options.activityLog,
      adminStore            : this.options.adminStore,
      registrationStore     : this.options.registrationStore,
      config                : this.options.serverConfig,
      tenantRateLimiter     : this.options.tenantRateLimiter,
      messageProcessedHooks : this.options.messageProcessedHooks,
    };

    // methods that expect a long-running subscription begin with `rpc.subscribe.`
    let subscriptionOpening: SubscriptionOpening | undefined;
    if (method === 'rpc.subscribe.dwn.processMessage' && subscription !== undefined) {
      const { message } = params as { message?: GenericMessage };
      if (message?.descriptor.method === DwnMethodName.Subscribe && SocketConnection.isJsonRpcId(subscription.id)) {
        const opening = this.reserveSubscription(subscription.id);
        subscriptionOpening = opening;
        requestContext.subscriptionRequest = {
          id                  : subscription.id,
          activate            : async (close): Promise<void> => this.activateSubscription(opening, close),
          subscriptionHandler : opening.listener,
        };
      }
    }

    return { subscriptionOpening, requestContext };
  }

  /** Returns whether an untrusted subscription ID is representable by JSON-RPC. */
  private static isJsonRpcId(value: unknown): value is JsonRpcId {
    return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  }

  /** Returns whether a parsed payload can be routed as a JSON-RPC request object. */
  private static isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Promotes the exact opening that produced a DWN subscription close handle. */
  private async activateSubscription(opening: SubscriptionOpening, close: () => Promise<void>): Promise<void> {
    const currentSlot = this.subscriptionSlots.get(opening.id);
    if (this.isClosed || currentSlot !== opening.slot) {
      await close();
      throw this.subscriptionOpeningNotFound(opening.id);
    }

    opening.slot.close = close;
    if (opening.slot.state === 'closing') {
      await this.closeSubscriptionHandle(opening.slot);
      this.removeSubscriptionSlot(opening.id, opening.slot);
      throw this.subscriptionOpeningNotFound(opening.id);
    }

    opening.slot.state = 'active';
    websocketSubscriptions.inc();
  }

  /** Releases an opening only if it still owns the slot for this request. */
  private finishSubscriptionOpening(opening: SubscriptionOpening): void {
    const slot = this.subscriptionSlots.get(opening.id);
    if (slot !== opening.slot || slot.state === 'active' || slot.close !== undefined) {
      return;
    }

    this.removeSubscriptionSlot(opening.id, slot);
  }

  /** Marks a slot inactive immediately while retaining its capacity until cleanup settles. */
  private deactivateSubscriptionSlot(slot: SubscriptionSlot): void {
    if (slot.state === 'active') {
      websocketSubscriptions.dec();
    }
    slot.state = 'closing';
    slot.flowController.close();
  }

  /** Starts or joins the one close call owned by a subscription slot. */
  private closeSubscriptionHandle(slot: SubscriptionSlot): Promise<void> {
    if (slot.closePromise === undefined) {
      const closePromise = Promise.resolve().then(slot.close!);
      slot.closePromise = closePromise;
      void closePromise.catch((): void => {
        if (slot.closePromise === closePromise) {
          slot.closePromise = undefined;
        }
      });
    }
    return slot.closePromise;
  }

  /** Removes and disposes a slot only when its exact reservation still owns the ID. */
  private removeSubscriptionSlot(id: JsonRpcId, expectedSlot?: SubscriptionSlot): SubscriptionSlot | undefined {
    const slot = this.subscriptionSlots.get(id);
    if (slot === undefined || (expectedSlot !== undefined && slot !== expectedSlot)) {
      return undefined;
    }

    this.subscriptionSlots.delete(id);
    this.deactivateSubscriptionSlot(slot);
    return slot;
  }

  /** Creates the typed error for a subscription result whose opening is no longer live. */
  private subscriptionOpeningNotFound(id: JsonRpcId): DwnServerError {
    return new DwnServerError(
      DwnServerErrorCode.ConnectionSubscriptionOpeningNotFound,
      `the opening subscription with id ${String(id)} no longer exists`,
    );
  }

  /** Owns the one-time connection cleanup sequence. */
  private async closeOwned(): Promise<void> {
    this.isClosed = true;
    clearInterval(this.heartbeatInterval);

    const closePromises: Promise<void>[] = [];
    for (const id of [...this.subscriptionSlots.keys()]) {
      const slot = this.removeSubscriptionSlot(id)!;
      if (slot.close !== undefined) {
        closePromises.push(this.closeSubscriptionHandle(slot));
      }
    }

    try {
      this.socket.close();
    } catch (error) {
      log.error('SocketConnection: error closing socket', error);
    }
    try {
      this.options.onClose?.();
    } catch (error) {
      log.error('SocketConnection: error releasing connection', error);
    }

    const closeResults = await Promise.allSettled(closePromises);
    for (const result of closeResults) {
      if (result.status === 'rejected') {
        log.error('SocketConnection: error closing subscription', result.reason);
      }
    }
  }

  /** Applies the peer-IP limiter while preserving acknowledgement flow control. */
  private enforceIpRateLimit(request?: JsonRpcRequest): JsonRpcErrorResponse | undefined {
    if (this.options.ipRateLimiter === undefined || this.isAcknowledgementForKnownSubscription(request)) {
      return undefined;
    }

    const result = this.options.ipRateLimiter.consume(this.options.peerIp ?? 'unknown');
    if (result.allowed === true) {
      return undefined;
    }

    const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
    return createJsonRpcErrorResponse(
      request?.id ?? crypto.randomUUID(),
      JsonRpcErrorCodes.TooManyRequests,
      `${DwnServerErrorCode.RateLimitExceeded}: peer IP rate limit exceeded, retry after ${retryAfterSec}s`,
      { retryAfterSec },
    );
  }

  /** Charges and rejects a malformed socket request before routing. */
  private rejectMalformedRequest(message: string): void {
    const response = this.enforceIpRateLimit() ?? createJsonRpcErrorResponse(
      crypto.randomUUID(),
      JsonRpcErrorCodes.BadRequest,
      message,
    );
    this.send(response);
  }

  /** Exempts only an acknowledgement that will advance an outstanding event window. */
  private isAcknowledgementForKnownSubscription(request?: JsonRpcRequest): boolean {
    if (request?.method !== 'rpc.ack' || typeof request.subscription !== 'object' || request.subscription === null) {
      return false;
    }

    const id = request.subscription.id;
    if (!SocketConnection.isJsonRpcId(id)) {
      return false;
    }

    const slot = this.subscriptionSlots.get(id);
    const params = request.params;
    if (slot === undefined || slot.state === 'closing' || typeof params !== 'object' || params === null) {
      return false;
    }

    const cursor = (params as { cursor?: unknown }).cursor;
    return isProgressToken(cursor) && slot.flowController.canAcknowledge(cursor);
  }

  /** Maps typed subscription-admission failures to their JSON-RPC boundary. */
  private createRequestErrorResponse(request: JsonRpcRequest, error: unknown): JsonRpcErrorResponse {
    if (error instanceof DwnServerError) {
      if (error.code === DwnServerErrorCode.ConnectionSubscriptionLimitExceeded) {
        return createJsonRpcErrorResponse(
          request.id ?? crypto.randomUUID(),
          JsonRpcErrorCodes.TooManyRequests,
          error.message,
          { retryAfterSec: 1 },
        );
      }

      if (error.code === DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdExists) {
        return createJsonRpcErrorResponse(
          request.id ?? crypto.randomUUID(),
          JsonRpcErrorCodes.InvalidParams,
          error.message,
        );
      }
    }

    log.error('SocketConnection: request dispatch failed', error);
    return createJsonRpcErrorResponse(
      request.id ?? crypto.randomUUID(),
      JsonRpcErrorCodes.InternalError,
      'an unexpected error occurred while processing the request',
    );
  }

  /** Records only registered method names to keep metric label cardinality finite. */
  private recordRequestMetric(method: string, response: JsonRpcResponse): void {
    const methodLabel = jsonRpcRouter.metricLabelFor(method);
    if (response.error !== undefined) {
      requestCounter.inc({ method: methodLabel, error: 1 });
      return;
    }

    requestCounter.inc({
      method : methodLabel,
      status : response.result?.reply?.status?.code || 0,
    });
  }
}
