import type { GenericMessage, UnionMessageReply } from '@enbox/dwn-sdk-js';
import type {
  HandlerResponse,
  JsonRpcHandler,
} from '../../lib/json-rpc-router.js';
import type { JsonRpcId, JsonRpcSubscription } from '@enbox/dwn-clients';

import log from 'loglevel';

import { DwnMethodName } from '@enbox/dwn-sdk-js';
import { invokeMessageProcessedHooks } from './message-processed-hooks.js';
import { requestDataBytesTotal } from '../../metrics.js';
import { capDataStreamAtDescriptorSize, enforceInboundDwnMessageLimits, validateInboundDwnMessageTransport } from './inbound-message.js';
import {
  createJsonRpcErrorResponse,
  createJsonRpcSuccessResponse,
  JsonRpcErrorCodes,
} from '@enbox/dwn-clients';

/**
 * Validates subscription-specific preconditions for a `RecordsSubscribe` /
 * `MessagesSubscribe` request: the request must carry a subscription context,
 * subscriptions are only supported over WebSockets, and the subscription id
 * must not already be in use on this connection. Returns an error response
 * to short-circuit the caller, or `undefined` when all checks pass.
 */
function checkSubscriptionRequestPreconditions(
  context: Parameters<JsonRpcHandler>[1],
  message: GenericMessage,
  requestId: JsonRpcId,
): HandlerResponse | undefined {
  // subscribe methods must come with a subscriptionRequest context
  if (message.descriptor.method === DwnMethodName.Subscribe && context.subscriptionRequest === undefined) {
    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InvalidRequest,
      `subscribe methods must contain a subscriptionRequest context`
    );
    return { jsonRpcResponse };
  }

  // Subscribe methods are only supported on 'ws' (WebSockets)
  if (context.transport !== 'ws' && context.subscriptionRequest !== undefined) {
    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InvalidParams,
      `subscriptions are not supported via ${context.transport}`
    );
    return { jsonRpcResponse };
  }

  // if this is a subscription request, we first check if the connection has a subscription with this Id
  // we do this ahead of time to prevent opening a subscription on the dwn only to close it after attempting to add it to the subscription manager
  // otherwise the subscription manager would throw an error that the Id is already in use and we would close the open subscription on the DWN.
  if (context.subscriptionRequest !== undefined && context.socketConnection?.hasSubscription(context.subscriptionRequest.id)) {
    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InvalidParams,
      `the subscribe id: ${context.subscriptionRequest.id} is in use by an active subscription`
    );
    return { jsonRpcResponse };
  }

  return undefined;
}

/**
 * Invokes message-processed hooks and records per-request activity log
 * entries and Prometheus metrics for a successfully processed DWN message.
 */
function recordProcessedMessageMetrics(
  context: Parameters<JsonRpcHandler>[1],
  target: string,
  message: GenericMessage,
  reply: UnionMessageReply,
  transport: 'http' | 'ws',
): void {
  const statusCode = reply.status?.code ?? 0;
  invokeMessageProcessedHooks(context, target, message, reply.status);

  // Capture activity event and per-request metrics.
  const dwnInterface = message.descriptor.interface as string;
  const dwnMethod = message.descriptor.method as string;
  const dataSizeBytes = (message.descriptor as { dataSize?: number }).dataSize;

  if (dataSizeBytes !== undefined && dataSizeBytes > 0) {
    requestDataBytesTotal.inc({ interface: dwnInterface, method: dwnMethod }, dataSizeBytes);
  }

  if (context.activityLog) {
    context.activityLog.record({
      tenant    : target,
      interface : dwnInterface,
      method    : dwnMethod,
      statusCode,
      transport,
      dataSizeBytes,
    });
  }
}

export const handleDwnProcessMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream, subscriptionRequest, socketConnection, transport } = context;
  const { target, message } = dwnRequest.params as { target: string, message: GenericMessage };
  const requestId = dwnRequest.id ?? crypto.randomUUID();

  try {
    const transportResult = validateInboundDwnMessageTransport({ context, message, requestId, target });
    if (transportResult !== undefined) {
      return transportResult;
    }

    const subscriptionResult = checkSubscriptionRequestPreconditions(context, message, requestId);
    if (subscriptionResult !== undefined) {
      return subscriptionResult;
    }

    const limitsResult = await enforceInboundDwnMessageLimits({
      context,
      hasInboundData: dataStream !== undefined,
      message,
      requestId,
      target,
    });
    if (limitsResult !== undefined) {
      return limitsResult;
    }

    const dataStreamForProcessing = dataStream === undefined
      ? undefined
      : capDataStreamAtDescriptorSize(message, dataStream);

    let reply: UnionMessageReply;
    try {
      reply = await dwn.processMessage(target, message, {
        dataStream          : dataStreamForProcessing,
        subscriptionHandler : subscriptionRequest?.subscriptionHandler,
      });
    } finally {
      await dataStreamForProcessing?.cancel().catch((): void => {
        // Rejected messages may leave their request body unread; cancellation is best-effort.
      });
    }

    const { entry } = reply;
    // RecordsRead or MessagesRead messages optionally return data as a stream to accommodate large amounts of data
    // we remove the data stream from the reply that will be serialized and return it as a separate property in the response payload.
    let recordDataStream: ReadableStream<Uint8Array>;
    if (entry !== undefined && entry.data !== undefined) {
      recordDataStream = entry.data;
      delete reply.entry.data; // not serializable via JSON
    }

    if (subscriptionRequest && reply.subscription) {
      const { close } = reply.subscription;
      // Subscribe messages return a close function to facilitate closing the subscription
      // we add a reference to the close function for this subscription request to the socket connection.
      // this will facilitate closing the subscription later.
      const subscriptionReply: JsonRpcSubscription = {
        id: subscriptionRequest.id,
        close,
      };
      await socketConnection.addSubscription(subscriptionReply);
      delete reply.subscription.close; // delete the close method from the reply as it's not JSON serializable and has a held reference.
    }

    const jsonRpcResponse = createJsonRpcSuccessResponse(requestId, { reply });
    const responsePayload: HandlerResponse = { jsonRpcResponse };
    if (recordDataStream) {
      responsePayload.dataStream = recordDataStream;
    }

    recordProcessedMessageMetrics(context, target, message, reply, transport);

    return responsePayload;
  } catch (error) {
    // Log the full error internally but return a generic message to the client
    // to avoid leaking implementation details (SQL errors, file paths, etc.).
    log.error('handleDwnProcessMessage error', error);

    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InternalError,
      'an unexpected error occurred while processing the message',
    );

    return { jsonRpcResponse } as HandlerResponse;
  }
};
