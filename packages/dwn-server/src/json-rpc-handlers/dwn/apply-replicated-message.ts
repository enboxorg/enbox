import type { GenericMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { HandlerResponse, JsonRpcHandler } from '../../lib/json-rpc-router.js';

import log from 'loglevel';

import { requestDataBytesTotal } from '../../metrics.js';
import { v4 as uuidv4 } from 'uuid';
import { createJsonRpcErrorResponse, createJsonRpcSuccessResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { enforceInboundDwnMessageLimits, validateInboundDwnMessageTransport } from './inbound-message.js';

export const handleDwnApplyReplicatedMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream } = context;
  const { target, message } = dwnRequest.params as { target: string, message: GenericMessage };
  const requestId = dwnRequest.id ?? uuidv4();

  try {
    const transportResult = validateInboundDwnMessageTransport({ context, message, requestId, target });
    if (transportResult !== undefined) {
      return transportResult;
    }

    const limitsResult = await enforceInboundDwnMessageLimits({ context, message, requestId, target });
    if (limitsResult !== undefined) {
      return limitsResult;
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
