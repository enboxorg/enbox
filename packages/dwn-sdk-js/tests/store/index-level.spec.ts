import type { CompoundIndexDefinition } from '../../src/store/index-level.js';
import type { Filter } from '../../src/types/query-types.js';
import type { IndexedItem } from '../../src/store/index-level.js';

import { ArrayUtility } from '../../src/utils/array.js';
import { createLevelDatabase } from '../../src/store/level-wrapper.js';
import { DwnErrorCode } from '../../src/index.js';
import { IndexLevel } from '../../src/store/index-level.js';
import { lexicographicalCompare } from '../../src/utils/string.js';
import { SortDirection } from '../../src/types/query-types.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { v4 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

describe('IndexLevel', () => {
  let testIndex: IndexLevel;
  const tenant = 'did:alice:index-test';

  describe('put', () => {
    beforeAll(async () => {
      testIndex = new IndexLevel({
        createLevelDatabase,
        location: 'TEST-INDEX',
      });
      await testIndex.open();
    });

    beforeEach(async () => {
      await testIndex.clear();
    });

    afterAll(async () => {
      await testIndex.close();
    });

    describe('fails to index with no indexable properties', () => {
      it('fails on empty indexes', async () => {
        const id = uuid();
        const failedIndexPromise = testIndex.put(tenant, id, {});
        await expect(failedIndexPromise).rejects.toThrow(DwnErrorCode.IndexMissingIndexableProperty);
      });
    });

    it('successfully indexes', async () => {
      const id = uuid();
      await testIndex.put(tenant, id, {
        id,
        foo    : 'foo',
        digit  : 12,
        toggle : false,
        tag    : ['bar', 'baz']
      });
      const results = await testIndex.query(tenant, [{ id: id }], { sortProperty: 'id' });
      expect(results[0].messageCid).toBe(id);
    });

    it('adds one index key per property value, aside from id', async () => {
      const id = uuid(); // 1 key for reverse lookup
      const dateCreated = new Date().toISOString();

      await testIndex.put(tenant, id, {
        'a' : 'b', // 1 key
        'c' : ['d', 'e'], // 2 key
        dateCreated, // 1 key
      });

      let keys = await ArrayUtility.fromAsyncGenerator(testIndex.db.keys());
      expect(keys).toHaveLength(5);

      await testIndex.clear();

      await testIndex.put(tenant, id, {
        'a' : 'b', // 1 key
        'c' : ['d', 'e'], // 2 keys
        'f' : 'g', // 1 key
        dateCreated, // 1 key
      });
      keys = await ArrayUtility.fromAsyncGenerator(testIndex.db.keys());
      expect(keys).toHaveLength(6);
    });

    it('should not put anything if aborted beforehand', async () => {
      const controller = new AbortController();
      controller.abort('reason');

      const id = uuid();
      const index = {
        id,
        foo: 'bar'
      };

      const indexPromise = testIndex.put(tenant, id, index, { signal: controller.signal });
      await expect(indexPromise).rejects.toThrow('reason');

      const entries = await testIndex.query(tenant, [{ foo: 'bar' }], { sortProperty: 'id' });
      expect(entries).toHaveLength(0);
    });
  });

  describe('query', () => {
    beforeAll(async () => {
      testIndex = new IndexLevel({
        createLevelDatabase,
        location: 'TEST-INDEX',
      });
      await testIndex.open();
    });

    beforeEach(async () => {
      await testIndex.clear();
    });

    afterAll(async () => {
      await testIndex.close();
    });

    it('works', async () =>{
      const id1 = uuid();
      const doc1 = {
        id  : id1,
        'a' : 'b',
        'c' : 'd'
      };

      const id2 = uuid();
      const doc2 = {
        id  : id2,
        'a' : 'c',
        'c' : 'd'
      };

      const id3 = uuid();
      const doc3 = {
        id  : id3,
        'a' : 'b',
        'c' : 'e'
      };

      await testIndex.put(tenant, id1, doc1);
      await testIndex.put(tenant, id2, doc2);
      await testIndex.put(tenant, id3, doc3);

      const entries = await testIndex.query(tenant, [{
        'a' : 'b',
        'c' : 'e'
      }], { sortProperty: 'id' });

      expect(entries).toHaveLength(1);
      expect(entries[0].messageCid).toBe(id3);
    });

    describe('findRecordLimitRankCutoff()', () => {
      const protocol = 'https://example.com/record-limit';
      const protocolPath = 'folder/item';
      const candidateFilter: Filter = {
        interface         : 'Records',
        method            : 'Write',
        isLatestBaseState : true,
        protocol,
        protocolPath,
      };

      async function putCandidate(input: {
        messageCid: string;
        dateCreated: string;
        recordId: string;
        parentId?: string;
        protocolPath?: string;
      }): Promise<void> {
        await testIndex.put(tenant, input.messageCid, {
          ...candidateFilter,
          dateCreated  : input.dateCreated,
          recordId     : input.recordId,
          protocolPath : input.protocolPath ?? protocolPath,
          ...(input.parentId !== undefined && { parentId: input.parentId }),
        });
      }

      it('finds a bounded nested-group boundary by creation time and record ID', async () => {
        await putCandidate({
          messageCid  : 'later',
          dateCreated : '2025-01-02T00:00:00.000000Z',
          recordId    : 'record-c',
          parentId    : 'parent-a',
        });
        await putCandidate({
          messageCid  : 'tie-later',
          dateCreated : '2025-01-01T00:00:00.000000Z',
          recordId    : 'record-b',
          parentId    : 'parent-a',
        });
        await putCandidate({
          messageCid  : 'tie-earlier',
          dateCreated : '2025-01-01T00:00:00.000000Z',
          recordId    : 'record-a',
          parentId    : 'parent-a',
        });
        await putCandidate({
          messageCid  : 'other-parent',
          dateCreated : '2024-01-01T00:00:00.000000Z',
          recordId    : 'record-0',
          parentId    : 'parent-b',
        });
        await putCandidate({
          messageCid   : 'other-path',
          dateCreated  : '2024-01-01T00:00:00.000000Z',
          recordId     : 'record-0',
          parentId     : 'parent-a',
          protocolPath : 'folder/other',
        });

        const cutoff = await testIndex.findRecordLimitRankCutoff(
          tenant,
          candidateFilter,
          'parent-a',
          2,
        );

        expect(cutoff).toBe(IndexLevel.createRecordLimitRankKey({
          dateCreated : '2025-01-01T00:00:00.000000Z',
          recordId    : 'record-b',
        }));
      });

      it('keeps root occupancy separate from nested records on the same path', async () => {
        await putCandidate({
          messageCid  : 'root-first',
          dateCreated : '2025-01-02T00:00:00.000000Z',
          recordId    : 'root-a',
        });
        await putCandidate({
          messageCid  : 'root-second',
          dateCreated : '2025-01-03T00:00:00.000000Z',
          recordId    : 'root-b',
        });
        await putCandidate({
          messageCid  : 'nested-first',
          dateCreated : '2025-01-01T00:00:00.000000Z',
          recordId    : 'nested-a',
          parentId    : 'parent-a',
        });

        const cutoff = await testIndex.findRecordLimitRankCutoff(
          tenant,
          candidateFilter,
          undefined,
          1,
        );

        expect(cutoff).toBe(IndexLevel.createRecordLimitRankKey({
          dateCreated : '2025-01-02T00:00:00.000000Z',
          recordId    : 'root-a',
        }));
      });
    });

    it('should return all records if an empty filter array is passed', async () => {
      const items = [ 'b', 'a', 'd', 'c' ];
      for (const item of items) {
        await testIndex.put(tenant, item, { letter: item, index: items.indexOf(item) });
      }

      // empty array
      let allResults = await testIndex.query(tenant, [],{ sortProperty: 'letter' });
      expect(allResults.map(({ messageCid }) => messageCid)).toEqual(['a', 'b', 'c', 'd']);

      // empty filter
      allResults = await testIndex.query(tenant, [{}],{ sortProperty: 'letter' });
      expect(allResults.map(({ messageCid }) => messageCid)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('uses only bounded paging strategies for projection chunks', async () => {
      const boundedIndex = new IndexLevel({
        createLevelDatabase,
        location        : `TEST-INDEX-BOUNDED-${uuid()}`,
        compoundIndexes : [{
          name         : 'schema-val',
          properties   : ['schema'],
          sortProperty : 'val',
        }],
      });
      await boundedIndex.open();

      const iteratorSpy = spyOn(boundedIndex, 'queryWithIteratorPaging');
      const inMemorySpy = spyOn(boundedIndex, 'queryWithInMemoryPaging');
      try {
        await boundedIndex.put(tenant, 'a', { val: 'a', schema: 'post', parentId: 'parent-a' });
        await boundedIndex.put(tenant, 'b', { val: 'b', schema: 'post', parentId: 'parent-a' });

        const compoundResults = await boundedIndex.queryWithBoundedPaging(
          tenant,
          [{ schema: 'post' }],
          { sortProperty: 'val', limit: 1 },
        );
        expect(compoundResults.map(({ messageCid }) => messageCid)).toEqual(['a']);
        expect(iteratorSpy).toHaveBeenCalledTimes(0);
        expect(inMemorySpy).toHaveBeenCalledTimes(0);

        const iteratorResults = await boundedIndex.queryWithBoundedPaging(
          tenant,
          [{ parentId: 'parent-a' }],
          { sortProperty: 'val', limit: 1 },
        );
        expect(iteratorResults.map(({ messageCid }) => messageCid)).toEqual(['a']);
        expect(iteratorSpy).toHaveBeenCalledTimes(1);
        expect(inMemorySpy).toHaveBeenCalledTimes(0);
      } finally {
        iteratorSpy.mockRestore();
        inMemorySpy.mockRestore();
        await boundedIndex.clear();
        await boundedIndex.close();
      }
    });

    describe('queryWithIteratorPaging()', () => {
      it('paginates using cursor', async () => {
        const testVals = ['b', 'd', 'c', 'a'];
        for (const val of testVals) {
          await testIndex.put(tenant, val, { val, schema: 'schema', published: true });
        }

        // insert other records to be filtered out
        for (const val of testVals) {
          const otherVal = val + val;
          await testIndex.put(tenant, otherVal, { val: otherVal, schema: 'schema', published: false });
        }

        const filters = [{ schema: 'schema', published: true }];

        // query with limit, default (ascending)
        const results = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'val', limit: 2 });
        expect(results).toHaveLength(2);
        expect(results.map(({ messageCid }) => messageCid)).toEqual(['a', 'b']);

        // query with cursor, default (ascending)
        const resultsAfterCursor = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(results, 'val') });
        expect(resultsAfterCursor).toHaveLength(2);
        expect(resultsAfterCursor.map(({ messageCid }) => messageCid)).toEqual(['c', 'd']);

        // query with limit, explicit ascending
        const ascResults = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'val', limit: 2 });
        expect(ascResults).toHaveLength(2);
        expect(ascResults.map(({ messageCid }) => messageCid)).toEqual(['a', 'b']);

        // query with cursor, explicit ascending
        const ascResultsAfterCursor = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(ascResults, 'val') });
        expect(ascResultsAfterCursor).toHaveLength(2);
        expect(ascResultsAfterCursor.map(({ messageCid }) => messageCid)).toEqual(['c', 'd']);

        // query with limit, descending
        const descResults = await testIndex.queryWithIteratorPaging(tenant, filters, { sortDirection: SortDirection.Descending, sortProperty: 'val', limit: 2 });
        expect(descResults).toHaveLength(2);
        expect(descResults.map(({ messageCid }) => messageCid)).toEqual(['d', 'c']);

        // query with cursor, descending
        const descResultsAfterCursor = await testIndex.queryWithIteratorPaging(tenant, filters, { sortDirection: SortDirection.Descending, sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(descResults, 'val') });
        expect(descResultsAfterCursor).toHaveLength(2);
        expect(descResultsAfterCursor.map(({ messageCid }) => messageCid)).toEqual(['b', 'a']);
      });

      it('returns empty array if sort property is invalid', async () => {
        const testVals = ['b', 'd', 'c', 'a'];
        for (const val of testVals) {
          await testIndex.put(tenant, val, { val, schema: 'schema', published: true });
        }

        // insert other records to be filtered out
        for (const val of testVals) {
          const otherVal = val + val;
          await testIndex.put(tenant, otherVal, { val: otherVal, schema: 'schema', published: false });
        }

        const filters = [{ schema: 'schema', published: true }];

        // control test: return all results
        const validResults = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'val' });
        expect(validResults).toHaveLength(4);

        // sort by invalid property returns no results
        const invalidResults = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'invalid' });
        expect(invalidResults).toHaveLength(0);
      });

      it('cursor is valid but out of range of matched results', async () => {
        const testVals = ['b', 'd', 'c']; // a is missing
        for (const val of testVals) {
          await testIndex.put(tenant, `${val}-id`, { val, schema: 'schema', published: true });
        }
        // insert other records to be filtered out
        for (const val of testVals) {
          const otherVal = val + val;
          await testIndex.put(tenant, `${val}-id`, { val: otherVal, schema: 'schema', published: false });
        }

        const filters = [{ schema: 'schema', published: true }];
        // cursor `a-id` doesn't actually exist, but the value `a` is sorted prior to the result set.
        const cursorA = { messageCid: 'a-id', value: 'a' };

        const allResults = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'val', cursor: cursorA });
        expect(allResults.map(({ messageCid }) => messageCid)).toEqual(['b-id', 'c-id', 'd-id']);

        // cursor `e-id` doesn't actually exist, but the value `e` is sorted after to the result set.
        const cursorE = { messageCid: 'e-id', value: 'e' };
        const noResults = await testIndex.queryWithIteratorPaging(tenant, filters, { sortProperty: 'val', cursor: cursorE });
        expect(noResults).toHaveLength(0);
      });
    });

    describe('array values', () => {
      it('query items with string array values', async () => {
        const items = [{
          id  : uuid(),
          tag : ['item1', 'item']
        },{
          id  : uuid(),
          tag : ['item2', 'item']
        },{
          id  : uuid(),
          tag : ['item3', 'item']
        },{
          id  : uuid(),
          tag : ['item4', 'item']
        }];
        for (const item of items) {
          await testIndex.put(tenant, item.id, item);
        }

        const filterForItemTag = [{ tag: 'item' }];
        const allResults = await testIndex.queryWithIteratorPaging(tenant, filterForItemTag, { sortProperty: 'id' });
        expect(allResults).toHaveLength(4);
        expect(allResults.map(item => item.messageCid)).toEqual(expect.arrayContaining(items.map(item => item.id)));

        const filterForItem3 = [{ tag: 'item3' }];
        const item3Results = await testIndex.queryWithIteratorPaging(tenant, filterForItem3, { sortProperty: 'id' });
        expect(item3Results).toHaveLength(1);
        expect(item3Results.map(item => item.messageCid)).toEqual(expect.arrayContaining([items[2].id]));
      });

      it('query items with number array values', async () => {
        const items = [{
          id  : uuid(),
          tag : [ 1 ]
        },{
          id  : uuid(),
          tag : [ 1, 2 ]
        },{
          id  : uuid(),
          tag : [ 1, 3 ]
        },{
          id  : uuid(),
          tag : [ 1, 4 ]
        }];
        for (const item of items) {
          await testIndex.put(tenant, item.id, item);
        }

        const filterForItemTag = [{ tag: 1 }];
        const allResults = await testIndex.queryWithIteratorPaging(tenant, filterForItemTag, { sortProperty: 'id' });
        expect(allResults).toHaveLength(4);
        expect(allResults.map(item => item.messageCid)).toEqual(expect.arrayContaining(items.map(item => item.id)));

        const filterForItem3 = [{ tag: 3 }];
        const item3Results = await testIndex.queryWithIteratorPaging(tenant, filterForItem3, { sortProperty: 'id' });
        expect(item3Results).toHaveLength(1);
        expect(item3Results.map(item => item.messageCid)).toEqual(expect.arrayContaining([items[2].id]));


        const filterForRange = [{ tag: { gt: 1, lt: 4 } }];
        const rangeItems = await testIndex.queryWithIteratorPaging(tenant, filterForRange, { sortProperty: 'id' });
        expect(rangeItems).toHaveLength(2);
        expect(rangeItems.map(item => item.messageCid)).toEqual(expect.arrayContaining([ items[1].id, items[2].id ]));
      });
    });

    describe('queryWithInMemoryPaging()', () => {
      it('paginates using cursor', async () => {
        const testVals = ['b', 'd', 'c', 'a'];
        for (const val of testVals) {
          await testIndex.put(tenant, val, { val, schema: 'schema', published: true });
        }

        // insert other records to be filtered out
        for (const val of testVals) {
          const otherVal = val + val;
          await testIndex.put(tenant, otherVal, { val: otherVal, schema: 'schema', published: false });
        }

        const filters = [{ schema: 'schema', published: true }];

        // query with limit, default (ascending)
        const results = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'val', limit: 2 });
        expect(results).toHaveLength(2);
        expect(results.map(({ messageCid }) => messageCid)).toEqual(['a', 'b']);

        // query with cursor, default (ascending)
        const resultsAfterCursor = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(results, 'val') });
        expect(resultsAfterCursor).toHaveLength(2);
        expect(resultsAfterCursor.map(({ messageCid }) => messageCid)).toEqual(['c', 'd']);

        // query with limit, explicit ascending
        const ascResults = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'val', limit: 2 });
        expect(ascResults).toHaveLength(2);
        expect(ascResults.map(({ messageCid }) => messageCid)).toEqual(['a', 'b']);

        // query with cursor, explicit ascending
        const ascResultsAfterCursor = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(ascResults, 'val') });
        expect(ascResultsAfterCursor).toHaveLength(2);
        expect(ascResultsAfterCursor.map(({ messageCid }) => messageCid)).toEqual(['c', 'd']);

        // query with limit, descending
        const descResults = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortDirection: SortDirection.Descending, sortProperty: 'val', limit: 2 });
        expect(descResults).toHaveLength(2);
        expect(descResults.map(({ messageCid }) => messageCid)).toEqual(['d', 'c']);

        // query with cursor, descending
        const descResultsAfterCursor = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortDirection: SortDirection.Descending, sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(descResults, 'val') });
        expect(descResultsAfterCursor).toHaveLength(2);
        expect(descResultsAfterCursor.map(({ messageCid }) => messageCid)).toEqual(['b', 'a']);
      });

      it('returns empty array if sort property is invalid', async () => {
        const testVals = ['b', 'd', 'c', 'a'];
        for (const val of testVals) {
          await testIndex.put(tenant, val, { val, schema: 'schema', published: true });
        }

        // insert other records to be filtered out
        for (const val of testVals) {
          const otherVal = val + val;
          await testIndex.put(tenant, otherVal, { val: otherVal, schema: 'schema', published: false });
        }

        const filters = [{ schema: 'schema', published: true }];

        // control test: return all results
        const validResults = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'val', limit: 3 });
        expect(validResults).toHaveLength(3);

        // sort by invalid property returns no results
        const invalidResults = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'invalid' });
        expect(invalidResults).toHaveLength(0);
      });

      it('cursor is valid but out of range of matched results', async () => {
        const testVals = ['b', 'd', 'c', 'a'];
        for (const val of testVals) {
          await testIndex.put(tenant, val, { val, schema: 'schema', published: true });
        }

        // insert other records to be filtered out
        for (const val of testVals) {
          const otherVal = val + val;
          await testIndex.put(tenant, otherVal, { val: otherVal, schema: 'schema', published: false });
        }

        const filters = [{ schema: 'schema', published: true }];
        const cursorA = { messageCid: 'a', value: 'a' }; // before results

        const allResults = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'val', cursor: cursorA });
        expect(allResults.map(({ messageCid }) => messageCid)).toEqual(['b', 'c', 'd']);

        const cursorE = { messageCid: 'e', value: 'e' }; // after results
        const noResults = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'val', cursor: cursorE });
        expect(noResults).toHaveLength(0);
      });

      it('supports range queries', async () => {
        const id = uuid();
        const doc1 = {
          id,
          value: 'foo'
        };
        await testIndex.put(tenant, id, doc1);

        const id2 = uuid();
        const doc2 = {
          id    : id2,
          value : 'foobar'
        };
        await testIndex.put(tenant, id2, doc2);

        const id3 = uuid();
        const doc3 = {
          id    : id3,
          value : 'foobaz'
        };
        await testIndex.put(tenant, id3, doc3);

        const filters = [{
          value: {
            gt  : 'foo',
            lte : 'foobaz'
          }
        }];

        const entries = await testIndex.queryWithInMemoryPaging(tenant, filters, { sortProperty: 'id' });

        expect(entries).toHaveLength(2);
        expect(entries.map(({ messageCid }) => messageCid)).toEqual(expect.arrayContaining([id2, id3]));

        // only upper bounds
        const lteFilter = [{
          value: {
            lte: 'foobaz'
          }
        }];
        const lteReply = await testIndex.queryWithInMemoryPaging(tenant, lteFilter, { sortProperty: 'id' });

        expect(lteReply).toHaveLength(3);
        expect(lteReply.map(({ messageCid }) => messageCid)).toEqual(expect.arrayContaining([id, id2, id3]));
      });

      describe('array values', () => {
        it('query items with string array values', async () => {
          const items = [{
            id  : uuid(),
            tag : ['item1', 'item']
          },{
            id  : uuid(),
            tag : ['item2', 'item']
          },{
            id  : uuid(),
            tag : ['item3', 'item']
          },{
            id  : uuid(),
            tag : ['item4', 'item']
          }];
          for (const item of items) {
            await testIndex.put(tenant, item.id, item);
          }

          const filterForItemTag = [{ tag: 'item' }];
          const allResults = await testIndex.queryWithInMemoryPaging(tenant, filterForItemTag, { sortProperty: 'id' });
          expect(allResults).toHaveLength(4);
          expect(allResults.map(item => item.messageCid)).toEqual(expect.arrayContaining(items.map(item => item.id)));

          const filterForItem3 = [{ tag: 'item3' }];
          const item3Results = await testIndex.queryWithInMemoryPaging(tenant, filterForItem3, { sortProperty: 'id' });
          expect(item3Results).toHaveLength(1);
          expect(item3Results.map(item => item.messageCid)).toEqual(expect.arrayContaining([items[2].id]));
        });

        it('query items with number array values', async () => {
          const items = [{
            id  : uuid(),
            tag : [ 1 ]
          },{
            id  : uuid(),
            tag : [ 1, 2 ]
          },{
            id  : uuid(),
            tag : [ 1, 3 ]
          },{
            id  : uuid(),
            tag : [ 1, 4 ]
          }];
          for (const item of items) {
            await testIndex.put(tenant, item.id, item);
          }

          const filterForItemTag = [{ tag: 1 }];
          const allResults = await testIndex.queryWithInMemoryPaging(tenant, filterForItemTag, { sortProperty: 'id' });
          expect(allResults).toHaveLength(4);
          expect(allResults.map(item => item.messageCid)).toEqual(expect.arrayContaining(items.map(item => item.id)));

          const filterForItem3 = [{ tag: 3 }];
          const item3Results = await testIndex.queryWithInMemoryPaging(tenant, filterForItem3, { sortProperty: 'id' });
          expect(item3Results).toHaveLength(1);
          expect(item3Results.map(item => item.messageCid)).toEqual(expect.arrayContaining([items[2].id]));


          const filterForRange = [{ tag: { gt: 1, lt: 4 } }];
          const rangeItems = await testIndex.queryWithInMemoryPaging(tenant, filterForRange, { sortProperty: 'id' });
          expect(rangeItems).toHaveLength(2);
          expect(rangeItems.map(item => item.messageCid)).toEqual(expect.arrayContaining([ items[1].id, items[2].id ]));
        });
      });
    });

    describe('query()', () => {
      it('should not match values prefixed with the query', async () => {
        const id = uuid();
        const doc = {
          id,
          value: 'foobar'
        };

        await testIndex.put(tenant, id, doc);

        const filters = [{ value: 'foo' }];
        const entries = await testIndex.query(tenant, filters, { sortProperty: 'id' });
        expect(entries).toHaveLength(0);

      });

      it('supports OR queries', async () => {
        const id1 = uuid();
        const doc1 = {
          id  : id1,
          'a' : 'a'
        };

        const id2 = uuid();
        const doc2 = {
          id  : id2,
          'a' : 'b'
        };

        const id3 = uuid();
        const doc3 = {
          id  : id3,
          'a' : 'c'
        };

        await testIndex.put(tenant, id1, doc1);
        await testIndex.put(tenant, id2, doc2);
        await testIndex.put(tenant, id3, doc3);

        const filters = [{
          a: [ 'a', 'b' ]
        }];

        const entries = await testIndex.query(tenant, filters , { sortProperty: 'id' });

        expect(entries).toHaveLength(2);
        expect(entries.map(({ messageCid }) => messageCid)).toContain(id1);
        expect(entries.map(({ messageCid }) => messageCid)).toContain(id2);
      });

      it('supports range queries', async () => {
        for (let i = -5; i < 5; ++i) {
          const id = uuid();
          const doc = {
            id,
            dateCreated: Time.createTimestamp({ year: 2023, month: 1, day: 15 + i })
          };

          await testIndex.put(tenant, id, doc);
        }

        const filters = [{
          dateCreated: {
            gte: Time.createTimestamp({ year: 2023, month: 1, day: 15 })
          }
        }];
        const entries = await testIndex.query(tenant, filters, { sortProperty: 'id' });

        expect(entries).toHaveLength(5);
      });

      it('supports prefixed range queries', async () => {
        const id = uuid();
        const doc = {
          id,
          value: 'foobar'
        };

        await testIndex.put(tenant, id, doc);

        const filters = [{
          value: {
            gte: 'foo'
          }
        }];

        const entries = await testIndex.query(tenant, filters, { sortProperty: 'id' });

        expect(entries).toHaveLength(1);
        expect(entries.map(({ messageCid }) => messageCid)).toContain(id);
      });

      it('supports suffixed range queries', async () => {
        const id1 = uuid();
        const doc1 = {
          id  : id1,
          foo : 'bar'
        };

        const id2 = uuid();
        const doc2 = {
          id  : id2,
          foo : 'barbaz'
        };

        await testIndex.put(tenant, id1, doc1);
        await testIndex.put(tenant, id2, doc2);

        const filters = [{
          foo: {
            lte: 'bar'
          }
        }];

        const entries = await testIndex.query(tenant, filters, { sortProperty: 'id' });

        expect(entries).toHaveLength(1);
        expect(entries.map(({ messageCid }) => messageCid)).toContain(id1);
      });

      it('treats strings differently', async () => {
        const id1 = uuid();
        const doc1 = {
          id  : id1,
          foo : true
        };

        const id2 = uuid();
        const doc2 = {
          id  : id2,
          foo : 'true'
        };

        await testIndex.put(tenant, id1, doc1);
        await testIndex.put(tenant, id2, doc2);

        const filters = [{
          foo: true
        }];

        const entries = await testIndex.query(tenant, filters, { sortProperty: 'id' });

        expect(entries).toHaveLength(1);
        expect(entries.map(({ messageCid }) => messageCid)).toContain(id1);
      });

      describe('numbers', () => {

        const positiveDigits = Array(10).fill({}).map( _ => TestDataGenerator.randomInt(0, Number.MAX_SAFE_INTEGER)).sort((a,b) => a - b);
        const negativeDigits =
          Array(10).fill({}).map( _ => TestDataGenerator.randomInt(0, Number.MAX_SAFE_INTEGER) * -1).sort((a,b) => a - b);
        const testNumbers = Array.from(new Set([...negativeDigits, ...positiveDigits])); // unique numbers

        it('should return records that match provided number equality filter', async () => {
          const index = Math.floor(Math.random() * testNumbers.length);

          for (const digit of testNumbers) {
            await testIndex.put(tenant, digit.toString(), { digit });
          }

          const filters = [{
            digit: testNumbers.at(index)!
          }];

          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });

          expect(entries).toHaveLength(1);
          expect(entries.at(0)?.messageCid).toBe(testNumbers.at(index)!.toString());
        });

        it ('should not return records that do not match provided number equality filter', async() => {
          // remove the potential (but unlikely) negative test result
          for (const digit of testNumbers.filter(n => n !== 1)) {
            await testIndex.put(tenant, digit.toString(), { digit });
          }

          const filters = [{ digit: 1 }];
          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });

          expect(entries).toHaveLength(0);
        });

        it('supports range queries with positive numbers inclusive', async () => {
          for (const digit of testNumbers) {
            await testIndex.put(tenant, digit.toString(), { digit });
          }

          const upperBound = positiveDigits.at(positiveDigits.length - 3)!;
          const lowerBound = positiveDigits.at(2)!;
          const filters = [{
            digit: {
              gte : lowerBound,
              lte : upperBound
            }
          }];

          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });

          const testResults = testNumbers.filter( n => n >= lowerBound && n <= upperBound).map(n => n.toString());
          expect(entries.map(({ messageCid }) => messageCid)).toEqual(testResults);
        });

        it('supports range queries with negative numbers inclusive', async () => {
          for (const digit of testNumbers) {
            await testIndex.put(tenant, digit.toString(), { digit });
          }

          const upperBound = negativeDigits.at(negativeDigits.length - 2)!;
          const lowerBound = negativeDigits.at(2)!;

          const filters = [{
            digit: {
              gte : lowerBound,
              lte : upperBound
            }
          }];
          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });

          const testResults = testNumbers.filter( n => n >= lowerBound && n <= upperBound).map(n => n.toString());
          expect(entries.map(({ messageCid }) => messageCid)).toEqual(testResults);
        });

        it('should return numbers gt a negative digit', async () => {
          for (const digit of testNumbers) {
            await testIndex.put(tenant, digit.toString(), { digit });
          }

          const lowerBound = negativeDigits.at(4)!;
          const filters = [{
            digit: {
              gt: lowerBound,
            }
          }];
          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });

          const testResults = testNumbers.filter( n => n > lowerBound).map(n => n.toString());
          expect(entries.map(({ messageCid }) => messageCid)).toEqual(testResults);
        });

        it('should return numbers gt a digit', async () => {
          for (const digit of testNumbers) {
            await testIndex.put(tenant,digit.toString(), { digit });
          }

          const lowerBound = positiveDigits.at(4)!;

          const filters = [{
            digit: {
              gt: lowerBound,
            }
          }];

          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });
          const testResults = testNumbers.filter( n => n > lowerBound).map(n => n.toString());
          expect(entries.map(({ messageCid }) => messageCid)).toEqual(testResults);
        });

        it('should return numbers lt a negative digit', async () => {
          for (const digit of testNumbers) {
            await testIndex.put(tenant,digit.toString(), { digit });
          }

          const upperBound = negativeDigits.at(4)!;

          const filters = [{
            digit: {
              lt: upperBound,
            }
          }];

          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });

          const testResults = testNumbers.filter( n => n < upperBound).map(n => n.toString());
          expect(entries.map(({ messageCid }) => messageCid)).toEqual(testResults);
        });

        it('should return numbers lt a digit', async () => {
          for (const digit of testNumbers) {
            await testIndex.put(tenant,digit.toString(), { digit });
          }

          const upperBound = positiveDigits.at(4)!;

          const filters = [{
            digit: {
              lt: upperBound,
            }
          }];

          const entries = await testIndex.query(tenant, filters, { sortProperty: 'digit' });

          const testResults = testNumbers.filter( n => n < upperBound).map(n => n.toString());
          expect(entries.map(({ messageCid }) => messageCid)).toEqual(testResults);
        });
      });

      describe('booleans', () => {
        it('should return records that match provided boolean equality filter', async () => {
          const itemTrueId = uuid();
          const boolTrueItem = {
            id        : itemTrueId,
            schema    : 'schema',
            published : true,
          };
          await testIndex.put(tenant, itemTrueId, boolTrueItem);

          const itemFalseId = uuid();
          const boolFalseItem = {
            id        : itemFalseId,
            schema    : 'schema',
            published : false,
          };
          await testIndex.put(tenant, itemFalseId, boolFalseItem);

          const bothFilter = [{ schema: 'schema' }];
          // control
          const entries = await testIndex.query(tenant, bothFilter, { sortProperty: 'id' });
          expect(entries).toHaveLength(2);
          expect(entries.map(({ messageCid }) => messageCid)).toEqual(expect.arrayContaining([ itemTrueId, itemFalseId ]));

          const trueFilter = [{ published: true, schema: 'schema' }];
          // equality true
          const respTrue = await testIndex.query(tenant, trueFilter, { sortProperty: 'id' });
          expect(respTrue).toHaveLength(1);
          expect(respTrue.map(({ messageCid }) => messageCid)).toEqual(expect.arrayContaining([ itemTrueId ]));

          const falseFilter = [{ published: false, schema: 'schema' }];
          // equality false
          const respFalse = await testIndex.query(tenant, falseFilter, { sortProperty: 'id' });
          expect(respFalse).toHaveLength(1);
          expect(respFalse.map(({ messageCid }) => messageCid)).toEqual(expect.arrayContaining([ itemFalseId ]));
        });
      });

      describe('sort, limit and cursor', () => {
        it('only returns the number of results specified by the limit property', async () => {
          const testVals = [ 'b', 'a', 'd', 'c'];
          for (const val of testVals) {
            await testIndex.put(tenant, val, { val, schema: 'schema' });
          }

          const filters = [{ schema: 'schema' }];

          // limit results without cursor
          let ascResults = await testIndex.query(tenant, filters, { sortProperty: 'val', limit: 2 });
          expect(ascResults).toHaveLength(2);
          expect(ascResults.map(({ messageCid }) => messageCid)).toEqual(['a', 'b']);

          // limit results with a cursor
          ascResults = await testIndex.query(tenant, filters, { sortProperty: 'val', limit: 2, cursor: IndexLevel.createCursorFromLastArrayItem(ascResults, 'val') });
          expect(ascResults).toHaveLength(2);
          expect(ascResults.map(({ messageCid }) => messageCid)).toEqual(['c', 'd']);
        });

        it('can sort by any indexed property', async () => {
          const testVals = ['b', 'd', 'c', 'a'];
          for (const val of testVals) {
            await testIndex.put(tenant, val, { val, schema: 'schema', index: testVals.indexOf(val) });
          }

          const filters = [{ schema: 'schema' }];

          // sort by value ascending
          const ascResults = await testIndex.query(tenant, filters, { sortProperty: 'val' });
          expect(ascResults).toHaveLength(testVals.length);
          expect(ascResults.map(({ messageCid }) => messageCid)).toEqual(['a', 'b', 'c', 'd']);

          // sort by index ascending
          const ascIndexResults = await testIndex.query(tenant, filters, { sortProperty: 'index' });
          expect(ascIndexResults).toHaveLength(testVals.length);
          expect(ascIndexResults.map(({ messageCid }) => messageCid)).toEqual(testVals);

          // sort by value descending
          const descResults = await testIndex.query(tenant, filters, { sortProperty: 'val', sortDirection: SortDirection.Descending });
          expect(descResults).toHaveLength(testVals.length);
          expect(descResults.map(({ messageCid }) => messageCid)).toEqual(['d', 'c', 'b', 'a']);

          // sort by index descending
          const descIndexResults = await testIndex.query(tenant, filters, { sortProperty: 'index', sortDirection: SortDirection.Descending });
          expect(descIndexResults).toHaveLength(testVals.length);
          expect(descIndexResults.map(({ messageCid }) => messageCid)).toEqual([...testVals].reverse());
        });

        it('sorts lexicographic', async () => {
          const testVals = [ 'b', 'a', 'd', 'c'];
          for (const val of testVals) {
            await testIndex.put(tenant, val, { val, schema: 'schema' });
          }
          const filters = [{ schema: 'schema' }];
          // sort ascending
          const ascResults = await testIndex.query(tenant, filters, { sortProperty: 'val' });
          expect(ascResults).toHaveLength(4);
          expect(ascResults.map(({ messageCid }) => messageCid)).toEqual(['a', 'b', 'c', 'd']);

          // sort descending
          const descResults = await testIndex.query(tenant, filters, { sortProperty: 'val', sortDirection: SortDirection.Descending });
          expect(descResults).toHaveLength(4);
          expect(descResults.map(({ messageCid }) => messageCid)).toEqual(['d', 'c', 'b', 'a']);
        });

        it('sorts numeric with and without a cursor', async () => {
          const testVals = [ -2, -1, 0, 1, 2 , 3 , 4 ];
          for (const val of testVals) {
            await testIndex.put(tenant, val.toString(), { val, schema: 'schema' });
          }

          const filters = [{ schema: 'schema' }];
          // sort ascending
          const ascResults = await testIndex.query(tenant, filters, { sortProperty: 'val' });
          expect(ascResults).toHaveLength(testVals.length);
          expect(ascResults.map(({ messageCid }) => messageCid)).toEqual(['-2', '-1', '0', '1', '2' , '3' , '4']);

          // sort descending
          const descResults = await testIndex.query(tenant, filters, { sortProperty: 'val', sortDirection: SortDirection.Descending });
          expect(descResults).toHaveLength(testVals.length);
          expect(descResults.map(({ messageCid }) => messageCid)).toEqual(['4', '3', '2', '1', '0' , '-1' , '-2']);
        });

        it('sorts range queries with or without a cursor', async () => {

          const testItems = [ 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h' ];

          for (const item of testItems) {
            await testIndex.put(tenant, item, { letter: item });
          }

          // test both upper and lower bounds
          const lowerBound = 'b';
          const upperBound = 'g';

          const bothBoundsFilters = [{
            letter: {
              gte : lowerBound,
              lte : upperBound
            },
          }];

          // ascending without a cursor
          let response = await testIndex.query(tenant, bothBoundsFilters, { sortProperty: 'letter', limit: 4 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual(['b', 'c', 'd', 'e']);
          // ascending with a cursor
          response = await testIndex.query(tenant, bothBoundsFilters, { sortProperty: 'letter', cursor: IndexLevel.createCursorFromLastArrayItem(response, 'letter') });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'f', 'g' ]); // should only return greater than e

          // descending without a cursor
          response = await testIndex.query(tenant, bothBoundsFilters, { sortProperty: 'letter', sortDirection: SortDirection.Descending, limit: 4 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual(['g', 'f', 'e', 'd']);

          // descending with a cursor
          response = await testIndex.query(tenant, bothBoundsFilters, { sortProperty: 'letter', sortDirection: SortDirection.Descending, cursor: IndexLevel.createCursorFromLastArrayItem(response, 'letter') });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'c', 'b' ]); // should only return less than d


          // test only upper bounds
          const upperBoundsFilters = [{
            letter: {
              lte: upperBound
            },
          }];

          // ascending without a cursor
          response = await testIndex.query(tenant, upperBoundsFilters, { sortProperty: 'letter', limit: 4 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual(['a', 'b', 'c', 'd']);
          // ascending with a cursor
          response = await testIndex.query(tenant, upperBoundsFilters, { sortProperty: 'letter', cursor: IndexLevel.createCursorFromLastArrayItem(response, 'letter') });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'e', 'f', 'g' ]); // should only return items greater than d

          // descending without a cursor
          response = await testIndex.query(tenant, upperBoundsFilters, { sortProperty: 'letter', sortDirection: SortDirection.Descending, limit: 4 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual(['g', 'f', 'e', 'd' ]);

          // descending with a cursor
          response = await testIndex.query(tenant, upperBoundsFilters, { sortProperty: 'letter', sortDirection: SortDirection.Descending, cursor: IndexLevel.createCursorFromLastArrayItem(response, 'letter') });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'c', 'b', 'a' ]); // should only return items less than c

          // test only lower bounds
          const lowerBoundsFilters = [{
            letter: {
              gte: lowerBound
            },
          }];

          // ascending without a cursor
          response = await testIndex.query(tenant, lowerBoundsFilters, { sortProperty: 'letter', limit: 4 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual(['b', 'c', 'd', 'e']);

          // ascending with a cursor
          response = await testIndex.query(tenant, lowerBoundsFilters, { sortProperty: 'letter', cursor: IndexLevel.createCursorFromLastArrayItem(response, 'letter') });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'f', 'g', 'h' ]); // should only return items greater than e

          // descending without a cursor
          response = await testIndex.query(tenant, lowerBoundsFilters, { sortProperty: 'letter', sortDirection: SortDirection.Descending, limit: 4 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual(['h', 'g', 'f', 'e']);

          // descending with a cursor
          response = await testIndex.query(tenant, lowerBoundsFilters, { sortProperty: 'letter', sortDirection: SortDirection.Descending, cursor: IndexLevel.createCursorFromLastArrayItem(response, 'letter') });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'd', 'c', 'b' ]); // should only return items less than e
        });

        it('sorts range queries negative integers with or without a cursor', async () => {
          const testNumbers = [ -5, -4, -3 , -2, -1, 0, 1, 2, 3, 4, 5 ];
          for (const digit of testNumbers) {
            await testIndex.put(tenant,digit.toString(), { digit });
          }

          const upperBound = 3;
          const lowerBound = -2;

          const filters = [{
            digit: {
              gte : lowerBound,
              lte : upperBound
            }
          }];

          let results = await testIndex.query(tenant,filters , { sortProperty: 'digit', limit: 4 });
          expect(results.map(({ messageCid }) => messageCid)).toEqual([ '-2', '-1', '0', '1' ]);

          const cursor = IndexLevel.createCursorFromLastArrayItem(results, 'digit');
          expect(typeof cursor?.value).toBe('number'); // the cursor value is a number, as it was indexed

          results = await testIndex.query(tenant, filters, { sortProperty: 'digit', cursor });
          expect(results.map(({ messageCid }) => messageCid)).toEqual(['2', '3']);
        });

        it('sorts range queries with remaining results in lte after cursor', async () => {
          // create an array with unique IDs but multiple items representing the same digit.
          const testItems = [{
            id    : 'a',
            digit : 1,
          },{
            id    : 'b',
            digit : 2,
          }, {
            id    : 'c',
            digit : 3,
          }, {
            id    : 'd',
            digit : 4,
          }, {
            id    : 'e',
            digit : 4,
          },{
            id    : 'f',
            digit : 4,
          },{
            id    : 'g',
            digit : 4,
          },{
            id    : 'h',
            digit : 5,
          }];

          for (const item of testItems) {
            await testIndex.put(tenant, item.id, item);
          }

          const lowerBound = 2;
          const upperBound = 4;

          // with both lower and upper bounds
          // first issue with a limit
          let response = await testIndex.query(tenant, [{
            digit: {
              gte : lowerBound,
              lte : upperBound
            },
          }], { sortProperty: 'id', limit: 3 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'b', 'c', 'd' ]);

          // this cursor should ony return results from the 'lte' part of the filter
          response = await testIndex.query(tenant, [{
            digit: {
              gte : lowerBound,
              lte : upperBound
            },
          }], { sortProperty: 'id', cursor: IndexLevel.createCursorFromLastArrayItem(response, 'id') });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'e', 'f', 'g' ]);

          // issue a range with no lower bounds but a limit
          response = await testIndex.query(tenant, [{
            digit: {
              lte: upperBound
            },
          }], { sortProperty: 'id', limit: 4 });
          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'a', 'b', 'c', 'd' ]);

          // with no lower bounds
          // ascending with a cursor
          // this cursor should ony return results from the 'lte' part of the filter
          response = await testIndex.query(tenant, [{
            digit: {
              lte: upperBound
            },
          }], { sortProperty: 'id', cursor: IndexLevel.createCursorFromLastArrayItem(response, 'id') });

          expect(response.map(({ messageCid }) => messageCid)).toEqual([ 'e', 'f', 'g']); // should only return three matching items
        });

        it('sorts OR queries with or without a cursor', async () => {
          const testValsSchema1 = ['a1', 'b1', 'c1', 'd1'];
          for (const val of testValsSchema1) {
            await testIndex.put(tenant, val, { val, schema: 'schema1' });
          }

          const testValsSchema2 = ['a2', 'b2', 'c2', 'd2'];
          for (const val of testValsSchema2) {
            await testIndex.put(tenant, val, { val, schema: 'schema2' });
          }

          const filters = [{
            schema: ['schema1', 'schema2']
          }];

          // sort ascending without cursor
          let results = await testIndex.query(tenant, filters, { sortProperty: 'val', limit: 4 });
          expect(results.map(({ messageCid }) => messageCid)).toEqual(['a1', 'a2', 'b1', 'b2']);

          // sort ascending from b2 onwards
          results = await testIndex.query(tenant, filters, { sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(results, 'val') });
          expect(results.map(({ messageCid }) => messageCid)).toEqual(['c1', 'c2', 'd1', 'd2']);
        });

        it('supports multiple filtered queries', async () => {
          const items:Array<{ val: string, digit: number, property: boolean }> = [];

          const lowerBounds = -2;
          const upperBounds = 3;

          // create 30 records with random digits between 1-9
          // every 3rd record should be a negative number
          // every 5th record a property should be set to true
          // every property not set to true should be set to false

          // we artificially use index #4 to be within the bounds of our query to be used as a cursor point.
          for (let i = 0; i < 30; i++) {

            const digit = i === 4 ? TestDataGenerator.randomInt(lowerBounds, upperBounds) :
              i % 3 === 0 ?
                TestDataGenerator.randomInt(1,9) * -1:
                TestDataGenerator.randomInt(1,9);

            const property = i % 5 === 0 ? true : false;

            const item = { val: IndexLevel.encodeNumberValue(i), digit, property };
            await testIndex.put(tenant, item.val, item);
            items.push(item);
          }

          // create the expected results;
          const compareResults = new Set([
            ...items.filter(i => i.digit >= lowerBounds && i.digit <= upperBounds),
            ...items.filter(i => i.property === true),
          ].sort((a,b) => lexicographicalCompare(a.val, b.val)).map(i => i.val));


          const filters:Filter[] = [
            { digit: { gte: lowerBounds, lte: upperBounds } },
            { property: true }
          ];

          // query in ascending order.
          const results = await testIndex.query(tenant, filters, { sortProperty: 'val', limit: 10 });
          expect(results.length).toBeLessThanOrEqual(10);
          expect(results.map(({ messageCid }) => messageCid)).toEqual([...compareResults].slice(0, 10));

          // query in ascending order with cursor.
          const resultsWithCursor = await testIndex.query(tenant, filters, { sortProperty: 'val', cursor: IndexLevel.createCursorFromLastArrayItem(results, 'val') });
          expect(resultsWithCursor.map(({ messageCid }) => messageCid)).toEqual([...compareResults].slice(10));

          const descResults = await testIndex.query(tenant, filters, { sortProperty: 'val', sortDirection: SortDirection.Descending, limit: 10 });
          expect(descResults.length).toBeLessThanOrEqual(10);
          expect(descResults.map(({ messageCid }) => messageCid)).toEqual([...compareResults].reverse().slice(0, 10));

          const descResultsAfterCursor = await testIndex.query(tenant, filters, { sortProperty: 'val', sortDirection: SortDirection.Descending, cursor: IndexLevel.createCursorFromLastArrayItem(descResults, 'val') });

          expect(descResultsAfterCursor.map(({ messageCid }) => messageCid)).toEqual([...compareResults].reverse().slice(10));
        });
      });
    });
  });

  describe('delete', () => {
    beforeAll(async () => {
      testIndex = new IndexLevel({
        createLevelDatabase,
        location: 'TEST-INDEX',
      });
      await testIndex.open();
    });

    beforeEach(async () => {
      await testIndex.clear();
    });

    afterAll(async () => {
      await testIndex.close();
    });

    it('purges indexes', async () => {
      const id1 = uuid();
      const doc1 = {
        id  : id1,
        'a' : 'b',
        'c' : ['d', 'e']
      };

      const id2 = uuid();
      const doc2 = {
        id  : id2,
        'a' : 'b',
        'c' : ['d', 'e']
      };

      await testIndex.put(tenant, id1, doc1);
      await testIndex.put(tenant, id2, doc2);

      let result = await testIndex.query(tenant, [{ 'a': 'b', 'c': 'e' }], { sortProperty: 'id' });

      expect(result).toHaveLength(2);
      expect(result.map(({ messageCid }) => messageCid)).toContain(id1);

      await testIndex.delete(tenant, id1);

      result = await testIndex.query(tenant, [{ 'a': 'b', 'c': 'e' }], { sortProperty: 'id' });

      expect(result).toHaveLength(1);

      await testIndex.delete(tenant, id2);

      const allKeys = await ArrayUtility.fromAsyncGenerator(testIndex.db.keys());
      expect(allKeys).toHaveLength(0);
    });

    it('should not delete anything if aborted beforehand', async () => {
      const controller = new AbortController();
      controller.abort('reason');

      const id = uuid();
      const doc = {
        id  : id,
        foo : 'bar'
      };

      await testIndex.put(tenant, id, doc);

      try {
        await testIndex.delete(tenant, id, { signal: controller.signal });
      } catch (e) {
        expect(e).toBe('reason');
      }

      const result = await testIndex.query(tenant, [{ foo: 'bar' }], { sortProperty: 'id' });
      expect(result).toHaveLength(1);
      expect(result.map(({ messageCid }) => messageCid)).toContain(id);
    });

    it('does nothing when attempting to purge key that does not exist', async () => {
      const controller = new AbortController();
      controller.abort('reason');

      const id = uuid();
      const doc = {
        id  : id,
        foo : 'bar'
      };

      await testIndex.put(tenant, id, doc);

      // attempt purge an invalid id
      await testIndex.delete(tenant, 'invalidCid');

      const result = await testIndex.query(tenant, [{ foo: 'bar' }], { sortProperty: 'id' });
      expect(result).toHaveLength(1);
      expect(result.map(({ messageCid }) => messageCid)).toContain(id);
    });
  });

  describe('createCursorFromItem', () => {
    it('throws if cursor value is a boolean or an array', async () => {
      // we can only sort by strings or numbers, so arrays or booleans should throw.
      const item: IndexedItem = {
        messageCid : 'message-cid',
        indexes    : {
          sortPropertyBool  : true,
          sortPropertyArray : [ 1,2,3 ],
        }
      };

      expect(() => IndexLevel.createCursorFromItem(item, 'sortPropertyBool')).toThrow(DwnErrorCode.IndexInvalidCursorValueType);
      expect(() => IndexLevel.createCursorFromItem(item, 'sortPropertyArray')).toThrow(DwnErrorCode.IndexInvalidCursorValueType);
    });

    it('throws if sort property is not defined within the IndexedItem', async () => {
      const item: IndexedItem = {
        messageCid : 'message-cid',
        indexes    : {
          sortProperty: 1234,
        }
      };

      expect(() => IndexLevel.createCursorFromItem(item, 'unknownProperty')).toThrow(DwnErrorCode.IndexInvalidCursorSortProperty);
    });

    it('returns numeric type cursor value', async () => {
      const item: IndexedItem = {
        messageCid : 'message-cid',
        indexes    : {
          sortProperty: 1234,
        }
      };

      const cursor = IndexLevel.createCursorFromItem(item, 'sortProperty');
      expect(cursor.value).toBe(1234);
    });

    it('returns string type cursor value', async () => {
      const item: IndexedItem = {
        messageCid : 'message-cid',
        indexes    : {
          sortProperty: '1234',
        }
      };

      const cursor = IndexLevel.createCursorFromItem(item, 'sortProperty');
      expect(cursor.value).toBe('1234');
    });
  });

  describe('createCursorFromLastArrayItem', () => {
    it('returns undefined if an empty array is provided', async () => {
      const cursor = IndexLevel.createCursorFromLastArrayItem([], 'someProperty');
      expect(cursor).toBeUndefined();
    });
    it('returns a PaginationCursor for the last item given a valid sort property', async () => {
      const items:IndexedItem[] = [{
        messageCid : 'cid-1',
        indexes    : {
          prop1 : true,
          prop2 : 'prop-2',
          date  : '2023-12-13T11:22:33.000000Z'
        }
      }, {
        messageCid : 'cid-2',
        indexes    : {
          prop1 : true,
          prop2 : 'prop-2',
          date  : '2023-12-14T11:22:33.000000Z'
        }
      }];
      const cursor = IndexLevel.createCursorFromLastArrayItem(items, 'date');
      expect(cursor?.messageCid).toBe('cid-2'); // expect the cursor to equal the messageCid
      expect(cursor?.value).toBe('2023-12-14T11:22:33.000000Z');
    });
  });

  describe('encodeValue', () => {
    it('should wrap string in quotes', async () => {
      expect(IndexLevel.encodeValue('test')).toBe(`"test"`);
    });

    it('should return string encoded number using encodeNumberValue()', async () => {
      expect(IndexLevel.encodeValue(10)).toBe(IndexLevel.encodeNumberValue(10));
    });

    it('should return stringified boolean', () => {
      expect(IndexLevel.encodeValue(true)).toBe('true');
      expect(IndexLevel.encodeValue(false)).toBe('false');
    });
  });

  describe('encodeNumberValue', () => {
    it('should encode positive digits and pad with leading zeros', () => {
      const expectedLength = String(Number.MAX_SAFE_INTEGER).length; //16
      const encoded = IndexLevel.encodeNumberValue(100);
      expect(encoded).toHaveLength(expectedLength);
      expect(encoded).toBe('0000000000000100');
    });

    it('should encode negative digits as an offset with a prefix', () => {
      const expectedPrefix = '!';
      // expected length is maximum padding + the prefix.
      const expectedLength = (expectedPrefix + String(Number.MAX_SAFE_INTEGER)).length; //17
      const encoded = IndexLevel.encodeNumberValue(-100);
      expect(encoded).toHaveLength(String(Number.MIN_SAFE_INTEGER).length);
      expect(encoded).toHaveLength(expectedLength);
      expect(encoded).toBe('!9007199254740891');
    });

    it('should encode digits to sort using lexicographical comparison', () => {
      const digits = [ -1000, -100, -10, 10, 100, 1000 ].sort((a,b) => a - b);
      const encodedDigits = digits.map(d => IndexLevel.encodeNumberValue(d))
        .sort((a,b) => lexicographicalCompare(a, b));

      digits.forEach((n,i) => expect(encodedDigits.at(i)).toBe(IndexLevel.encodeNumberValue(n)));
    });
  });

  describe('isFilterConcise', () => {
    const queryOptionsWithCursor = { sortProperty: 'sort', cursor: { messageCid: 'messageCid', value: 'value' } };
    const queryOptionsWithoutCursor = { sortProperty: 'sort' };

    it('recordId is always concise', async () => {
      expect(IndexLevel.isFilterConcise({ recordId: 'record-id' }, queryOptionsWithCursor)).toBe(true);
      expect(IndexLevel.isFilterConcise({ recordId: 'record-id' }, queryOptionsWithoutCursor)).toBe(true);
    });

    it('other than if `recordId` exists, if a cursor exists it is never concise', async () => {
      expect(IndexLevel.isFilterConcise({ schema: 'schema', contextId: 'contextId', parentId: 'parentId' }, queryOptionsWithCursor)).toBe(false);

      // control
      expect(IndexLevel.isFilterConcise({ schema: 'schema', contextId: 'contextId', parentId: 'parentId' }, queryOptionsWithoutCursor)).toBe(true);
      expect(IndexLevel.isFilterConcise({ recordId: 'record-id' }, queryOptionsWithCursor)).toBe(true);
    });

    it('if there is no cursor -  protocolPath, contextId, parentId, or schema return a concise filter', async () => {
      expect(IndexLevel.isFilterConcise({ protocolPath: 'protocolPath' }, queryOptionsWithoutCursor)).toBe(true);
      expect(IndexLevel.isFilterConcise({ protocolPath: 'protocolPath' }, queryOptionsWithCursor)).toBe(false); // control

      expect(IndexLevel.isFilterConcise({ contextId: 'contextId' }, queryOptionsWithoutCursor)).toBe(true);
      expect(IndexLevel.isFilterConcise({ contextId: 'contextId' }, queryOptionsWithCursor)).toBe(false); // control

      expect(IndexLevel.isFilterConcise({ contextId: 'parentId' }, queryOptionsWithoutCursor)).toBe(true);
      expect(IndexLevel.isFilterConcise({ contextId: 'parentId' }, queryOptionsWithCursor)).toBe(false); // control

      expect(IndexLevel.isFilterConcise({ contextId: 'schema' }, queryOptionsWithoutCursor)).toBe(true);
      expect(IndexLevel.isFilterConcise({ contextId: 'schema' }, queryOptionsWithCursor)).toBe(false); // control
    });

    it('if there is no cursor, and it is not one of the conditions, return not concise', async () => {
      expect(IndexLevel.isFilterConcise({ dataSize: { gt: 123 } }, queryOptionsWithoutCursor)).toBe(false);

      // control
      expect(IndexLevel.isFilterConcise({ schema: 'schema', contextId: 'contextId', parentId: 'parentId' }, queryOptionsWithoutCursor)).toBe(true);
    });

    it('if protocol filter exists by itself it is not a concise filter', async () => {
      expect(IndexLevel.isFilterConcise({ protocol: 'protocol' }, queryOptionsWithoutCursor)).toBe(false);

      // control
      expect(IndexLevel.isFilterConcise({ protocol: 'protocol', protocolPath: 'path/to' }, queryOptionsWithoutCursor)).toBe(true);
    });
  });

  describe('compound indexes', () => {
    const compoundIndexes: CompoundIndexDefinition[] = [
      {
        name         : 'protocol-protocolPath-messageTimestamp',
        properties   : ['protocol', 'protocolPath'],
        sortProperty : 'messageTimestamp',
      },
      {
        name         : 'schema-dateCreated',
        properties   : ['schema'],
        sortProperty : 'dateCreated',
      },
    ];
    let compoundIndex: IndexLevel;
    const compoundTenant = 'did:alice:compound-test';

    beforeAll(async () => {
      compoundIndex = new IndexLevel({
        createLevelDatabase,
        location        : 'TEST-COMPOUND-INDEX',
        compoundIndexes : compoundIndexes,
      });
      await compoundIndex.open();
    });

    beforeEach(async () => {
      await compoundIndex.clear();
    });

    afterAll(async () => {
      await compoundIndex.close();
    });

    describe('put and delete lifecycle', () => {
      it('should create compound index entries during put', async () => {
        const id = uuid();
        await compoundIndex.put(compoundTenant, id, {
          protocol         : 'https://protocol.xyz',
          protocolPath     : 'chat/message',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
          schema           : 'https://schema.org/Message',
          dateCreated      : '2024-01-15T10:00:00.000000Z',
        });

        // query using compound index (protocol + protocolPath sorted by messageTimestamp)
        const results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://protocol.xyz', protocolPath: 'chat/message' }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(results).toHaveLength(1);
        expect(results[0].messageCid).toBe(id);
      });

      it('should delete compound index entries during delete', async () => {
        const id = uuid();
        await compoundIndex.put(compoundTenant, id, {
          protocol         : 'https://protocol.xyz',
          protocolPath     : 'chat/message',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
          schema           : 'https://schema.org/Message',
          dateCreated      : '2024-01-15T10:00:00.000000Z',
        });

        // verify it exists
        let results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://protocol.xyz', protocolPath: 'chat/message' }],
          { sortProperty: 'messageTimestamp' }
        );
        expect(results).toHaveLength(1);

        // delete
        await compoundIndex.delete(compoundTenant, id);

        // verify compound index entries are removed
        results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://protocol.xyz', protocolPath: 'chat/message' }],
          { sortProperty: 'messageTimestamp' }
        );
        expect(results).toHaveLength(0);
      });

      it('should skip compound index entries when required properties are missing', async () => {
        const id = uuid();
        // only has schema, not protocol+protocolPath
        await compoundIndex.put(compoundTenant, id, {
          schema      : 'https://schema.org/Message',
          dateCreated : '2024-01-15T10:00:00.000000Z',
        });

        // the protocol+protocolPath compound index should not have entries
        // query via the schema compound index should still work
        const schemaResults = await compoundIndex.query(
          compoundTenant,
          [{ schema: 'https://schema.org/Message' }],
          { sortProperty: 'dateCreated' }
        );
        expect(schemaResults).toHaveLength(1);
        expect(schemaResults[0].messageCid).toBe(id);
      });
    });

    describe('queryWithCompoundIndex()', () => {
      it('should return results sorted ascending by the sort property', async () => {
        const ids = ['msg-c', 'msg-a', 'msg-b'];
        const timestamps = [
          '2024-01-15T12:00:00.000000Z',
          '2024-01-15T10:00:00.000000Z',
          '2024-01-15T11:00:00.000000Z',
        ];

        for (let i = 0; i < ids.length; i++) {
          await compoundIndex.put(compoundTenant, ids[i], {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'thread/post',
            messageTimestamp : timestamps[i],
          });
        }

        const results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'thread/post' }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(results).toHaveLength(3);
        expect(results.map(r => r.messageCid)).toEqual(['msg-a', 'msg-b', 'msg-c']);
      });

      it('should return results sorted descending by the sort property', async () => {
        const ids = ['msg-c', 'msg-a', 'msg-b'];
        const timestamps = [
          '2024-01-15T12:00:00.000000Z',
          '2024-01-15T10:00:00.000000Z',
          '2024-01-15T11:00:00.000000Z',
        ];

        for (let i = 0; i < ids.length; i++) {
          await compoundIndex.put(compoundTenant, ids[i], {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'thread/post',
            messageTimestamp : timestamps[i],
          });
        }

        const results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'thread/post' }],
          { sortProperty: 'messageTimestamp', sortDirection: SortDirection.Descending }
        );

        expect(results).toHaveLength(3);
        expect(results.map(r => r.messageCid)).toEqual(['msg-c', 'msg-b', 'msg-a']);
      });

      it('should support limit', async () => {
        for (let i = 0; i < 5; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
          });
        }

        const results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp', limit: 3 }
        );

        expect(results).toHaveLength(3);
        expect(results.map(r => r.messageCid)).toEqual(['msg-0', 'msg-1', 'msg-2']);
      });

      it('should support cursor pagination ascending', async () => {
        for (let i = 0; i < 6; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
          });
        }

        // first page
        const page1 = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp', limit: 3 }
        );
        expect(page1).toHaveLength(3);
        expect(page1.map(r => r.messageCid)).toEqual(['msg-0', 'msg-1', 'msg-2']);

        // second page using cursor
        const cursor = IndexLevel.createCursorFromLastArrayItem(page1, 'messageTimestamp');
        const page2 = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp', cursor }
        );
        expect(page2).toHaveLength(3);
        expect(page2.map(r => r.messageCid)).toEqual(['msg-3', 'msg-4', 'msg-5']);
      });

      it('should support cursor pagination descending', async () => {
        for (let i = 0; i < 6; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
          });
        }

        // first page descending
        const page1 = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp', sortDirection: SortDirection.Descending, limit: 3 }
        );
        expect(page1).toHaveLength(3);
        expect(page1.map(r => r.messageCid)).toEqual(['msg-5', 'msg-4', 'msg-3']);

        // second page descending using cursor
        const cursor = IndexLevel.createCursorFromLastArrayItem(page1, 'messageTimestamp');
        const page2 = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp', sortDirection: SortDirection.Descending, cursor }
        );
        expect(page2).toHaveLength(3);
        expect(page2.map(r => r.messageCid)).toEqual(['msg-2', 'msg-1', 'msg-0']);
      });

      it('should verify residual filter properties in memory', async () => {
        // insert records with same protocol+protocolPath but different 'published' values
        for (let i = 0; i < 4; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
            published        : i % 2 === 0, // msg-0: true, msg-1: false, msg-2: true, msg-3: false
          });
        }

        // compound index covers protocol+protocolPath+messageTimestamp but NOT published
        // published should be verified as a residual filter
        const results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items', published: true }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(results).toHaveLength(2);
        expect(results.map(r => r.messageCid)).toEqual(['msg-0', 'msg-2']);
      });

      it('should only return results matching the specific filter values', async () => {
        // insert records with different protocol paths
        await compoundIndex.put(compoundTenant, 'msg-1', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'thread/post',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
        });
        await compoundIndex.put(compoundTenant, 'msg-2', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'thread/reply',
          messageTimestamp : '2024-01-15T11:00:00.000000Z',
        });
        await compoundIndex.put(compoundTenant, 'msg-3', {
          protocol         : 'https://other.xyz',
          protocolPath     : 'thread/post',
          messageTimestamp : '2024-01-15T12:00:00.000000Z',
        });

        // query for only protocol.xyz + thread/post
        const results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'thread/post' }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(results).toHaveLength(1);
        expect(results[0].messageCid).toBe('msg-1');
      });

      it('should fall back to non-compound strategy for OR (multi-filter) queries', async () => {
        await compoundIndex.put(compoundTenant, 'msg-1', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'thread/post',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
        });
        await compoundIndex.put(compoundTenant, 'msg-2', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'thread/reply',
          messageTimestamp : '2024-01-15T11:00:00.000000Z',
        });

        // OR queries (multiple filters) should still work via fallback strategies
        const results = await compoundIndex.query(
          compoundTenant,
          [
            { protocol: 'https://proto.xyz', protocolPath: 'thread/post' },
            { protocol: 'https://proto.xyz', protocolPath: 'thread/reply' },
          ],
          { sortProperty: 'messageTimestamp' }
        );

        expect(results).toHaveLength(2);
      });

      it('should prefer the compound index with the most properties', async () => {
        // both compound indexes could potentially match a query with schema + dateCreated
        // but only the schema-dateCreated one actually applies
        // also, the protocol-protocolPath-messageTimestamp index should be preferred over
        // a hypothetical single-property index when both protocol and protocolPath are present

        await compoundIndex.put(compoundTenant, 'msg-1', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'items',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
          schema           : 'https://schema.org/Item',
          dateCreated      : '2024-01-15T10:00:00.000000Z',
        });

        // query using schema compound index
        const schemaResults = await compoundIndex.query(
          compoundTenant,
          [{ schema: 'https://schema.org/Item' }],
          { sortProperty: 'dateCreated' }
        );
        expect(schemaResults).toHaveLength(1);
        expect(schemaResults[0].messageCid).toBe('msg-1');

        // query using protocol+protocolPath compound index
        const protocolResults = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp' }
        );
        expect(protocolResults).toHaveLength(1);
        expect(protocolResults[0].messageCid).toBe('msg-1');
      });

      it('should not use compound index when sort property does not match', async () => {
        await compoundIndex.put(compoundTenant, 'msg-1', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'items',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
          schema           : 'https://schema.org/Item',
          dateCreated      : '2024-01-15T10:00:00.000000Z',
        });

        // query with protocol+protocolPath but sort by dateCreated (not messageTimestamp)
        // this should NOT use the protocol-protocolPath-messageTimestamp compound index
        // it should still return correct results via fallback strategy
        const results = await compoundIndex.query(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'dateCreated' }
        );
        expect(results).toHaveLength(1);
      });
    });

    describe('count()', () => {
      it('should count items matching a compound index filter', async () => {
        for (let i = 0; i < 10; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
          });
        }

        // add some non-matching records
        for (let i = 0; i < 5; i++) {
          await compoundIndex.put(compoundTenant, `other-${i}`, {
            protocol         : 'https://other.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
          });
        }

        const count = await compoundIndex.count(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(count).toBe(10);
      });

      it('should count items with residual filter verification', async () => {
        for (let i = 0; i < 6; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
            published        : i % 2 === 0, // msg-0: true, msg-1: false, msg-2: true, msg-3: false, msg-4: true, msg-5: false
          });
        }

        const count = await compoundIndex.count(
          compoundTenant,
          [{ protocol: 'https://proto.xyz', protocolPath: 'items', published: true }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(count).toBe(3); // msg-0, msg-2, msg-4
      });

      it('should return 0 when no items match', async () => {
        await compoundIndex.put(compoundTenant, 'msg-1', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'items',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
        });

        const count = await compoundIndex.count(
          compoundTenant,
          [{ protocol: 'https://nonexistent.xyz', protocolPath: 'items' }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(count).toBe(0);
      });

      it('should fall back to full query for non-compound-index filters', async () => {
        for (let i = 0; i < 4; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            protocol         : 'https://proto.xyz',
            protocolPath     : 'items',
            messageTimestamp : `2024-01-15T1${i}:00:00.000000Z`,
            published        : i < 2,
          });
        }

        // filter by 'published' alone — no compound index covers this
        const count = await compoundIndex.count(
          compoundTenant,
          [{ published: true }],
          { sortProperty: 'messageTimestamp' }
        );

        expect(count).toBe(2);
      });

      it('should count correctly with OR (multi-filter) queries', async () => {
        await compoundIndex.put(compoundTenant, 'msg-1', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'thread/post',
          messageTimestamp : '2024-01-15T10:00:00.000000Z',
        });
        await compoundIndex.put(compoundTenant, 'msg-2', {
          protocol         : 'https://proto.xyz',
          protocolPath     : 'thread/reply',
          messageTimestamp : '2024-01-15T11:00:00.000000Z',
        });
        await compoundIndex.put(compoundTenant, 'msg-3', {
          protocol         : 'https://other.xyz',
          protocolPath     : 'thread/post',
          messageTimestamp : '2024-01-15T12:00:00.000000Z',
        });

        // OR query — compound index can't serve this, falls back
        const count = await compoundIndex.count(
          compoundTenant,
          [
            { protocol: 'https://proto.xyz', protocolPath: 'thread/post' },
            { protocol: 'https://proto.xyz', protocolPath: 'thread/reply' },
          ],
          { sortProperty: 'messageTimestamp' }
        );

        expect(count).toBe(2);
      });
    });

    describe('query() dispatch selects compound index when available', () => {
      it('should use compound index for matching single-filter queries with cursor', async () => {
        // compound indexes support cursors natively, unlike in-memory paging
        // which would normally reject a cursor with "concise" filters
        for (let i = 0; i < 6; i++) {
          await compoundIndex.put(compoundTenant, `msg-${i}`, {
            schema      : 'https://schema.org/Item',
            dateCreated : `2024-01-15T1${i}:00:00.000000Z`,
          });
        }

        // first page
        const page1 = await compoundIndex.query(
          compoundTenant,
          [{ schema: 'https://schema.org/Item' }],
          { sortProperty: 'dateCreated', limit: 3 }
        );
        expect(page1).toHaveLength(3);
        expect(page1.map(r => r.messageCid)).toEqual(['msg-0', 'msg-1', 'msg-2']);

        // second page with cursor — this should still use the compound index
        const cursor = IndexLevel.createCursorFromLastArrayItem(page1, 'dateCreated');
        const page2 = await compoundIndex.query(
          compoundTenant,
          [{ schema: 'https://schema.org/Item' }],
          { sortProperty: 'dateCreated', cursor }
        );
        expect(page2).toHaveLength(3);
        expect(page2.map(r => r.messageCid)).toEqual(['msg-3', 'msg-4', 'msg-5']);
      });
    });
  });
});
