import type { MessageStore } from '../types/message-store.js';
import type { RecordsQueryReplyEntry } from '../types/records-types.js';

import { DwnErrorCode } from '../core/dwn-error.js';
import { Messages } from './messages.js';
import { RecordsWrite } from '../interfaces/records-write.js';

/**
 * Attaches each returned update's retained initial write, resolved for the whole result page in
 * one batched lookup by the stable identity `entryId === recordId` — unlike the mutable
 * latest-state index, that identity holds at every point of the record's lifecycle.
 *
 * An update whose initial write is genuinely missing (store corruption) is omitted with a
 * warning rather than failing the whole reply.
 */
export async function attachInitialWrites(input: {
  messageStore: MessageStore;
  tenant: string;
  recordsWrites: RecordsQueryReplyEntry[];
  operationName: 'RecordsQuery' | 'RecordsSubscribe';
}): Promise<RecordsQueryReplyEntry[]> {
  const updateRecordIds = new Set<string>();
  const initialWriteState = new Map<RecordsQueryReplyEntry, boolean>();
  for (const recordsWrite of input.recordsWrites) {
    const isInitialWrite = await RecordsWrite.isInitialWrite(recordsWrite);
    initialWriteState.set(recordsWrite, isInitialWrite);
    if (!isInitialWrite) {
      updateRecordIds.add(recordsWrite.recordId);
    }
  }

  if (updateRecordIds.size === 0) {
    return input.recordsWrites;
  }

  const initialWriteByRecordId = new Map<string, RecordsQueryReplyEntry>();
  const { messages } = await input.messageStore.query(input.tenant, [{ entryId: [...updateRecordIds] }]);
  for (const message of messages) {
    const initialWrite = message as RecordsQueryReplyEntry;
    initialWriteByRecordId.set(initialWrite.recordId, initialWrite);
  }

  const completeRecordsWrites: RecordsQueryReplyEntry[] = [];
  for (const recordsWrite of input.recordsWrites) {
    if (initialWriteState.get(recordsWrite) === true) {
      completeRecordsWrites.push(recordsWrite);
      continue;
    }

    const storedInitialWrite = initialWriteByRecordId.get(recordsWrite.recordId);
    if (storedInitialWrite === undefined) {
      console.warn(
        `${DwnErrorCode.RecordsWriteGetInitialWriteNotFound}: ` +
        `${input.operationName} skipped record ${recordsWrite.recordId}`,
      );
      continue;
    }

    const { message: initialWrite } = Messages.detachEncodedData(storedInitialWrite);
    completeRecordsWrites.push({ ...recordsWrite, initialWrite: initialWrite as RecordsQueryReplyEntry });
  }

  return completeRecordsWrites;
}
