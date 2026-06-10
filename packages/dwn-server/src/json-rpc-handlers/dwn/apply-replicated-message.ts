import type { GenericMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { HandlerResponse, JsonRpcHandler } from '../../lib/json-rpc-router.js';

import log from 'loglevel';
import { v4 as uuidv4 } from 'uuid';

import { enforceQuota } from './process-message.js';
import { requestDataBytesTotal } from '../../metrics.js';
import { createJsonRpcErrorResponse, createJsonRpcSuccessResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

export const handleDwnApplyReplicatedMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream, transport } = context;
  const { target, message } = dwnRequest.params as { target: string, message: GenericMessage };
  const requestId = dwnRequest.id ?? uuidv4();

  try {
    if (
      transport !== 'http' &&
      message.descriptor.interface === DwnInterfaceName.Records &&
      message.descriptor.method === DwnMethodName.Write
    ) {
      return {
        jsonRpcResponse: createJsonRpcErrorResponse(
          requestId,
          JsonRpcErrorCodes.InvalidParams,
          `RecordsWrite is not supported via ${context.transport}`
        ),
      };
    }

    if (context.tenantRateLimiter) {
      const result = context.tenantRateLimiter.consume(target);
      if (result.allowed === false) {
        const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
        return {
          jsonRpcResponse: createJsonRpcErrorResponse(
            requestId,
            JsonRpcErrorCodes.TooManyRequests,
            `tenant rate limit exceeded, retry after ${retryAfterSec}s`,
            { retryAfterSec },
          ),
        };
      }
    }

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

    const result = await dwn.applyReplicatedMessage(target, message, { dataStream });
    recordApplyActivity(target, message, result, context);

    return {
      jsonRpcResponse: createJsonRpcSuccessResponse(requestId, { result }),
    };
  } catch (error) {
    log.error('handleDwnApplyReplicatedMessage error', error);

    return {
      jsonRpcResponse: createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InternalError,
        'an unexpected error occurred while applying the replicated message',
      ),
    } as HandlerResponse;
  }
};

function recordApplyActivity(
  target: string,
  message: GenericMessage,
  result: ReplicationApplyResult,
  context: Parameters<JsonRpcHandler>[1],
): void {
  const dwnInterface = message.descriptor.interface as string;
  const dwnMethod = message.descriptor.method as string;
  const dataSizeBytes = (message.descriptor as { dataSize?: number }).dataSize;

  if (dataSizeBytes !== undefined && dataSizeBytes > 0) {
    requestDataBytesTotal.inc({ interface: dwnInterface, method: dwnMethod }, dataSizeBytes);
  }

  context.activityLog?.record({
    tenant     : target,
    interface  : dwnInterface,
    method     : dwnMethod,
    statusCode : replicationApplyStatusCode(result),
    transport  : context.transport,
    dataSizeBytes,
  });
}

function replicationApplyStatusCode(result: ReplicationApplyResult): number {
  switch (result.kind) {
    case 'Applied':
      return 202;
    case 'Duplicate':
    case 'Superseded':
      return 409;
    case 'Incomplete':
      return 424;
    case 'Invalid':
      return 400;
    case 'Deferred':
      return 503;
  }
}
