import type { Pagination, PaginationCursor, RecordsQueryReplyEntry } from '@enbox/dwn-sdk-js';

import { DwnConstant } from '@enbox/dwn-sdk-js';

type RecordsQueryPage = {
  cursor?: PaginationCursor;
  entries?: RecordsQueryReplyEntry[];
};

export type RecordsQueryCollectionLimits = {
  maxEntries: number;
  maxPages: number;
  pageSize: number;
};

type RecordsQueryCollectionLimitsInput = RecordsQueryCollectionLimits | (() => RecordsQueryCollectionLimits | undefined);

/** Finite collection limits for Records queries answered by an untrusted remote DWN. */
export const remoteRecordsQueryCollectionLimits: RecordsQueryCollectionLimits = {
  maxEntries : DwnConstant.maxQueryPageSize,
  maxPages   : Math.ceil(DwnConstant.maxQueryPageSize / DwnConstant.defaultQueryPageSize),
  pageSize   : DwnConstant.defaultQueryPageSize,
};

/** Reads every page of an internal Records query, optionally within a finite collection limit. */
export async function collectRecordsQueryEntries(
  fetchPage: (pagination: Pagination) => Promise<RecordsQueryPage>,
  limitsInput?: RecordsQueryCollectionLimitsInput,
): Promise<RecordsQueryReplyEntry[]> {
  const entries: RecordsQueryReplyEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: PaginationCursor | undefined;
  let pagesRead = 0;

  for (;;) {
    const requestLimits = typeof limitsInput === 'function' ? limitsInput() : limitsInput;
    if (requestLimits !== undefined && pagesRead >= requestLimits.maxPages) {
      throw new Error(`RecordsQuery: exceeded the maximum page count of ${requestLimits.maxPages}.`);
    }
    const page = await fetchPage({
      ...(cursor === undefined ? {} : { cursor }),
      limit: requestLimits?.pageSize ?? DwnConstant.maxQueryPageSize,
    });
    pagesRead += 1;

    // A source-selection callback may learn during the fetch that this page
    // came from a trusted local store rather than an untrusted remote DWN.
    const responseLimits = typeof limitsInput === 'function' ? limitsInput() : limitsInput;
    const pageEntries = page.entries ?? [];
    if (responseLimits !== undefined && pageEntries.length > responseLimits.maxEntries - entries.length) {
      throw new Error(`RecordsQuery: exceeded the maximum entry count of ${responseLimits.maxEntries}.`);
    }
    entries.push(...pageEntries);
    if (page.cursor === undefined) {
      return entries;
    }
    if (responseLimits !== undefined && entries.length >= responseLimits.maxEntries) {
      throw new Error(`RecordsQuery: exceeded the maximum entry count of ${responseLimits.maxEntries}.`);
    }

    const cursorKey = `${page.cursor.messageCid}\u0000${page.cursor.value}`;
    if (seenCursors.has(cursorKey)) {
      throw new Error('RecordsQuery: server repeated a pagination cursor.');
    }
    seenCursors.add(cursorKey);
    cursor = page.cursor;
  }
}
