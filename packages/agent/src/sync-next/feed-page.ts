import type {
  GenericMessage,
  MessagesQueryReply,
  MessagesQueryReplyEntry,
  ProgressToken,
} from '@enbox/dwn-sdk-js';

import type { SyncNextSourceReceipt } from './types.js';

import { Message } from '@enbox/dwn-sdk-js';

import { compareSyncNextPosition, isValidSyncNextToken } from './ledger-key.js';

export const SYNC_NEXT_PAGE_SIZE = 100;

/** Successful transport whose remote feed operation returned a non-success status. */
export class SyncNextFeedQueryError extends Error {
  public constructor(
    public readonly statusCode: number,
    detail: string,
  ) {
    super(detail);
    this.name = 'SyncNextFeedQueryError';
  }
}

export type SyncNextPreparedFeedEntry = {
  entry: MessagesQueryReplyEntry;
  message: GenericMessage;
  receipt: SyncNextSourceReceipt;
};

export type SyncNextPreparedFeedPage = {
  drained: boolean;
  entries: SyncNextPreparedFeedEntry[];
  handledThrough: ProgressToken;
  pageReceipts: SyncNextSourceReceipt[];
};

/** Return a safely checkpointable prefix, or no page when no entry was handled. */
export function sliceSyncNextFeedPage(
  page: SyncNextPreparedFeedPage,
  entryCount: number,
): SyncNextPreparedFeedPage | undefined {
  if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > page.entries.length) {
    throw new RangeError('SyncNextFeedPage: handled entry count is outside the prepared page.');
  }
  if (entryCount === page.entries.length) {
    return page;
  }
  if (entryCount === 0) {
    return undefined;
  }

  const entries = page.entries.slice(0, entryCount);
  const pageReceipts = page.pageReceipts.slice(0, entryCount);
  return {
    drained        : false,
    entries,
    handledThrough : pageReceipts[entryCount - 1].source,
    pageReceipts,
  };
}

/** Validate one feed page and bind every verified message to its exact source receipt. */
export async function prepareSyncNextFeedPage({
  label,
  previous,
  reply,
  target,
}: {
  label: string;
  previous?: ProgressToken;
  reply: MessagesQueryReply;
  target: string;
}): Promise<SyncNextPreparedFeedPage> {
  const { drained, entries } = successfulPage(reply, label, target);
  const handledThrough = reply.cursor;
  if (handledThrough === undefined) {
    throw new Error(`${label}: ${target} returned no cursor for a successful page.`);
  }
  assertCursorProgress(previous, handledThrough, drained, entries.length, label);

  const positions = new Set<string>();
  const preparedEntries: SyncNextPreparedFeedEntry[] = [];
  const pageReceipts: SyncNextSourceReceipt[] = [];
  for (const entry of entries) {
    const receipt = sourceReceipt(previous, handledThrough, entry, positions, label);
    const priorReceipt = pageReceipts.at(-1);
    if (priorReceipt !== undefined && compareSyncNextPosition(receipt.source, priorReceipt.source) <= 0) {
      throw new Error(`${label}: feed entries are not in ascending source order.`);
    }
    const message = entry.message;
    if (message === undefined || await Message.getCid(message) !== entry.messageCid) {
      throw new Error(`${label}: feed entry ${entry.messageCid} failed CID verification.`);
    }
    pageReceipts.push(receipt);
    preparedEntries.push({ entry, message, receipt });
  }
  assertCursorReceipt(previous, handledThrough, pageReceipts, label);

  return { drained, entries: preparedEntries, handledThrough, pageReceipts };
}

function successfulPage(
  reply: MessagesQueryReply,
  label: string,
  target: string,
): { drained: boolean; entries: MessagesQueryReplyEntry[] } {
  if (reply.status.code !== 200) {
    throw new SyncNextFeedQueryError(
      reply.status.code,
      `${label}: ${target} failed: ${reply.status.code} ${reply.status.detail}`,
    );
  }
  if (!Array.isArray(reply.entries)) {
    throw new TypeError(`${label}: successful query omitted its entries array.`);
  }
  if (typeof reply.drained !== 'boolean') {
    throw new TypeError(`${label}: successful query requires a boolean drained value.`);
  }
  if (reply.entries.length > SYNC_NEXT_PAGE_SIZE) {
    throw new RangeError(
      `${label}: query returned ${reply.entries.length} entries; maximum is ${SYNC_NEXT_PAGE_SIZE}.`,
    );
  }
  return { drained: reply.drained, entries: reply.entries };
}

function sourceReceipt(
  previous: ProgressToken | undefined,
  cursor: ProgressToken,
  entry: MessagesQueryReplyEntry,
  positions: Set<string>,
  label: string,
): SyncNextSourceReceipt {
  if (
    typeof entry.messageCid !== 'string' ||
    typeof entry.seq !== 'string' ||
    typeof entry.isLatestBaseState !== 'boolean'
  ) {
    throw new TypeError(`${label}: feed entry has invalid source metadata.`);
  }
  const source: ProgressToken = {
    epoch      : cursor.epoch,
    messageCid : entry.messageCid,
    position   : entry.seq,
    streamId   : cursor.streamId,
  };
  if (!isValidSyncNextToken(source) || compareSyncNextPosition(source, cursor) > 0) {
    throw new Error(`${label}: feed entry ${entry.messageCid} has an invalid source position.`);
  }
  if (previous !== undefined && compareSyncNextPosition(source, previous) <= 0) {
    throw new Error(`${label}: feed entry ${entry.messageCid} is behind its checkpoint.`);
  }
  if (positions.has(entry.seq)) {
    throw new Error(`${label}: feed page repeats source position ${entry.seq}.`);
  }
  positions.add(entry.seq);
  return { messageCid: entry.messageCid, source };
}

function assertCursorReceipt(
  previous: ProgressToken | undefined,
  cursor: ProgressToken,
  pageReceipts: readonly SyncNextSourceReceipt[],
  label: string,
): void {
  if (previous !== undefined && sameProgressToken(previous, cursor) && pageReceipts.length === 0) {
    return;
  }
  if (cursor.messageCid !== undefined && !pageReceipts.some(receipt =>
    receipt.source.position === cursor.position && receipt.messageCid === cursor.messageCid
  )) {
    throw new Error(`${label}: query cursor CID does not identify its page entry.`);
  }
}

function sameProgressToken(left: ProgressToken, right: ProgressToken): boolean {
  return left.streamId === right.streamId && left.epoch === right.epoch &&
    left.position === right.position && left.messageCid === right.messageCid;
}

function assertCursorProgress(
  previous: ProgressToken | undefined,
  next: ProgressToken,
  drained: boolean,
  entryCount: number,
  label: string,
): void {
  if (!isValidSyncNextToken(next)) {
    throw new Error(`${label}: query returned an invalid cursor.`);
  }
  if (previous === undefined) {
    return;
  }
  if (previous.streamId !== next.streamId || previous.epoch !== next.epoch) {
    throw new Error(`${label}: query cursor changed progress-token domain.`);
  }
  const comparison = compareSyncNextPosition(next, previous);
  if (comparison < 0) {
    throw new Error(`${label}: query cursor regressed.`);
  }
  if (comparison === 0 && (!drained || entryCount > 0)) {
    throw new Error(`${label}: query cursor did not advance.`);
  }
}
