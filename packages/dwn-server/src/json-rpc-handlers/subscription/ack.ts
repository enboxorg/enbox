import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { v4 as uuidv4 } from 'uuid';

import type { JsonRpcId } from '@enbox/dwn-clients';
import type {
  HandlerResponse,
  JsonRpcHandler,
} from '../../lib/json-rpc-router.js';

import { createJsonRpcErrorResponse, createJsonRpcSuccessResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';

/**
 * Validates that a value is a well-formed {@link ProgressToken}.
 */
function isProgressToken(value: unknown): value is ProgressToken {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.streamId === 'string' && obj.streamId !== '' &&
    typeof obj.epoch === 'string' && obj.epoch !== '' &&
    typeof obj.position === 'string' && obj.position !== '' &&
    (obj.messageCid === undefined || (typeof obj.messageCid === 'string' && obj.messageCid !== ''));
}

/**
 * Handles `rpc.ack` — acknowledges receipt of subscription events up to the
 * given progress token, advancing the per-subscription flow-control window.
 *
 * Request shape:
 * ```json
 * {
 *   "jsonrpc": "2.0",
 *   "method": "rpc.ack",
 *   "params": { "cursor": { "streamId": "...", "epoch": "...", "position": "...", "messageCid": "..." } },
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
  const { cursor } = (jsonRpcRequest.params ?? {}) as { cursor?: unknown };

  if (!isProgressToken(cursor)) {
    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId, JsonRpcErrorCodes.InvalidParams,
      'params.cursor is required and must be a ProgressToken object with streamId, epoch, and position'
    );
    return { jsonRpcResponse };
  }

  const { socketConnection } = context;
  socketConnection.ackSubscription(subscriptionId, cursor);

  const jsonRpcResponse = createJsonRpcSuccessResponse(requestId, { reply: { status: 200, detail: 'OK' } });
  return { jsonRpcResponse } as HandlerResponse;
};
