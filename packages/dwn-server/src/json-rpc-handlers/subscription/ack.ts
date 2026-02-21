import { v4 as uuidv4 } from 'uuid';

import type { JsonRpcId } from '@enbox/dwn-clients';
import type {
  HandlerResponse,
  JsonRpcHandler,
} from '../../lib/json-rpc-router.js';

import { createJsonRpcErrorResponse, createJsonRpcSuccessResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';

/**
 * Handles `rpc.ack` — acknowledges receipt of subscription events up to the
 * given cursor, advancing the per-subscription flow-control window.
 *
 * Request shape:
 * ```json
 * {
 *   "jsonrpc": "2.0",
 *   "method": "rpc.ack",
 *   "params": { "cursor": "<opaque-cursor>" },
 *   "subscription": { "id": "<subscription-id>" }
 * }
 * ```
 *
 * This is a notification (no `id` required), but the server sends a response
 * if validation fails (missing params, unknown subscription, etc.).
 */
export const handleSubscriptionAck: JsonRpcHandler = async (
  jsonRpcRequest,
  context,
) => {
  const requestId = jsonRpcRequest.id ?? uuidv4();

  if (context.socketConnection === undefined) {
    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId, JsonRpcErrorCodes.InvalidRequest, 'socket connection does not exist'
    );
    return { jsonRpcResponse };
  }

  if (jsonRpcRequest.subscription === undefined) {
    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId, JsonRpcErrorCodes.InvalidParams, 'subscription options are required'
    );
    return { jsonRpcResponse };
  }

  const { id: subscriptionId } = jsonRpcRequest.subscription as { id: JsonRpcId };
  const { cursor } = (jsonRpcRequest.params ?? {}) as { cursor?: string };

  if (cursor === undefined || typeof cursor !== 'string' || cursor === '') {
    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId, JsonRpcErrorCodes.InvalidParams, 'params.cursor is required and must be a non-empty string'
    );
    return { jsonRpcResponse };
  }

  const { socketConnection } = context;
  socketConnection.ackSubscription(subscriptionId, cursor);

  const jsonRpcResponse = createJsonRpcSuccessResponse(requestId, { reply: { status: 200, detail: 'OK' } });
  return { jsonRpcResponse } as HandlerResponse;
};
