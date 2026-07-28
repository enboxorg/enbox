import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcId } from '@enbox/dwn-clients';
import type { HandlerResponse, JsonRpcHandler } from '../../lib/json-rpc-router.js';

import { DwnServerErrorCode } from '../../dwn-error.js';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DwnError, DwnErrorCode, Records } from '@enbox/dwn-sdk-js';

type InboundDwnMessageParams = {
  context: Parameters<JsonRpcHandler>[1];
  hasEncodedData?: boolean;
  hasInboundData?: boolean;
  message: GenericMessage;
  requestId: JsonRpcId;
  target: string;
  allowDatalessRecordsWriteOverNonHttp?: boolean;
  allowRecordsWriteOverNonHttp?: boolean;
};

export function validateInboundDwnMessageTransport(params: InboundDwnMessageParams): HandlerResponse | undefined {
  const { allowDatalessRecordsWriteOverNonHttp, allowRecordsWriteOverNonHttp, context, hasEncodedData, message, requestId } = params;

  // Normal RecordsWrite is HTTP-only because its data stream lives in the
  // request body. Replicated apply may opt in to non-HTTP when it carries the
  // record data in JSON-RPC params.
  if (
    context.transport !== 'http' &&
    Records.isRecordsWrite(message)
  ) {
    const needsData = message.descriptor.dataSize > 0;
    if (
      allowRecordsWriteOverNonHttp === true &&
      (!needsData || hasEncodedData === true || allowDatalessRecordsWriteOverNonHttp === true)
    ) {
      return undefined;
    }

    const jsonRpcResponse = createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InvalidParams,
      `RecordsWrite is not supported via ${context.transport}`
    );
    return { jsonRpcResponse };
  }
}

/** Applies the configured data-size limit only when a RecordsWrite carries data. */
export function enforceRecordsWriteDataSizeLimit({
  context,
  hasInboundData,
  message,
  requestId,
}: {
  context: Parameters<JsonRpcHandler>[1];
  hasInboundData: boolean | undefined;
  message: GenericMessage;
  requestId: JsonRpcId;
}): HandlerResponse | undefined {
  if (hasInboundData !== true || !Records.isRecordsWrite(message)) {
    return undefined;
  }

  const dataSize = (message.descriptor as { dataSize?: unknown }).dataSize;
  return typeof dataSize === 'number'
    ? enforceRecordDataSizeLimit({ context, dataSize, requestId })
    : undefined;
}

/** Rejects record data whose byte length exceeds the server's configured limit. */
export function enforceRecordDataSizeLimit({
  context,
  dataSize,
  requestId,
}: {
  context: Parameters<JsonRpcHandler>[1];
  dataSize: number;
  requestId: JsonRpcId;
}): HandlerResponse | undefined {
  const maxRecordDataSize = context.config?.maxRecordDataSize;
  if (maxRecordDataSize === undefined || dataSize <= maxRecordDataSize) {
    return undefined;
  }

  return {
    jsonRpcResponse: createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InvalidParams,
      `${DwnServerErrorCode.RecordDataSizeLimitExceeded}: record data size ${dataSize} exceeds the configured limit ${maxRecordDataSize}`,
      { code: DwnServerErrorCode.RecordDataSizeLimitExceeded },
    ),
  };
}

/** Preserves the configured size error when a data-free duplicate probe misses. */
export function duplicateProbeMissResponse({
  context,
  message,
  requestId,
}: {
  context: Parameters<JsonRpcHandler>[1];
  message: GenericMessage;
  requestId: JsonRpcId;
}): HandlerResponse {
  const dataSize = Records.isRecordsWrite(message) ? message.descriptor.dataSize : 0;
  return enforceRecordDataSizeLimit({ context, dataSize, requestId }) ?? {
    jsonRpcResponse: createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InvalidParams,
      'message is not a fully stored duplicate',
    ),
  };
}

/** Stops a RecordsWrite stream as soon as it exceeds the signed descriptor size. */
export function capDataStreamAtDescriptorSize(
  message: GenericMessage,
  dataStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (!Records.isRecordsWrite(message) || typeof message.descriptor.dataSize !== 'number') {
    return dataStream;
  }

  const dataSize = message.descriptor.dataSize;
  const reader = dataStream.getReader();
  let bytesRead = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        controller.close();
        return;
      }

      bytesRead += value.byteLength;
      if (bytesRead > dataSize) {
        await reader.cancel().catch((): void => {
          // The stream already exceeded the declared size; cancellation is best-effort.
        });
        reader.releaseLock();
        controller.error(new DwnError(
          DwnErrorCode.RecordsWriteDataSizeMismatch,
          `actual data size exceeds descriptor dataSize ${dataSize}`,
        ));
        return;
      }

      controller.enqueue(value);
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch((): void => {
        // The consumer stopped reading; cancellation is best-effort.
      });
      reader.releaseLock();
    },
  });
}

export function enforceTenantRateLimit(params: InboundDwnMessageParams): HandlerResponse | undefined {
  const { context, requestId, target } = params;

  if (context.tenantRateLimiter === undefined) {
    return undefined;
  }

  const result = context.tenantRateLimiter.consume(target);
  if (result.allowed === true) {
    return undefined;
  }

  const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
  const jsonRpcResponse = createJsonRpcErrorResponse(
    requestId,
    JsonRpcErrorCodes.TooManyRequests,
    `${DwnServerErrorCode.RateLimitExceeded}: tenant rate limit exceeded, retry after ${retryAfterSec}s`,
    { retryAfterSec },
  );
  return { jsonRpcResponse };
}

/** Maps an atomic message-store quota rejection to the server's public JSON-RPC error contract. */
export function messageStoreQuotaErrorResponse(
  error: unknown,
  requestId: JsonRpcId,
): HandlerResponse | undefined {
  if (!(error instanceof DwnError)) {
    return undefined;
  }

  const serverErrorCode = error.code === DwnErrorCode.MessageStoreQuotaMessagesExceeded
    ? DwnServerErrorCode.TenantMessageQuotaExceeded
    : error.code === DwnErrorCode.MessageStoreQuotaStorageExceeded
      ? DwnServerErrorCode.TenantStorageQuotaExceeded
      : undefined;
  if (serverErrorCode === undefined) {
    return undefined;
  }

  return {
    jsonRpcResponse: createJsonRpcErrorResponse(
      requestId,
      JsonRpcErrorCodes.InvalidRequest,
      `${serverErrorCode}: ${error.message}`,
      { code: serverErrorCode },
    ),
  };
}
