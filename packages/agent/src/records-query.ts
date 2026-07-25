import type { Pagination, PaginationCursor, RecordsQueryReplyEntry } from '@enbox/dwn-sdk-js';

import { DwnConstant } from '@enbox/dwn-sdk-js';

type RecordsQueryPage = {
  cursor?: PaginationCursor;
  entries?: RecordsQueryReplyEntry[];
};

/** Reads every page of an internal Records query without issuing an unbounded request. */
export async function collectRecordsQueryEntries(
  fetchPage: (pagination: Pagination) => Promise<RecordsQueryPage>,
): Promise<RecordsQueryReplyEntry[]> {
  const entries: RecordsQueryReplyEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: PaginationCursor | undefined;

  for (;;) {
    const page = await fetchPage({
      ...(cursor === undefined ? {} : { cursor }),
      limit: DwnConstant.maxQueryPageSize,
    });
    entries.push(...page.entries ?? []);
    if (page.cursor === undefined) {
      return entries;
    }

    const cursorKey = `${page.cursor.messageCid}\u0000${page.cursor.value}`;
    if (seenCursors.has(cursorKey)) {
      throw new Error('RecordsQuery: server repeated a pagination cursor.');
    }
    seenCursors.add(cursorKey);
    cursor = page.cursor;
  }
}
