import type { DidResolver } from '@enbox/dids';
import type {
  GenericMessage,
  GenericMessageReply,
  ProtocolsQueryMessage,
  ProtocolsQueryReply,
  RecordsDeleteMessage,
  RecordsFilter,
  RecordsQueryMessage,
  RecordsQueryReply,
  RecordsQueryReplyEntry,
  RecordsReadMessage,
  RecordsReadReply,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import {
  authenticate,
  Cid,
  DataStream,
  DateSort,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  FilterUtility,
  Message,
  ProtocolsConfigure,
  Records,
  RecordsDelete,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';

/**
 * Verifies signed artifacts carried by a remote DWN response.
 *
 * This establishes artifact authorship, signed-field integrity, request-filter
 * membership, and record-data integrity. It cannot prove that a remote retained
 * every matching message or that a participant-authored record was admitted by
 * the target tenant; those guarantees require a tenant-authenticated feed head
 * or admission receipt.
 */
export async function verifyRemoteDwnResponse({
  didResolver,
  message,
  reply,
  targetDid,
}: {
  didResolver: DidResolver;
  message: GenericMessage;
  reply: GenericMessageReply;
  targetDid: string;
}): Promise<void> {
  const { interface: messageInterface, method } = message.descriptor;

  if (messageInterface === DwnInterfaceName.Protocols && method === DwnMethodName.Query) {
    await verifyProtocolsQueryReply({
      didResolver,
      message : message as ProtocolsQueryMessage,
      reply   : reply as ProtocolsQueryReply,
      targetDid,
    });
  } else if (messageInterface === DwnInterfaceName.Records && method === DwnMethodName.Query) {
    await verifyRecordsQueryReply({
      didResolver,
      message : message as RecordsQueryMessage,
      reply   : reply as RecordsQueryReply,
    });
  } else if (messageInterface === DwnInterfaceName.Records && method === DwnMethodName.Read) {
    await verifyRecordsReadReply({
      didResolver,
      message : message as RecordsReadMessage,
      reply   : reply as RecordsReadReply,
    });
  }

}

async function verifyProtocolsQueryReply({
  didResolver,
  message,
  reply,
  targetDid,
}: {
  didResolver: DidResolver;
  message: ProtocolsQueryMessage;
  reply: ProtocolsQueryReply;
  targetDid: string;
}): Promise<void> {
  const entries = reply.entries ?? [];
  if (reply.status.code !== 200 && entries.length > 0) {
    throw verificationError(`ProtocolsQuery response used status ${reply.status.code} with entries`);
  }

  const requestedProtocol = message.descriptor.filter?.protocol;
  if (requestedProtocol !== undefined && entries.length > 1) {
    throw verificationError(`remote returned multiple configurations for protocol '${requestedProtocol}'`);
  }

  for (const entry of entries) {
    const protocol = await ProtocolsConfigure.parse(entry);
    await authenticate(entry.authorization, didResolver);

    if (protocol.signer !== targetDid) {
      throw verificationError(
        `protocol '${entry.descriptor.definition.protocol}' was signed by '${protocol.signer ?? 'an unknown DID'}' instead of '${targetDid}'`
      );
    }
    if (requestedProtocol !== undefined && entry.descriptor.definition.protocol !== requestedProtocol) {
      throw verificationError(
        `remote returned protocol '${entry.descriptor.definition.protocol}' while '${requestedProtocol}' was requested`
      );
    }
    if (message.authorization === undefined && entry.descriptor.definition.published !== true) {
      throw verificationError(`anonymous query returned unpublished protocol '${entry.descriptor.definition.protocol}'`);
    }
  }
}

async function verifyRecordsQueryReply({
  didResolver,
  message,
  reply,
}: {
  didResolver: DidResolver;
  message: RecordsQueryMessage;
  reply: RecordsQueryReply;
}): Promise<void> {
  const entries = reply.entries ?? [];
  if (reply.status.code !== 200 && entries.length > 0) {
    throw verificationError(`RecordsQuery response used status ${reply.status.code} with entries`);
  }

  for (const entry of entries) {
    await verifyRecordsWriteEntry({
      didResolver,
      entry,
      filter        : message.descriptor.filter,
      dateSort      : message.descriptor.dateSort,
      publishedOnly : message.authorization === undefined,
    });
  }
}

async function verifyRecordsReadReply({
  didResolver,
  message,
  reply,
}: {
  didResolver: DidResolver;
  message: RecordsReadMessage;
  reply: RecordsReadReply;
}): Promise<void> {
  const entry = reply.entry;
  if (entry === undefined) {
    if (reply.status.code === 200) {
      throw verificationError('successful RecordsRead response did not contain an entry');
    }
    return;
  }

  if (entry.recordsWrite !== undefined && entry.recordsDelete === undefined) {
    await verifyRecordsWriteReadEntry({
      didResolver,
      entry,
      message,
      recordsWriteMessage: entry.recordsWrite,
      reply,
    });
    return;
  }

  if (entry.recordsDelete !== undefined && entry.recordsWrite === undefined) {
    await verifyRecordsDeleteReadEntry({
      didResolver,
      entry,
      message,
      recordsDeleteMessage: entry.recordsDelete,
      reply,
    });
    return;
  }

  throw verificationError('RecordsRead entry must contain exactly one RecordsWrite or RecordsDelete');
}

async function verifyRecordsWriteReadEntry({
  didResolver,
  entry,
  message,
  recordsWriteMessage,
  reply,
}: {
  didResolver: DidResolver;
  entry: NonNullable<RecordsReadReply['entry']>;
  message: RecordsReadMessage;
  recordsWriteMessage: RecordsWriteMessage;
  reply: RecordsReadReply;
}): Promise<void> {
  const recordsWriteEntry: RecordsQueryReplyEntry = {
    ...recordsWriteMessage,
    ...(entry.initialWrite === undefined ? {} : { initialWrite: entry.initialWrite }),
  };
  const recordsWrite = await verifyRecordsWriteEntry({
    allowMissingInitialWrite : reply.status.code === 410,
    dateSort                 : message.descriptor.dateSort,
    didResolver,
    entry                    : recordsWriteEntry,
    filter                   : message.descriptor.filter,
  });

  if (reply.status.code === 410) {
    if (entry.data !== undefined) {
      throw verificationError(`unavailable RecordsRead response for '${recordsWrite.message.recordId}' contained record data`);
    }
    return;
  }
  if (reply.status.code !== 200) {
    throw verificationError(
      `RecordsRead response for '${recordsWrite.message.recordId}' used status ${reply.status.code} with a RecordsWrite entry`
    );
  }
  if (entry.data === undefined) {
    throw verificationError(`RecordsRead response for '${recordsWrite.message.recordId}' did not contain record data`);
  }

  entry.data = DataStream.fromAsyncIterable(verifyDataStream(entry.data, recordsWrite.message));
}

async function verifyRecordsDeleteReadEntry({
  didResolver,
  entry,
  message,
  recordsDeleteMessage,
  reply,
}: {
  didResolver: DidResolver;
  entry: NonNullable<RecordsReadReply['entry']>;
  message: RecordsReadMessage;
  recordsDeleteMessage: RecordsDeleteMessage;
  reply: RecordsReadReply;
}): Promise<void> {
  if (entry.initialWrite === undefined) {
    throw verificationError('RecordsRead response containing a RecordsDelete did not include its initial RecordsWrite');
  }
  if (entry.data !== undefined) {
    throw verificationError('RecordsRead response containing a RecordsDelete also contained record data');
  }
  if (reply.status.code !== 404) {
    throw verificationError(`RecordsRead response used status ${reply.status.code} with a RecordsDelete entry`);
  }

  const recordsDelete = await verifyRecordsDelete(recordsDeleteMessage, didResolver);
  const initialWrite = await verifyInitialWrite(entry.initialWrite, didResolver);
  if (recordsDelete.message.descriptor.recordId !== initialWrite.message.recordId) {
    throw verificationError(
      `RecordsDelete for '${recordsDelete.message.descriptor.recordId}' was paired with initial write '${initialWrite.message.recordId}'`
    );
  }

  assertDeleteFilterVerifiable(message);
  const indexes = recordsDelete.constructIndexes(initialWrite.message, initialWrite.message);
  if (!FilterUtility.matchFilter(indexes, Records.convertFilter(message.descriptor.filter))) {
    throw verificationError(`RecordsDelete '${recordsDelete.message.descriptor.recordId}' does not match the RecordsRead filter`);
  }
}

async function verifyRecordsWriteEntry({
  didResolver,
  entry,
  filter,
  dateSort,
  publishedOnly = false,
  allowMissingInitialWrite = false,
}: {
  didResolver: DidResolver;
  entry: RecordsQueryReplyEntry;
  filter: RecordsFilter;
  dateSort?: RecordsQueryMessage['descriptor']['dateSort'];
  publishedOnly?: boolean;
  allowMissingInitialWrite?: boolean;
}): Promise<RecordsWrite> {
  const recordsWrite = await verifyRecordsWrite(entry, didResolver);
  await verifyInitialWriteAttachment({ allowMissingInitialWrite, didResolver, entry, recordsWrite });

  const indexes = await recordsWrite.constructIndexes(true);
  if (!FilterUtility.matchFilter(indexes, Records.convertFilter(filter, dateSort))) {
    throw verificationError(`RecordsWrite '${entry.recordId}' does not match the request filter`);
  }
  if (publishedOnly && recordsWrite.message.descriptor.published !== true) {
    throw verificationError(`anonymous query returned unpublished RecordsWrite '${entry.recordId}'`);
  }

  if (entry.encodedData !== undefined) {
    await verifyDataBytes(Encoder.base64UrlToBytes(entry.encodedData), recordsWrite.message);
  }

  return recordsWrite;
}

async function verifyInitialWriteAttachment({
  allowMissingInitialWrite,
  didResolver,
  entry,
  recordsWrite,
}: {
  allowMissingInitialWrite: boolean;
  didResolver: DidResolver;
  entry: RecordsQueryReplyEntry;
  recordsWrite: RecordsWrite;
}): Promise<void> {
  if (await recordsWrite.isInitialWrite()) {
    if (entry.initialWrite !== undefined) {
      throw verificationError(`initial RecordsWrite '${entry.recordId}' contained a redundant initialWrite attachment`);
    }
    return;
  }

  if (entry.initialWrite === undefined) {
    if (allowMissingInitialWrite) {
      return;
    }
    throw verificationError(`updated RecordsWrite '${entry.recordId}' did not include its initial write`);
  }

  const initialWrite = await verifyInitialWrite(entry.initialWrite, didResolver);
  if (initialWrite.message.recordId !== recordsWrite.message.recordId ||
      initialWrite.message.contextId !== recordsWrite.message.contextId) {
    throw verificationError(`updated RecordsWrite '${entry.recordId}' does not match its attached initial write`);
  }
  RecordsWrite.verifyEqualityOfImmutableProperties(initialWrite.message, recordsWrite.message);
}

async function verifyRecordsWrite(message: RecordsWriteMessage, didResolver: DidResolver): Promise<RecordsWrite> {
  const recordsWrite = await RecordsWrite.parse(message);
  await authenticate(recordsWrite.message.authorization, didResolver, recordsWrite.message.attestation);
  return recordsWrite;
}

async function verifyInitialWrite(message: RecordsWriteMessage, didResolver: DidResolver): Promise<RecordsWrite> {
  const initialWrite = await verifyRecordsWrite(message, didResolver);
  if (!await initialWrite.isInitialWrite()) {
    throw verificationError(`attached initial write for '${message.recordId}' is not an initial RecordsWrite`);
  }
  return initialWrite;
}

async function verifyRecordsDelete(message: RecordsDeleteMessage, didResolver: DidResolver): Promise<RecordsDelete> {
  Message.validateJsonSchema(message);
  const recordsDelete = await RecordsDelete.parse(message);
  await authenticate(recordsDelete.message.authorization, didResolver);
  return recordsDelete;
}

async function verifyDataBytes(data: Uint8Array, recordsWrite: RecordsWriteMessage): Promise<void> {
  const dataCid = await Cid.computeDagPbCidFromBytes(data);
  RecordsWrite.validateDataIntegrity(
    recordsWrite.descriptor.dataCid,
    recordsWrite.descriptor.dataSize,
    dataCid,
    data.byteLength,
  );
}

/** Verifies streamed bytes as they are consumed, before allowing a successful end-of-stream. */
async function* verifyDataStream(
  source: ReadableStream<Uint8Array>,
  recordsWrite: RecordsWriteMessage,
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  const hashingStream = new TransformStream<Uint8Array, Uint8Array>();
  const hashWriter = hashingStream.writable.getWriter();
  const dataCidPromise = Cid.computeDagPbCidFromStream(hashingStream.readable);
  let dataSize = 0;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      dataSize += value.byteLength;
      if (dataSize > recordsWrite.descriptor.dataSize) {
        RecordsWrite.validateDataIntegrity(
          recordsWrite.descriptor.dataCid,
          recordsWrite.descriptor.dataSize,
          recordsWrite.descriptor.dataCid,
          dataSize,
        );
      }

      await hashWriter.write(value);
      yield value;
    }

    await hashWriter.close();
    const dataCid = await dataCidPromise;
    RecordsWrite.validateDataIntegrity(
      recordsWrite.descriptor.dataCid,
      recordsWrite.descriptor.dataSize,
      dataCid,
      dataSize,
    );
    completed = true;
  } finally {
    if (!completed) {
      await Promise.allSettled([reader.cancel(), hashWriter.abort()]);
      void dataCidPromise.catch((): void => {});
    }
    reader.releaseLock();
    hashWriter.releaseLock();
  }
}

/** Rejects tombstones that cannot be bound to the request without the deleted record's last write. */
function assertDeleteFilterVerifiable(message: RecordsReadMessage): void {
  if (message.descriptor.dateSort === DateSort.PublishedAscending ||
      message.descriptor.dateSort === DateSort.PublishedDescending) {
    throw verificationError('RecordsDelete cannot be authenticated against a published date sort without its last RecordsWrite');
  }

  const unverifiableProperties: (keyof RecordsFilter)[] = [
    'attester',
    'dataCid',
    'dataFormat',
    'dataSize',
    'datePublished',
    'published',
    'tags',
  ];
  const property = unverifiableProperties.find((name) => message.descriptor.filter[name] !== undefined);

  if (property !== undefined) {
    throw verificationError('RecordsDelete cannot be authenticated against a filter that depends on its last RecordsWrite');
  }
}

function verificationError(detail: string): Error {
  return new Error(`Remote DWN response verification failed: ${detail}.`);
}
