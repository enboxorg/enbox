import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcSubscription } from '@enbox/dwn-clients';
import type {
  HandlerResponse,
  JsonRpcHandler,
} from '../../lib/json-rpc-router.js';

import log from 'loglevel';

import { DwnMethodName } from '@enbox/dwn-sdk-js';
import { requestDataBytesTotal } from '../../metrics.js';
import { v4 as uuidv4 } from 'uuid';
import {
  createJsonRpcErrorResponse,
  createJsonRpcSuccessResponse,
  JsonRpcErrorCodes,
} from '@enbox/dwn-clients';
import { enforceInboundDwnMessageLimits, validateInboundDwnMessageTransport } from './inbound-message.js';


export const handleDwnProcessMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream, subscriptionRequest, socketConnection, transport } = context;
  const { target, message } = dwnRequest.params as { target: string, message: GenericMessage };
  const requestId = dwnRequest.id ?? uuidv4();

  try {
    const transportResult = validateInboundDwnMessageTransport({ context, message, requestId, target });
    if (transportResult !== undefined) {
      return transportResult;
    }

    // subscribe methods must come with a subscriptionRequest context
    if (message.descriptor.method === DwnMethodName.Subscribe && subscriptionRequest === undefined) {
      const jsonRpcResponse = createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidRequest,
        `subscribe methods must contain a subscriptionRequest context`
      );
      return { jsonRpcResponse };
    }

    // Subscribe methods are only supported on 'ws' (WebSockets)
    if (transport !== 'ws' && subscriptionRequest !== undefined) {
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
    if (subscriptionRequest !== undefined && socketConnection?.hasSubscription(subscriptionRequest.id)) {
      const jsonRpcResponse = createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidParams,
        `the subscribe id: ${subscriptionRequest.id} is in use by an active subscription`
      );
      return { jsonRpcResponse };
    }

    const limitsResult = await enforceInboundDwnMessageLimits({ context, message, requestId, target });
    if (limitsResult !== undefined) {
      return limitsResult;
    }

    const reply = await dwn.processMessage(target, message, {
      dataStream,
      subscriptionHandler: subscriptionRequest?.subscriptionHandler,
    });


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

    // --- Fire-and-forget: post-processing hooks ---
    const statusCode = reply.status?.code ?? 0;
    if (context.messageProcessedHooks) {
      const hookContext = { tenant: target, message, status: reply.status, transport };
      for (const hook of context.messageProcessedHooks) {
        try {
          const result = hook.onMessageProcessed(hookContext);
          if (result instanceof Promise) {
            result.catch((err: unknown): void => {
              log.error('MessageProcessedHook error', err);
            });
          }
        } catch (err) {
          log.error('MessageProcessedHook error', err);
        }
      }
    }

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
