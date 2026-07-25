import type { Pagination, PaginationCursor, RecordsQueryReplyEntry } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';

import { collectRecordsQueryEntries } from '../src/records-query.js';
import { DwnConstant, TestDataGenerator } from '@enbox/dwn-sdk-js';

describe('collectRecordsQueryEntries', () => {
  it('collects ordered entries while forwarding a bounded pagination cursor', async () => {
    const firstEntry = (await TestDataGenerator.generateRecordsWrite()).message;
    const secondEntry = (await TestDataGenerator.generateRecordsWrite()).message;
    const thirdEntry = (await TestDataGenerator.generateRecordsWrite()).message;
    const cursor: PaginationCursor = {
      messageCid : 'first-page-message-cid',
      value      : 'first-page-value',
    };
    const requestedPages: Pagination[] = [];

    const entries = await collectRecordsQueryEntries(async (pagination): Promise<{
      cursor?: PaginationCursor;
      entries?: RecordsQueryReplyEntry[];
    }> => {
      requestedPages.push(pagination);
      if (requestedPages.length === 1) {
        return { cursor, entries: [firstEntry, secondEntry] };
      }

      return { entries: [thirdEntry] };
    });

    expect(entries).toEqual([firstEntry, secondEntry, thirdEntry]);
    expect(requestedPages).toEqual([
      { limit: DwnConstant.maxQueryPageSize },
      { cursor, limit: DwnConstant.maxQueryPageSize },
    ]);
  });

  it('rejects a repeated cursor instead of querying forever', async () => {
    const cursor: PaginationCursor = {
      messageCid : 'repeated-message-cid',
      value      : 'repeated-value',
    };
    const requestedPages: Pagination[] = [];

    const collection = collectRecordsQueryEntries(async (pagination): Promise<{
      cursor?: PaginationCursor;
    }> => {
      requestedPages.push(pagination);
      return { cursor };
    });

    await expect(collection).rejects.toThrow('RecordsQuery: server repeated a pagination cursor.');
    expect(requestedPages).toEqual([
      { limit: DwnConstant.maxQueryPageSize },
      { cursor, limit: DwnConstant.maxQueryPageSize },
    ]);
  });

  it('rejects fresh cursor pages beyond a finite collection limit', async () => {
    let pagesRead = 0;
    const collection = collectRecordsQueryEntries(async (): Promise<{
      cursor: PaginationCursor;
    }> => {
      pagesRead += 1;
      return {
        cursor: { messageCid: `message-${pagesRead}`, value: `value-${pagesRead}` },
      };
    }, { maxEntries: 10, maxPages: 2, pageSize: 1 });

    await expect(collection).rejects.toThrow('RecordsQuery: exceeded the maximum page count of 2.');
    expect(pagesRead).toBe(2);
  });

  it('rejects a page that would exceed a finite entry limit', async () => {
    const firstEntry = (await TestDataGenerator.generateRecordsWrite()).message;
    const secondEntry = (await TestDataGenerator.generateRecordsWrite()).message;

    const collection = collectRecordsQueryEntries(async () => ({
      entries: [firstEntry, secondEntry],
    }), { maxEntries: 1, maxPages: 1, pageSize: 1 });

    await expect(collection).rejects.toThrow('RecordsQuery: exceeded the maximum entry count of 1.');
  });
});
