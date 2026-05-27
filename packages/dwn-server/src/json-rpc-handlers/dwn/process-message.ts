import type { GenericMessage } from '@enbox/dwn-sdk-js';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import log from 'loglevel';
import { v4 as uuidv4 } from 'uuid';

import type { JsonRpcSubscription } from '@enbox/dwn-clients';
import type {
  HandlerResponse,
  JsonRpcHandler,
} from '../../lib/json-rpc-router.js';

import { DwnServerErrorCode } from '../../dwn-error.js';
import { requestDataBytesTotal } from '../../metrics.js';
import {
  createJsonRpcErrorResponse,
  createJsonRpcSuccessResponse,
  JsonRpcErrorCodes,
} from '@enbox/dwn-clients';


export const handleDwnProcessMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream, subscriptionRequest, socketConnection, transport } = context;
  const { target, message } = (dwnRequest.params ?? {}) as { target: string, message: GenericMessage };
  const requestId = dwnRequest.id ?? uuidv4();

  if (!message?.descriptor) {
    return {
      jsonRpcResponse: createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidParams,
        'missing or malformed `message` in request params',
      ),
    } as HandlerResponse;
  }

  try {
    // RecordsWrite is only supported on 'http' to support data stream for large data
    // TODO: https://github.com/enboxorg/enbox/issues/108
    if (
      transport !== 'http' &&
      message.descriptor.interface === DwnInterfaceName.Records &&
      message.descriptor.method === DwnMethodName.Write
    ) {
      const jsonRpcResponse = createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidParams,
        `RecordsWrite is not supported via ${context.transport}`
      );
      return { jsonRpcResponse };
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

    // --- Per-tenant rate limiting (before any DWN processing) ---
    if (context.tenantRateLimiter) {
      const result = context.tenantRateLimiter.consume(target);
      if (result.allowed === false) {
        const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
        const jsonRpcResponse = createJsonRpcErrorResponse(
          requestId,
          JsonRpcErrorCodes.TooManyRequests,
          `${DwnServerErrorCode.RateLimitExceeded}: tenant rate limit exceeded, retry after ${retryAfterSec}s`,
          { retryAfterSec },
        );
        return { jsonRpcResponse };
      }
    }

    // --- Per-tenant storage quota enforcement (RecordsWrite only) ---
    if (
      context.config &&
      context.adminStore &&
      message.descriptor.interface === DwnInterfaceName.Records &&
      message.descriptor.method === DwnMethodName.Write
    ) {
      const quotaResult = await enforceQuota(target, message, context);
      if (quotaResult !== undefined) {
        return quotaResult;
      }
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Log the full error with stack trace. loglevel's log.error doesn't
    // always serialize Error objects to stdout, so we use console.error
    // as a fallback to ensure the details reach the log stream.
    log.error(`handleDwnProcessMessage error: ${errorMessage}`);
    if (errorStack) {
      log.error(errorStack);
    }

    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InternalError,
      `an unexpected error occurred while processing the message`,
    );

    return { jsonRpcResponse } as HandlerResponse;
  }
};

// ---------------------------------------------------------------------------
// Quota enforcement helper
// ---------------------------------------------------------------------------

/**
 * Checks whether the tenant has exceeded their message count or storage quota.
 * Returns a JSON-RPC error response if the quota is exceeded, or `undefined` to proceed.
 */
async function enforceQuota(
  target: string,
  message: GenericMessage,
  context: Parameters<JsonRpcHandler>[1],
): Promise<HandlerResponse | undefined> {
  const { config, adminStore, registrationStore } = context;
  const requestId = (message as any).recordId ?? uuidv4();

  // Resolve effective quota: per-tenant override > global config > unlimited.
  let maxMessages = config!.quotaMaxMessages ?? 0;
  let maxStorageBytes = config!.quotaMaxStorageBytes ?? 0;

  if (registrationStore) {
    const tenantQuota = await registrationStore.getQuota(target);
    if (tenantQuota !== undefined) {
      maxMessages = tenantQuota.maxMessages ?? maxMessages;
      maxStorageBytes = tenantQuota.maxStorageBytes ?? maxStorageBytes;
    }
  }

  // 0 means unlimited — skip enforcement.
  if (maxMessages === 0 && maxStorageBytes === 0) {
    return undefined;
  }

  // Check message count quota.
  if (maxMessages > 0) {
    const currentMessages = await adminStore!.getTenantMessageCount(target);
    if (currentMessages >= maxMessages) {
      return {
        jsonRpcResponse: createJsonRpcErrorResponse(
          requestId,
          JsonRpcErrorCodes.InvalidRequest,
          `${DwnServerErrorCode.TenantMessageQuotaExceeded}: tenant has reached the message limit of ${maxMessages}`,
        ),
      };
    }
  }

  // Check storage size quota.
  if (maxStorageBytes > 0) {
    const dataSize = (message.descriptor as { dataSize?: number }).dataSize ?? 0;
    const currentStorage = await adminStore!.getTenantStorageSize(target);
    if (currentStorage + dataSize > maxStorageBytes) {
      return {
        jsonRpcResponse: createJsonRpcErrorResponse(
          requestId,
          JsonRpcErrorCodes.InvalidRequest,
          `${DwnServerErrorCode.TenantStorageQuotaExceeded}: tenant would exceed storage limit of ${maxStorageBytes} bytes`,
        ),
      };
    }
  }

  return undefined;
}
