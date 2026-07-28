import type { ActivityLog } from '../admin/activity-log.js';
import type { DwnServerConfig } from '../config.js';
import type { MessageProcessedHook } from '../message-processed-hook.js';
import type { RateLimiter } from '../rate-limiter.js';
import type { SocketConnection } from '../connection/socket-connection.js';
import type { Dwn, SubscriptionListener } from '@enbox/dwn-sdk-js';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from '@enbox/dwn-clients';

import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';

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
    /** Activates this exact opening after the DWN returns its close handle. */
    activate: (close: () => Promise<void>) => Promise<void>;
  }
  /** The `ReadableStream` associated with a `RecordsWrite` request only used in `http` requests */
  dataStream?: ReadableStream<Uint8Array>;
  /** The admin activity log for capturing DWN request events (optional). */
  activityLog?: ActivityLog;
  /** Server configuration for ingress limits (optional). */
  config?: DwnServerConfig;
  /** Per-tenant rate limiter (optional). */
  tenantRateLimiter?: RateLimiter;
  /** Hooks invoked after every `dwn.processMessage()` call (fire-and-forget). */
  messageProcessedHooks?: MessageProcessedHook[];
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
  private readonly methodHandlers: Map<string, JsonRpcHandler> = new Map();

  on(methodName: string, handler: JsonRpcHandler): void {
    this.methodHandlers.set(methodName, handler);
  }

  /** Bounds metric cardinality by collapsing unregistered method names. */
  metricLabelFor(methodName: string): string {
    return this.methodHandlers.has(methodName) ? methodName : 'unknown';
  }

  async handle(
    rpcRequest: JsonRpcRequest,
    context: RequestContext,
  ): Promise<HandlerResponse> {
    const handler = this.methodHandlers.get(rpcRequest.method);
    if (handler === undefined) {
      return {
        jsonRpcResponse: createJsonRpcErrorResponse(
          rpcRequest.id!,
          JsonRpcErrorCodes.MethodNotFound,
          `Method not found: ${rpcRequest.method}`,
        ),
      };
    }

    return await handler(rpcRequest, context);
  }
}
