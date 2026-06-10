import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcId } from '@enbox/dwn-clients';
import type { HandlerResponse, JsonRpcHandler } from '../../lib/json-rpc-router.js';

import { DwnServerErrorCode } from '../../dwn-error.js';
import { v4 as uuidv4 } from 'uuid';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

type InboundDwnMessageParams = {
  context: Parameters<JsonRpcHandler>[1];
  message: GenericMessage;
  requestId: JsonRpcId;
  target: string;
};

export function validateInboundDwnMessageTransport(params: InboundDwnMessageParams): HandlerResponse | undefined {
  const { context, message, requestId } = params;

  // RecordsWrite is only supported on 'http' to support data stream for large data
  // TODO: https://github.com/enboxorg/enbox/issues/108
  if (
    context.transport !== 'http' &&
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
}

export async function enforceInboundDwnMessageLimits(params: InboundDwnMessageParams): Promise<HandlerResponse | undefined> {
  const { context, message, requestId, target } = params;

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

  if (
    context.config &&
    context.adminStore &&
    message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write
  ) {
    return enforceQuota(target, message, context);
  }
}

/**
 * Checks whether the tenant has exceeded their message count or storage quota.
 * Returns a JSON-RPC error response if the quota is exceeded, or `undefined` to proceed.
 */
export async function enforceQuota(
  target: string,
  message: GenericMessage,
  context: Parameters<JsonRpcHandler>[1],
): Promise<HandlerResponse | undefined> {
  const { config, adminStore, registrationStore } = context;
  const requestId = (message as { recordId?: string }).recordId ?? uuidv4();

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
