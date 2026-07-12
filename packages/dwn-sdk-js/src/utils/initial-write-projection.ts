import type { MessageStore } from '../types/message-store.js';
import type { Pagination } from '../types/message-types.js';
import type { PaginationCursor } from '../types/query-types.js';
import type { RecordsQueryReplyEntry } from '../types/records-types.js';

import { DwnErrorCode } from '../core/dwn-error.js';
import { Message } from '../core/message.js';
import { Messages } from './messages.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type RecordsPage = {
  messages: RecordsQueryReplyEntry[];
  cursor?: PaginationCursor;
};

type InitialWriteProjectionInput = {
  messageStore: MessageStore;
  tenant: string;
  recordsWrites: RecordsQueryReplyEntry[];
  operationName: 'RecordsCount' | 'RecordsQuery' | 'RecordsSubscribe';
  warnedRecordIds?: Set<string>;
};

type PaginatedInitialWriteProjectionInput = Omit<InitialWriteProjectionInput, 'recordsWrites'> & {
  pagination?: Pagination;
  queryPage(pagination?: Pagination): Promise<RecordsPage>;
};

/**
 * Projects raw latest-state candidates to one newest complete write per record.
 * Updates receive their retained initial write and are omitted when it is missing.
 */
export async function attachInitialWritesAndFilterIncompleteRecords(
  input: InitialWriteProjectionInput
): Promise<RecordsQueryReplyEntry[]> {
  const candidateRecordIds = [...new Set(input.recordsWrites.map(recordsWrite => recordsWrite.recordId))];
  const newestLatestWriteByRecordId = new Map<string, RecordsQueryReplyEntry>();
  if (candidateRecordIds.length > 0) {
    // A page can be read after an update is inserted but before the retained
    // initial write is demoted. Revalidate across the whole latest-state index
    // so the stale initial cannot occupy an earlier sort or cursor position.
    const { messages } = await input.messageStore.query(input.tenant, [{
      recordId          : candidateRecordIds,
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
    }]);
    for (const message of messages) {
      const recordsWrite = message as RecordsQueryReplyEntry;
      const existing = newestLatestWriteByRecordId.get(recordsWrite.recordId);
      if (existing === undefined || await Message.isNewer(recordsWrite, existing)) {
        newestLatestWriteByRecordId.set(recordsWrite.recordId, recordsWrite);
      }
    }
  }

  const latestRecordsWrites: Array<{ index: number, recordsWrite: RecordsQueryReplyEntry }> = [];
  for (let index = 0; index < input.recordsWrites.length; index++) {
    const recordsWrite = input.recordsWrites[index];
    const newestLatestWrite = newestLatestWriteByRecordId.get(recordsWrite.recordId);
    if (newestLatestWrite === undefined || !await Message.isNewer(newestLatestWrite, recordsWrite)) {
      latestRecordsWrites.push({ index, recordsWrite });
    }
  }

  const initialWriteByRecordId = new Map<string, RecordsQueryReplyEntry>();
  const initialWriteState = new Map<RecordsQueryReplyEntry, boolean>();
  const updateRecordIds = new Set<string>();

  for (const { recordsWrite } of latestRecordsWrites) {
    const isInitialWrite = await RecordsWrite.isInitialWrite(recordsWrite);
    initialWriteState.set(recordsWrite, isInitialWrite);
    if (!isInitialWrite) {
      updateRecordIds.add(recordsWrite.recordId);
    }
  }

  if (updateRecordIds.size > 0) {
    // `entryId === recordId` is the stable identity of the initial write. In
    // particular, it remains true while an update is changing latest-state indexes.
    const { messages } = await input.messageStore.query(input.tenant, [{ entryId: [...updateRecordIds] }]);
    for (const message of messages) {
      const initialWrite = message as RecordsQueryReplyEntry;
      initialWriteByRecordId.set(initialWrite.recordId, initialWrite);
    }
  }

  const warnedRecordIds = input.warnedRecordIds ?? new Set<string>();
  const completeRecordsWriteById = new Map<string, { index: number, recordsWrite: RecordsQueryReplyEntry }>();
  for (const { index, recordsWrite } of latestRecordsWrites) {
    let completeRecordsWrite = recordsWrite;
    if (initialWriteState.get(recordsWrite) === false) {
      const storedInitialWrite = initialWriteByRecordId.get(recordsWrite.recordId);
      if (storedInitialWrite === undefined) {
        if (!warnedRecordIds.has(recordsWrite.recordId)) {
          console.warn(
            `${DwnErrorCode.RecordsWriteGetInitialWriteNotFound}: ` +
            `${input.operationName} skipped record ${recordsWrite.recordId}`,
          );
          warnedRecordIds.add(recordsWrite.recordId);
        }
        continue;
      }

      const { message: initialWrite } = Messages.detachEncodedData(storedInitialWrite);
      completeRecordsWrite = { ...recordsWrite, initialWrite: initialWrite as RecordsQueryReplyEntry };
    }

    const existing = completeRecordsWriteById.get(recordsWrite.recordId);
    if (existing === undefined) {
      completeRecordsWriteById.set(recordsWrite.recordId, { index, recordsWrite: completeRecordsWrite });
    } else if (await Message.isNewer(completeRecordsWrite, existing.recordsWrite)) {
      completeRecordsWriteById.set(recordsWrite.recordId, { index, recordsWrite: completeRecordsWrite });
    }
  }

  return [...completeRecordsWriteById.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ recordsWrite }) => recordsWrite);
}

/**
 * Applies initial-write completeness as a paginated projection. When incomplete
 * rows are omitted, subsequent store pages are scanned until the requested page
 * is full or the underlying query is drained.
 */
export async function queryRecordsWithInitialWriteProjection(
  input: PaginatedInitialWriteProjectionInput
): Promise<RecordsPage> {
  const { pagination } = input;
  if (pagination?.limit === undefined || pagination.limit <= 0) {
    const result = await input.queryPage(pagination);
    return {
      messages: await attachInitialWritesAndFilterIncompleteRecords({
        messageStore  : input.messageStore,
        tenant        : input.tenant,
        recordsWrites : result.messages,
        operationName : input.operationName,
      }),
      cursor: result.cursor,
    };
  }

  const completeRecordsWriteById = new Map<string, { sequence: number, recordsWrite: RecordsQueryReplyEntry }>();
  const warnedRecordIds = new Set<string>();
  let sequence = 0;
  let cursor = pagination.cursor;
  let nextCursor: PaginationCursor | undefined;

  do {
    const remainingLimit = pagination.limit - completeRecordsWriteById.size;
    const result = await input.queryPage({
      ...pagination,
      cursor,
      limit: remainingLimit,
    });
    const pageRecordsWrites = await attachInitialWritesAndFilterIncompleteRecords({
      messageStore  : input.messageStore,
      tenant        : input.tenant,
      recordsWrites : result.messages,
      operationName : input.operationName,
      warnedRecordIds,
    });
    for (const recordsWrite of pageRecordsWrites) {
      const existing = completeRecordsWriteById.get(recordsWrite.recordId);
      if (existing === undefined || await Message.isNewer(recordsWrite, existing.recordsWrite)) {
        completeRecordsWriteById.set(recordsWrite.recordId, { sequence, recordsWrite });
      }
      sequence++;
    }
    nextCursor = result.cursor;
    cursor = result.cursor;
  } while (completeRecordsWriteById.size < pagination.limit && cursor !== undefined);

  const messages = [...completeRecordsWriteById.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(({ recordsWrite }) => recordsWrite);
  return { messages, cursor: nextCursor };
}
