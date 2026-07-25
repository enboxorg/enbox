import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcId } from '@enbox/dwn-clients';
import type { HandlerResponse, JsonRpcHandler } from '../../lib/json-rpc-router.js';

import { DwnServerErrorCode } from '../../dwn-error.js';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DwnError, DwnErrorCode, DwnInterfaceName, DwnMethodName, Records } from '@enbox/dwn-sdk-js';

type InboundDwnMessageParams = {
  context: Parameters<JsonRpcHandler>[1];
  hasEncodedData?: boolean;
  hasInboundData?: boolean;
  message: GenericMessage;
  requestId: JsonRpcId;
  target: string;
  allowRecordsWriteOverNonHttp?: boolean;
};

type QuotaOptions = {
  storageBytesToAdd?: number;
};

export function validateInboundDwnMessageTransport(params: InboundDwnMessageParams): HandlerResponse | undefined {
  const { allowRecordsWriteOverNonHttp, context, hasEncodedData, message, requestId } = params;

  // Normal RecordsWrite is HTTP-only because its data stream lives in the
  // request body. Replicated apply may opt in to non-HTTP when it carries the
  // record data in JSON-RPC params.
  if (
    context.transport !== 'http' &&
    message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write
  ) {
    const dataSize = (message.descriptor as { dataSize?: unknown }).dataSize;
    const needsData = typeof dataSize === 'number' && dataSize > 0;
    if (allowRecordsWriteOverNonHttp === true && (!needsData || hasEncodedData === true)) {
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

export async function enforceInboundDwnMessageLimits(params: InboundDwnMessageParams): Promise<HandlerResponse | undefined> {
  const { context, hasInboundData, message, requestId, target } = params;

  const rateLimitResult = enforceTenantRateLimit(params);
  if (rateLimitResult !== undefined) {
    return rateLimitResult;
  }

  const dataSizeResult = enforceRecordsWriteDataSizeLimit({ context, hasInboundData, message, requestId });
  if (dataSizeResult !== undefined) {
    return dataSizeResult;
  }

  if (
    context.config &&
    context.adminStore &&
    Records.isRecordsWrite(message)
  ) {
    return enforceQuota(target, message, context);
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

/**
 * Checks whether the tenant has exceeded their message count or storage quota.
 * Returns a JSON-RPC error response if the quota is exceeded, or `undefined` to proceed.
 */
export async function enforceQuota(
  target: string,
  message: GenericMessage,
  context: Parameters<JsonRpcHandler>[1],
  options: QuotaOptions = {},
): Promise<HandlerResponse | undefined> {
  const { config, adminStore, registrationStore } = context;
  const requestId = (message as { recordId?: string }).recordId ?? crypto.randomUUID();

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
          { code: DwnServerErrorCode.TenantMessageQuotaExceeded },
        ),
      };
    }
  }

  // Check storage size quota.
  if (maxStorageBytes > 0) {
    const dataSize = options.storageBytesToAdd ?? (message.descriptor as { dataSize?: number }).dataSize ?? 0;
    const currentStorage = await adminStore!.getTenantStorageSize(target);
    if (currentStorage + dataSize > maxStorageBytes) {
      return {
        jsonRpcResponse: createJsonRpcErrorResponse(
          requestId,
          JsonRpcErrorCodes.InvalidRequest,
          `${DwnServerErrorCode.TenantStorageQuotaExceeded}: tenant would exceed storage limit of ${maxStorageBytes} bytes`,
          { code: DwnServerErrorCode.TenantStorageQuotaExceeded },
        ),
      };
    }
  }

  return undefined;
}
