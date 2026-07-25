import type { JsonRpcHandler } from '../../lib/json-rpc-router.js';
import type { GenericMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import log from 'loglevel';

import { invokeMessageProcessedHooks } from './message-processed-hooks.js';
import { requestDataBytesTotal } from '../../metrics.js';
import { requiresTenantQuotaEnforcement } from '../../tenant-quota.js';
import {
  capDataStreamAtDescriptorSize,
  enforceQuota,
  enforceRecordDataSizeLimit,
  enforceRecordsWriteDataSizeLimit,
  enforceTenantRateLimit,
  validateInboundDwnMessageTransport,
} from './inbound-message.js';
import { Cid, DataStream, DwnInterfaceName, DwnMethodName, Encoder, Records } from '@enbox/dwn-sdk-js';
import { createJsonRpcErrorResponse, createJsonRpcSuccessResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';

export const handleDwnApplyReplicatedMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream } = context;
  const { encodedData, target, message } = dwnRequest.params as { encodedData?: string, target: string, message: GenericMessage };
  const requestId = dwnRequest.id ?? crypto.randomUUID();
  if ((message as { encodedData?: unknown }).encodedData !== undefined) {
    return {
      jsonRpcResponse: createJsonRpcErrorResponse(
        requestId,
        JsonRpcErrorCodes.InvalidParams,
        'message.encodedData is not supported; use params.encodedData',
      ),
    };
  }
  const hasInboundData = encodedData !== undefined || dataStream !== undefined;

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

    const limitsResult = await enforceApplyReplicatedMessageLimits({
      context,
      hasInboundData,
      message,
      requestId,
      target,
    });
    if (limitsResult !== undefined) {
      return limitsResult;
    }

    const encodedDataResult = validateEncodedData({ context, encodedData, message, requestId });
    if (encodedDataResult !== undefined) {
      return encodedDataResult;
    }

    if (hasInboundData && await isStoredRecordsWriteMissingData(context, target, message)) {
      await dataStream?.cancel().catch((): void => {
        // The fetch-first replication contract does not support same-CID
        // hydration; cancellation is best-effort before deferring the replay.
      });
      return {
        jsonRpcResponse: createJsonRpcSuccessResponse(requestId, {
          result: { kind: 'Deferred', reason: 'storage' } satisfies ReplicationApplyResult,
        }),
      };
    }

    const dataStreamForApply = getDataStreamForApply({ dataStream, encodedData, message });
    let result: ReplicationApplyResult;
    try {
      result = await dwn.applyReplicatedMessage(target, message, {
        dataStream: dataStreamForApply,
      });
    } finally {
      await dataStreamForApply?.cancel().catch((): void => {
        // Rejected and duplicate messages may leave their request body unread; cancellation is best-effort.
      });
    }
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

function getDataStreamForApply({
  dataStream,
  encodedData,
  message,
}: {
  dataStream: ReadableStream<Uint8Array> | undefined;
  encodedData: string | undefined;
  message: GenericMessage;
}): ReadableStream<Uint8Array> | undefined {
  if (encodedData !== undefined) {
    return DataStream.fromBytes(Encoder.base64UrlToBytes(encodedData));
  }

  if (dataStream === undefined) {
    return undefined;
  }

  return capDataStreamAtDescriptorSize(message, dataStream);
}

async function enforceApplyReplicatedMessageLimits({
  context,
  hasInboundData,
  message,
  requestId,
  target,
}: {
  context: Parameters<JsonRpcHandler>[1];
  hasInboundData: boolean;
  message: GenericMessage;
  requestId: Parameters<typeof createJsonRpcErrorResponse>[0];
  target: string;
}): Promise<ReturnType<typeof validateInboundDwnMessageTransport>> {
  const rateLimitResult = enforceTenantRateLimit({ context, message, requestId, target });
  if (rateLimitResult !== undefined) {
    return rateLimitResult;
  }

  const dataSizeResult = enforceRecordsWriteDataSizeLimit({ context, hasInboundData, message, requestId });
  if (dataSizeResult !== undefined) {
    if (await isFullyStoredDuplicate({ context, hasInboundData, message, target })) {
      const result = { kind: 'Duplicate' } satisfies ReplicationApplyResult;
      await context.dataStream?.cancel().catch((): void => {
        // The stored message already has its data; the supplied body is unnecessary.
      });
      recordApplyActivity(target, message, result, context);
      return {
        jsonRpcResponse: createJsonRpcSuccessResponse(requestId, { result }),
      };
    }
    return dataSizeResult;
  }

  if (context.config !== undefined && requiresTenantQuotaEnforcement(message)) {
    const storageBytesToAdd = hasInboundData && Records.isRecordsWrite(message)
      ? (message.descriptor as { dataSize?: number }).dataSize ?? 0
      : 0;
    return enforceQuota(target, message, requestId, context, { storageBytesToAdd });
  }

  return undefined;
}

async function isFullyStoredDuplicate({
  context,
  hasInboundData,
  message,
  target,
}: {
  context: Parameters<JsonRpcHandler>[1];
  hasInboundData: boolean;
  message: GenericMessage;
  target: string;
}): Promise<boolean> {
  const messageCid = await Cid.computeCid(message);
  const existingMessage = await context.dwn.storage.messageStore.get(target, messageCid);
  if (existingMessage === undefined) {
    return false;
  }

  if (!hasInboundData) {
    return true;
  }

  return await storedRecordsWriteHasData(context, target, existingMessage);
}

async function storedRecordsWriteHasData(
  context: Parameters<JsonRpcHandler>[1],
  tenant: string,
  message: GenericMessage,
): Promise<boolean> {
  const descriptor = message.descriptor as {
    dataCid?: unknown;
    dataSize?: unknown;
    interface?: unknown;
    method?: unknown;
  };
  if (
    descriptor.interface !== DwnInterfaceName.Records ||
    descriptor.method !== DwnMethodName.Write ||
    typeof descriptor.dataSize !== 'number' ||
    descriptor.dataSize <= 0
  ) {
    return true;
  }

  if (typeof (message as { encodedData?: unknown }).encodedData === 'string') {
    return true;
  }

  const recordId = (message as { recordId?: unknown }).recordId;
  if (typeof recordId !== 'string' || typeof descriptor.dataCid !== 'string') {
    return false;
  }

  const storedData = await context.dwn.storage.dataStore.get(tenant, recordId, descriptor.dataCid);
  await storedData?.dataStream.cancel().catch((): void => {
    // The existence probe is enough; cancellation is best-effort.
  });
  return storedData !== undefined;
}

async function isStoredRecordsWriteMissingData(
  context: Parameters<JsonRpcHandler>[1],
  tenant: string,
  message: GenericMessage,
): Promise<boolean> {
  const messageCid = await Cid.computeCid(message);
  const existingMessage = await context.dwn.storage.messageStore.get(tenant, messageCid);
  return existingMessage !== undefined &&
    !await storedRecordsWriteHasData(context, tenant, existingMessage);
}

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

  return enforceRecordDataSizeLimit({ context, dataSize: decodedLength, requestId });
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
    const charCode = encodedData.codePointAt(i);
    if (charCode === undefined || !isBase64UrlCharCode(charCode)) {
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
