import type { JsonRpcHandler } from '../../lib/json-rpc-router.js';
import type { GenericMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import log from 'loglevel';

import { invokeMessageProcessedHooks } from './message-processed-hooks.js';
import { requestDataBytesTotal } from '../../metrics.js';
import { v4 as uuidv4 } from 'uuid';
import { createJsonRpcErrorResponse, createJsonRpcSuccessResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DataStream, DwnInterfaceName, DwnMethodName, Encoder } from '@enbox/dwn-sdk-js';
import { enforceInboundDwnMessageLimits, validateInboundDwnMessageTransport } from './inbound-message.js';

export const handleDwnApplyReplicatedMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream } = context;
  const { encodedData, target, message } = dwnRequest.params as { encodedData?: string, target: string, message: GenericMessage };
  const requestId = dwnRequest.id ?? uuidv4();

  try {
    const transportResult = validateInboundDwnMessageTransport({
      allowRecordsWriteOverNonHttp : true,
      context,
      hasEncodedData               : encodedData !== undefined,
      message,
      requestId,
      target,
    });
    if (transportResult !== undefined) {
      return transportResult;
    }

    const limitsResult = await enforceInboundDwnMessageLimits({ context, message, requestId, target });
    if (limitsResult !== undefined) {
      return limitsResult;
    }

    const encodedDataResult = validateEncodedData({ context, encodedData, message, requestId });
    if (encodedDataResult !== undefined) {
      return encodedDataResult;
    }

    const dataStreamForApply = encodedData === undefined ? dataStream : DataStream.fromBytes(Encoder.base64UrlToBytes(encodedData));
    const result = await dwn.applyReplicatedMessage(target, message, {
      dataStream: dataStreamForApply,
    });
    recordApplyActivity(target, message, result, context);
    if (result.kind === 'Applied') {
      invokeMessageProcessedHooks(context, target, message, appliedHookStatus(message, dataStreamForApply !== undefined));
    }

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
    };
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

function validateEncodedData({
  context,
  encodedData,
  message,
  requestId,
}: {
  context: Parameters<JsonRpcHandler>[1];
  encodedData?: string;
  message: GenericMessage;
  requestId: Parameters<typeof createJsonRpcErrorResponse>[0];
}): ReturnType<typeof validateInboundDwnMessageTransport> {
  if (encodedData === undefined) {
    return undefined;
  }

  const decodedLength = base64UrlDecodedLength(encodedData);
  if (decodedLength === undefined) {
    return {
      jsonRpcResponse: createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidParams,
        'encodedData must be valid base64url data',
      ),
    };
  }

  const descriptor = message.descriptor as { dataSize?: unknown };
  if (typeof descriptor.dataSize === 'number' && decodedLength !== descriptor.dataSize) {
    return {
      jsonRpcResponse: createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidParams,
        `encodedData length ${decodedLength} does not match descriptor dataSize ${descriptor.dataSize}`,
      ),
    };
  }

  const maxRecordDataSize = context.config?.maxRecordDataSize;
  if (maxRecordDataSize !== undefined && decodedLength > maxRecordDataSize) {
    return {
      jsonRpcResponse: createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidParams,
        `encodedData length ${decodedLength} exceeds max record data size ${maxRecordDataSize}`,
      ),
    };
  }
}

function base64UrlDecodedLength(encodedData: string): number | undefined {
  const unpaddedLength = getBase64UrlLength(encodedData);
  if (unpaddedLength === undefined) {
    return undefined;
  }
  if (unpaddedLength % 4 === 1) {
    return undefined;
  }

  return Math.floor((unpaddedLength * 3) / 4);
}

function getBase64UrlLength(encodedData: string): number | undefined {
  for (let i = 0; i < encodedData.length; i++) {
    const charCode = encodedData.charCodeAt(i);
    if (!isBase64UrlCharCode(charCode)) {
      return undefined;
    }
  }

  return encodedData.length;
}

function isBase64UrlCharCode(charCode: number): boolean {
  return (charCode >= 65 && charCode <= 90) ||
    (charCode >= 97 && charCode <= 122) ||
    (charCode >= 48 && charCode <= 57) ||
    charCode === 45 ||
    charCode === 95;
}

function appliedHookStatus(message: GenericMessage, hasDataStream: boolean): { code: number; detail: string } {
  const descriptor = message.descriptor as { interface?: string; method?: string; dateCreated?: string; messageTimestamp?: string };
  if (
    descriptor.interface === DwnInterfaceName.Records &&
    descriptor.method === DwnMethodName.Write &&
    descriptor.dateCreated === descriptor.messageTimestamp &&
    !hasDataStream
  ) {
    return { code: 204, detail: 'No Content' };
  }

  return { code: 202, detail: 'Accepted' };
}
