import type { GenericMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { HandlerResponse, JsonRpcHandler } from '../../lib/json-rpc-router.js';

import log from 'loglevel';

import { invokeMessageProcessedHooks } from './message-processed-hooks.js';
import { requestDataBytesTotal } from '../../metrics.js';
import { Cid, DataStream, DwnError, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, RecordsWrite } from '@enbox/dwn-sdk-js';
import { createJsonRpcErrorResponse, createJsonRpcSuccessResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { enforceQuota, enforceTenantRateLimit, validateInboundDwnMessageTransport } from './inbound-message.js';

type StoredReplayState = 'complete' | 'missing-data' | 'not-stored';

export const handleDwnApplyReplicatedMessage: JsonRpcHandler = async (
  dwnRequest,
  context,
) => {
  const { dwn, dataStream } = context;
  const { ancestryOnly, encodedData, target, message } = dwnRequest.params as {
    ancestryOnly?: unknown;
    encodedData?: string;
    target: string;
    message: GenericMessage;
  };
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
    const ancestryResult = await validateAncestryOnlyRequest({
      ancestryOnly,
      hasInboundData,
      message,
      requestId,
    });
    if (ancestryResult !== undefined) {
      return ancestryResult;
    }

    const transportResult = validateInboundDwnMessageTransport({
      allowDatalessRecordsWriteOverNonHttp : ancestryOnly === true,
      allowRecordsWriteOverNonHttp         : true,
      context,
      hasEncodedData                       : encodedData !== undefined,
      message,
      requestId,
      target,
    });
    if (transportResult !== undefined) {
      return transportResult;
    }

    const rateLimitResult = enforceTenantRateLimit({ context, message, requestId, target });
    if (rateLimitResult !== undefined) {
      return rateLimitResult;
    }

    const encodedDataResult = validateEncodedData({ context, encodedData, message, requestId });
    if (encodedDataResult !== undefined) {
      return encodedDataResult;
    }

    const storedReplayState = await getStoredReplayState(context, target, message, hasInboundData);
    if (storedReplayState === 'missing-data' && await hasDifferentStoredLatestRecordState(context, target, message)) {
      await dataStream?.cancel().catch((): void => {
        // A proven obsolete replay does not need its inbound body.
      });
      return {
        jsonRpcResponse: createJsonRpcSuccessResponse(requestId, { result: { kind: 'Superseded' } }),
      };
    }

    const quotaResult = await enforceApplyReplicatedMessageQuota({
      context,
      hasInboundData,
      isFullyStoredDuplicate: storedReplayState === 'complete',
      message,
      target,
    });
    if (quotaResult !== undefined) {
      return quotaResult;
    }

    if (storedReplayState === 'missing-data') {
      await dataStream?.cancel().catch((): void => {
        // The body is unnecessary for either settled or deferred replay.
      });
      return {
        jsonRpcResponse: createJsonRpcSuccessResponse(requestId, {
          result: { kind: 'Deferred', reason: 'storage' } satisfies ReplicationApplyResult,
        }),
      };
    }

    const dataStreamForApply = getDataStreamForApply({ dataStream, encodedData, message });
    const result = await dwn.applyReplicatedMessage(target, message, {
      dataStream: dataStreamForApply,
    });
    if (result.kind === 'Duplicate') {
      await dataStreamForApply?.cancel().catch((): void => {
        // Duplicate echoes do not need their inbound body; cancellation is best-effort.
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

async function validateAncestryOnlyRequest({
  ancestryOnly,
  hasInboundData,
  message,
  requestId,
}: {
  ancestryOnly: unknown;
  hasInboundData: boolean;
  message: GenericMessage;
  requestId: Parameters<typeof createJsonRpcErrorResponse>[0];
}): Promise<HandlerResponse | undefined> {
  const descriptor = message?.descriptor as {
    dataCid?: unknown;
    dataSize?: unknown;
    interface?: unknown;
    method?: unknown;
  } | undefined;
  const isDataBearingWrite = descriptor?.interface === DwnInterfaceName.Records &&
    descriptor.method === DwnMethodName.Write &&
    typeof descriptor.dataCid === 'string' &&
    typeof descriptor.dataSize === 'number' &&
    descriptor.dataSize >= 0;

  if (ancestryOnly !== undefined && ancestryOnly !== true) {
    return invalidAncestryOnlyResponse(requestId, 'ancestryOnly must be true when present');
  }
  if (ancestryOnly === true) {
    let isInitialWrite = false;
    try {
      isInitialWrite = isDataBearingWrite && await RecordsWrite.isInitialWrite(message);
    } catch {
      // Malformed messages carrying the marker are invalid input, not server failures.
    }
    if (!isInitialWrite || hasInboundData) {
      return invalidAncestryOnlyResponse(
        requestId,
        'ancestryOnly requires a data-less initial RecordsWrite with a payload descriptor',
      );
    }
    return undefined;
  }
}

function invalidAncestryOnlyResponse(
  requestId: Parameters<typeof createJsonRpcErrorResponse>[0],
  message: string,
): HandlerResponse {
  return {
    jsonRpcResponse: createJsonRpcErrorResponse(requestId, JsonRpcErrorCodes.InvalidParams, message),
  };
}

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

function capDataStreamAtDescriptorSize(
  message: GenericMessage,
  dataStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const descriptor = message.descriptor as { dataSize?: unknown; interface?: unknown; method?: unknown };
  if (
    descriptor.interface !== DwnInterfaceName.Records ||
    descriptor.method !== DwnMethodName.Write ||
    typeof descriptor.dataSize !== 'number'
  ) {
    return dataStream;
  }

  const dataSize = descriptor.dataSize;
  const reader = dataStream.getReader();
  let bytesRead = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
        return;
      }

      bytesRead += value.length;
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
        // The caller is closing early; cancellation is best-effort.
      });
      reader.releaseLock();
    },
  });
}

async function enforceApplyReplicatedMessageQuota({
  context,
  hasInboundData,
  isFullyStoredDuplicate,
  message,
  target,
}: {
  context: Parameters<JsonRpcHandler>[1];
  hasInboundData: boolean;
  isFullyStoredDuplicate: boolean;
  message: GenericMessage;
  target: string;
}): Promise<ReturnType<typeof validateInboundDwnMessageTransport>> {
  if (isFullyStoredDuplicate) {
    return undefined;
  }

  if (
    context.config !== undefined &&
    context.adminStore !== undefined &&
    message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write
  ) {
    const storageBytesToAdd = hasInboundData
      ? (message.descriptor as { dataSize?: number }).dataSize ?? 0
      : 0;
    return enforceQuota(target, message, context, { storageBytesToAdd });
  }

  return undefined;
}

async function getStoredReplayState(
  context: Parameters<JsonRpcHandler>[1],
  target: string,
  message: GenericMessage,
  hasInboundData: boolean,
): Promise<StoredReplayState> {
  const messageCid = await Cid.computeCid(message);
  const existingMessage = await context.dwn.storage.messageStore.get(target, messageCid);
  if (existingMessage === undefined) {
    return 'not-stored';
  }

  return !hasInboundData || await storedRecordsWriteHasData(context, target, existingMessage)
    ? 'complete'
    : 'missing-data';
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

/** Whether the DWN's committed latest-state index proves that this stored data-less write is obsolete. */
async function hasDifferentStoredLatestRecordState(
  context: Parameters<JsonRpcHandler>[1],
  tenant: string,
  message: GenericMessage,
): Promise<boolean> {
  if (
    message.descriptor.interface !== DwnInterfaceName.Records ||
    message.descriptor.method !== DwnMethodName.Write
  ) {
    return false;
  }

  const recordId = (message as { recordId?: unknown }).recordId;
  if (typeof recordId !== 'string') {
    return false;
  }

  const { messages } = await context.dwn.storage.messageStore.query(tenant, [{
    interface         : DwnInterfaceName.Records,
    isLatestBaseState : true,
    recordId,
  }]);
  if (messages.length === 0) {
    return false;
  }

  const messageCid = await Cid.computeCid(message);
  return await Cid.computeCid(messages[0]) !== messageCid;
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
