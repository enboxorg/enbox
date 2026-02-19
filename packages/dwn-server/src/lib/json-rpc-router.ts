import type { SocketConnection } from '../connection/socket-connection.js';
import type { Dwn, MessageSubscriptionHandler } from '@enbox/dwn-sdk-js';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from '@enbox/dwn-clients';

export type RequestContext = {
  transport: 'http' | 'ws';
  dwn: Dwn;
  /** the socket connection associated with this request if over sockets */
  socketConnection?: SocketConnection;
  subscriptionRequest?: {
    /** The JsonRpcId of the subscription handler */
    id: JsonRpcId;
    /** The `MessageEvent` handler associated with a subscription request, only used in `ws` requests */
    subscriptionHandler: MessageSubscriptionHandler;
  }
  /** The `ReadableStream` associated with a `RecordsWrite` request only used in `http` requests */
  dataStream?: ReadableStream<Uint8Array>;
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
