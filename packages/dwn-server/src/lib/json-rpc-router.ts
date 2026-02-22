import type { ActivityLog } from '../admin/activity-log.js';
import type { AdminStore } from '../admin/admin-store.js';
import type { DwnServerConfig } from '../config.js';
import type { RateLimiter } from '../rate-limiter.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { SocketConnection } from '../connection/socket-connection.js';
import type { Dwn, SubscriptionListener } from '@enbox/dwn-sdk-js';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from '@enbox/dwn-clients';

export type RequestContext = {
  transport: 'http' | 'ws';
  dwn: Dwn;
  /** the socket connection associated with this request if over sockets */
  socketConnection?: SocketConnection;
  subscriptionRequest?: {
    /** The JsonRpcId of the subscription handler */
    id: JsonRpcId;
    /** The `SubscriptionMessage` handler associated with a subscription request, only used in `ws` requests */
    subscriptionHandler: SubscriptionListener;
  }
  /** The `ReadableStream` associated with a `RecordsWrite` request only used in `http` requests */
  dataStream?: ReadableStream<Uint8Array>;
  /** The admin activity log for capturing DWN request events (optional). */
  activityLog?: ActivityLog;
  /** The admin store for quota usage queries (optional). */
  adminStore?: AdminStore;
  /** The registration store for per-tenant quota lookups (optional). */
  registrationStore?: RegistrationStore;
  /** Server configuration for global quota/rate-limit defaults (optional). */
  config?: DwnServerConfig;
  /** Per-tenant rate limiter (optional). */
  tenantRateLimiter?: RateLimiter;
};

export type HandlerResponse = {
  jsonRpcResponse: JsonRpcResponse;
  dataStream?: ReadableStream<Uint8Array>;
};

export type JsonRpcHandler = (
  JsonRpcRequest: JsonRpcRequest,
  context: RequestContext,
) => Promise<HandlerResponse>;

export class JsonRpcRouter {
  private methodHandlers: { [method: string]: JsonRpcHandler };

  constructor() {
    this.methodHandlers = {};
  }

  on(methodName: string, handler: JsonRpcHandler): void {
    this.methodHandlers[methodName] = handler;
  }

  async handle(
    rpcRequest: JsonRpcRequest,
    context: RequestContext,
  ): Promise<HandlerResponse> {
    const handler = this.methodHandlers[rpcRequest.method];

    return await handler(rpcRequest, context);
  }
}
