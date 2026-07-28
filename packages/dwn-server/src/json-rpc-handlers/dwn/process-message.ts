import type { JsonRpcId } from '@enbox/dwn-clients';
import type { GenericMessage, UnionMessageReply } from '@enbox/dwn-sdk-js';
import type {
  HandlerResponse,
  JsonRpcHandler,
} from '../../lib/json-rpc-router.js';

import log from 'loglevel';

import { DwnMethodName } from '@enbox/dwn-sdk-js';
import { getStoredMessageState } from './stored-message.js';
import { invokeMessageProcessedHooks } from './message-processed-hooks.js';
import { requestDataBytesTotal } from '../../metrics.js';
import {
  capDataStreamAtDescriptorSize,
  duplicateProbeMissResponse,
  enforceRecordsWriteDataSizeLimit,
  enforceTenantRateLimit,
  messageStoreQuotaErrorResponse,
  validateInboundDwnMessageTransport,
} from './inbound-message.js';
import {
  createJsonRpcErrorResponse,
  createJsonRpcSuccessResponse,
  JsonRpcErrorCodes,
} from '@enbox/dwn-clients';

/**
 * Validates subscription-specific preconditions for a `RecordsSubscribe` /
 * `MessagesSubscribe` request: the request must carry a subscription context
 * and subscriptions are only supported over WebSockets. Subscription IDs and
 * capacity are reserved atomically by the owning socket before this handler.
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
  const { dwn, dataStream, subscriptionRequest, transport } = context;
  const { duplicateOnly, target, message } = dwnRequest.params as {
    duplicateOnly?: boolean;
    target: string;
    message: GenericMessage;
  };
  const requestId = dwnRequest.id ?? crypto.randomUUID();

  try {
    const transportResult = validateInboundDwnMessageTransport({
      allowDatalessRecordsWriteOverNonHttp : duplicateOnly === true,
      allowRecordsWriteOverNonHttp         : duplicateOnly === true,
      context,
      message,
      requestId,
      target,
    });
    if (transportResult !== undefined) {
      return transportResult;
    }

    const subscriptionResult = checkSubscriptionRequestPreconditions(context, message, requestId);
    if (subscriptionResult !== undefined) {
      return subscriptionResult;
    }

    const rateLimitResult = enforceTenantRateLimit({ context, message, requestId, target });
    if (rateLimitResult !== undefined) {
      return rateLimitResult;
    }

    const tenantReply = await dwn.validateTenant(target);
    if (tenantReply !== undefined) {
      return processReply(context, target, message, tenantReply, transport, requestId);
    }

    if (duplicateOnly === true) {
      if (dataStream !== undefined) {
        return {
          jsonRpcResponse: createJsonRpcErrorResponse(
            requestId,
            JsonRpcErrorCodes.InvalidParams,
            'duplicate-only probes must not include record data',
          ),
        };
      }

      const integrityError = await dwn.validateMessageIntegrity(message);
      if (integrityError === undefined && await getStoredMessageState(dwn, target, message) === 'complete') {
        return processReply(context, target, message, duplicateReply(), transport, requestId);
      }

      return duplicateProbeMissResponse({ context, message, requestId });
    }

    const dataSizeResult = enforceRecordsWriteDataSizeLimit({
      context,
      hasInboundData: dataStream !== undefined,
      message,
      requestId,
    });
    if (dataSizeResult !== undefined) {
      if (await getStoredMessageState(dwn, target, message) === 'complete') {
        await dataStream!.cancel().catch((): void => {
          // The exact write and its data are already stored; the retry body is unnecessary.
        });
        return processReply(context, target, message, duplicateReply(), transport, requestId);
      }
      return dataSizeResult;
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

    return processReply(context, target, message, reply, transport, requestId, subscriptionRequest);
  } catch (error) {
    const quotaResponse = messageStoreQuotaErrorResponse(error, requestId);
    if (quotaResponse !== undefined) {
      return quotaResponse;
    }

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

async function processReply(
  context: Parameters<JsonRpcHandler>[1],
  target: string,
  message: GenericMessage,
  reply: UnionMessageReply,
  transport: 'http' | 'ws',
  requestId: JsonRpcId,
  subscriptionRequest?: Parameters<JsonRpcHandler>[1]['subscriptionRequest'],
): Promise<HandlerResponse> {
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
    await subscriptionRequest.activate(close);
    delete reply.subscription.close; // delete the close method from the reply as it's not JSON serializable and has a held reference.
  }

  const jsonRpcResponse = createJsonRpcSuccessResponse(requestId, { reply });
  const responsePayload: HandlerResponse = { jsonRpcResponse };
  if (recordDataStream) {
    responsePayload.dataStream = recordDataStream;
  }

  recordProcessedMessageMetrics(context, target, message, reply, transport);

  return responsePayload;
}

function duplicateReply(): UnionMessageReply {
  return { status: { code: 409, detail: 'Conflict' } };
}
