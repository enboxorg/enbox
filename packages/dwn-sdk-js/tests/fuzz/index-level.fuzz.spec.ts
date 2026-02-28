import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { IndexLevel } from '../../src/store/index-level.js';
import { SortDirection } from '../../src/types/query-types.js';
import { indexedItemSet, indexKeyValues, messageCid } from './arbitraries/store.arbitrary.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('IndexLevel — fuzz', () => {
  let indexLevel: IndexLevel;
  const testDataPath = '__TESTDATA__/fuzz-index-level';
  const tenant = 'did:example:fuzz-tenant';

  beforeAll(async () => {
    indexLevel = new IndexLevel({ location: `${testDataPath}/index` });
    await indexLevel.open();
  });

  afterEach(async () => {
    await indexLevel.clear();
  });

  afterAll(async () => {
    await indexLevel.close();
  });

  describe('encodeNumberValue — order preservation', () => {
    it('should preserve order for any two integers: a < b implies encode(a) < encode(b)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
          (a, b) => {
            const encodedA = IndexLevel.encodeNumberValue(a);
            const encodedB = IndexLevel.encodeNumberValue(b);
            if (a < b) {
              expect(encodedA < encodedB).toBe(true);
            } else if (a > b) {
              expect(encodedA > encodedB).toBe(true);
            } else {
              expect(encodedA).toBe(encodedB);
            }
          }
        ),
        { numRuns }
      );
    });

    it('should produce consistent results for the same input', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
          (n) => {
            expect(IndexLevel.encodeNumberValue(n)).toBe(IndexLevel.encodeNumberValue(n));
          }
        ),
        { numRuns }
      );
    });
  });

  describe('encodeValue — type consistency', () => {
    it('should return a string for any supported value type', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ minLength: 0, maxLength: 50 }),
            fc.integer({ min: -10000, max: 10000 }),
            fc.boolean(),
          ),
          (value) => {
            const encoded = IndexLevel.encodeValue(value);
            expect(typeof encoded).toBe('string');
            expect(encoded.length).toBeGreaterThan(0);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('put/query roundtrip', () => {
    it('should find an item by any of its indexed properties after put', async () => {
      await fc.assert(
        fc.asyncProperty(
          messageCid(),
          indexKeyValues(),
          async (cid, indexes) => {
            await indexLevel.clear();
            await indexLevel.put(tenant, cid, indexes);

            // Query using the first string/number property as an equality filter
            for (const [key, value] of Object.entries(indexes)) {
              if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                const results = await indexLevel.query(tenant, [{ [key]: value }], {
                  sortProperty  : 'messageTimestamp',
                  sortDirection : SortDirection.Ascending,
                });
                const foundCids = results.map((r) => r.messageCid);
                expect(foundCids).toContain(cid);
                break; // one property is enough to verify the roundtrip
              }
            }
          }
        ),
        { numRuns: Math.min(numRuns, 50) }
      );
    });
  });

  describe('put/delete roundtrip', () => {
    it('should not find an item after deletion', async () => {
      await fc.assert(
        fc.asyncProperty(
          messageCid(),
          indexKeyValues(),
          async (cid, indexes) => {
            await indexLevel.clear();
            await indexLevel.put(tenant, cid, indexes);
            await indexLevel.delete(tenant, cid);

            // Query with empty filter should return nothing
            const results = await indexLevel.query(tenant, [{}], {
              sortProperty  : 'messageTimestamp',
              sortDirection : SortDirection.Ascending,
            });
            const foundCids = results.map((r) => r.messageCid);
            expect(foundCids).not.toContain(cid);
          }
        ),
        { numRuns: Math.min(numRuns, 50) }
      );
    });
  });

  describe('count equals query length', () => {
    it('should return the same count as query results length for any filter', async () => {
      await fc.assert(
        fc.asyncProperty(
          indexedItemSet({ minSize: 3, maxSize: 10 }),
          async (items) => {
            await indexLevel.clear();

            for (const item of items) {
              await indexLevel.put(tenant, item.cid, item.indexes);
            }

            const queryOptions = {
              sortProperty  : 'messageTimestamp',
              sortDirection : SortDirection.Ascending,
            };

            // Count with empty filter
            const count = await indexLevel.count(tenant, [{}], queryOptions);
            const results = await indexLevel.query(tenant, [{}], queryOptions);
            expect(count).toBe(results.length);
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('sort ordering invariant', () => {
    it('should return results sorted by messageTimestamp ascending', async () => {
      await fc.assert(
        fc.asyncProperty(
          indexedItemSet({ minSize: 3, maxSize: 15 }),
          async (items) => {
            await indexLevel.clear();

            for (const item of items) {
              await indexLevel.put(tenant, item.cid, item.indexes);
            }

            const results = await indexLevel.query(tenant, [{}], {
              sortProperty  : 'messageTimestamp',
              sortDirection : SortDirection.Ascending,
            });

            for (let i = 1; i < results.length; i++) {
              const prev = IndexLevel.encodeValue(results[i - 1].indexes.messageTimestamp as string);
              const curr = IndexLevel.encodeValue(results[i].indexes.messageTimestamp as string);
              // When timestamps are equal, the messageCid acts as tiebreaker
              if (prev === curr) {
                expect(results[i - 1].messageCid <= results[i].messageCid).toBe(true);
              } else {
                expect(prev <= curr).toBe(true);
              }
            }
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });

    it('should return results sorted by messageTimestamp descending', async () => {
      await fc.assert(
        fc.asyncProperty(
          indexedItemSet({ minSize: 3, maxSize: 15 }),
          async (items) => {
            await indexLevel.clear();

            for (const item of items) {
              await indexLevel.put(tenant, item.cid, item.indexes);
            }

            const results = await indexLevel.query(tenant, [{}], {
              sortProperty  : 'messageTimestamp',
              sortDirection : SortDirection.Descending,
            });

            for (let i = 1; i < results.length; i++) {
              const prev = IndexLevel.encodeValue(results[i - 1].indexes.messageTimestamp as string);
              const curr = IndexLevel.encodeValue(results[i].indexes.messageTimestamp as string);
              if (prev === curr) {
                expect(results[i - 1].messageCid >= results[i].messageCid).toBe(true);
              } else {
                expect(prev >= curr).toBe(true);
              }
            }
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('pagination completeness', () => {
    it('should yield all items when paginating with any page size', async () => {
      await fc.assert(
        fc.asyncProperty(
          indexedItemSet({ minSize: 3, maxSize: 12 }),
          fc.integer({ min: 1, max: 5 }),
          async (items, pageSize) => {
            await indexLevel.clear();

            for (const item of items) {
              await indexLevel.put(tenant, item.cid, item.indexes);
            }

            const sortProperty = 'messageTimestamp';
            const queryOptions = {
              sortProperty,
              sortDirection : SortDirection.Ascending,
              limit         : pageSize,
            };

            // Get all results without pagination for reference
            const allResults = await indexLevel.query(tenant, [{}], {
              sortProperty,
              sortDirection: SortDirection.Ascending,
            });

            // Paginate through all results
            const paginatedResults: string[] = [];
            let cursor = undefined;
            let iterations = 0;
            const maxIterations = allResults.length + 5; // safety bound

            while (iterations < maxIterations) {
              const page = await indexLevel.query(tenant, [{}], { ...queryOptions, cursor });
              if (page.length === 0) {
                break;
              }

              paginatedResults.push(...page.map((r) => r.messageCid));

              // Create cursor from last item for next page
              if (page.length < pageSize) {
                break; // last page
              }
              cursor = IndexLevel.createCursorFromLastArrayItem(page, sortProperty);
              iterations++;
            }

            // All CIDs from pagination should match all CIDs from full query
            expect(paginatedResults).toEqual(allResults.map((r) => r.messageCid));
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });
});
