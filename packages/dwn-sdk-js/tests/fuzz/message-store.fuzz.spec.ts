import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Message } from '../../src/core/message.js';
import { MessageStoreLevel } from '../../src/store/message-store-level.js';
import { SortDirection } from '../../src/types/query-types.js';
import { genericMessage, genericMessageSet, indexKeyValues, tenantDid } from './arbitraries/store.arbitrary.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('MessageStoreLevel — fuzz', () => {
  let messageStore: MessageStoreLevel;
  const testDataPath = '__TESTDATA__/fuzz-message-store';
  const tenant = 'did:example:fuzz-message-tenant';

  beforeAll(async () => {
    messageStore = new MessageStoreLevel({
      blockstoreLocation : `${testDataPath}/blocks`,
      indexLocation      : `${testDataPath}/index`,
    });
    await messageStore.open();
  });

  afterEach(async () => {
    await messageStore.clear();
  });

  afterAll(async () => {
    await messageStore.close();
  });

  describe('put/get CID roundtrip', () => {
    it('should store and retrieve any message by its computed CID', async () => {
      await fc.assert(
        fc.asyncProperty(
          genericMessage(),
          indexKeyValues(),
          async (message, indexes) => {
            await messageStore.clear();

            // Ensure indexes include the message's own timestamp
            indexes.messageTimestamp = message.descriptor.messageTimestamp;

            await messageStore.put(tenant, message, indexes);

            const cid = await Message.getCid(message);
            const retrieved = await messageStore.get(tenant, cid);

            expect(retrieved).toBeDefined();
            expect(retrieved!.descriptor.interface).toBe(message.descriptor.interface);
            expect(retrieved!.descriptor.method).toBe(message.descriptor.method);
            expect(retrieved!.descriptor.messageTimestamp).toBe(message.descriptor.messageTimestamp);

            // The retrieved CID should match the original
            const retrievedCid = await Message.getCid(retrieved!);
            expect(retrievedCid).toBe(cid);
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('get returns undefined for missing CID', () => {
    it('should return undefined for a CID that was never stored', async () => {
      await fc.assert(
        fc.asyncProperty(
          genericMessage(),
          async (message) => {
            // Don't store the message — just compute its CID
            const cid = await Message.getCid(message);

            const retrieved = await messageStore.get(tenant, cid);
            expect(retrieved).toBeUndefined();
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('put/delete roundtrip', () => {
    it('should return undefined after deleting a message', async () => {
      await fc.assert(
        fc.asyncProperty(
          genericMessage(),
          indexKeyValues(),
          async (message, indexes) => {
            await messageStore.clear();

            indexes.messageTimestamp = message.descriptor.messageTimestamp;
            await messageStore.put(tenant, message, indexes);

            const cid = await Message.getCid(message);
            await messageStore.delete(tenant, cid);

            const retrieved = await messageStore.get(tenant, cid);
            expect(retrieved).toBeUndefined();
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('tenant isolation', () => {
    it('should not allow one tenant to read another tenant\'s messages', async () => {
      await fc.assert(
        fc.asyncProperty(
          tenantDid(),
          tenantDid(),
          genericMessage(),
          indexKeyValues(),
          async (tenant1, tenant2, message, indexes) => {
            if (tenant1 === tenant2) { return; }

            await messageStore.clear();

            indexes.messageTimestamp = message.descriptor.messageTimestamp;
            await messageStore.put(tenant1, message, indexes);

            const cid = await Message.getCid(message);
            const retrieved = await messageStore.get(tenant2, cid);
            expect(retrieved).toBeUndefined();
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });

  describe('count consistency', () => {
    it('should return the same count as query results length', async () => {
      await fc.assert(
        fc.asyncProperty(
          genericMessageSet({ minSize: 2, maxSize: 8 }),
          async (items) => {
            await messageStore.clear();

            for (const { message, indexes } of items) {
              indexes.messageTimestamp = message.descriptor.messageTimestamp;
              await messageStore.put(tenant, message, indexes);
            }

            const messageSort = { messageTimestamp: SortDirection.Ascending };
            const count = await messageStore.count(tenant, [{}], messageSort);
            const { messages } = await messageStore.query(tenant, [{}], messageSort);

            expect(count).toBe(messages.length);
          }
        ),
        { numRuns: Math.min(numRuns, 15) }
      );
    });
  });

  describe('pagination completeness', () => {
    it('should yield all messages when paginating with any page size', async () => {
      await fc.assert(
        fc.asyncProperty(
          genericMessageSet({ minSize: 3, maxSize: 8 }),
          fc.integer({ min: 1, max: 4 }),
          async (items, pageSize) => {
            await messageStore.clear();

            for (const { message, indexes } of items) {
              indexes.messageTimestamp = message.descriptor.messageTimestamp;
              await messageStore.put(tenant, message, indexes);
            }

            const messageSort = { messageTimestamp: SortDirection.Ascending };

            // Get all results without pagination for reference
            const { messages: allMessages } = await messageStore.query(tenant, [{}], messageSort);

            // Paginate through all results
            const paginatedCids: string[] = [];
            let cursor = undefined;
            let iterations = 0;
            const maxIterations = allMessages.length + 5; // safety bound

            while (iterations < maxIterations) {
              const { messages: page, cursor: nextCursor } = await messageStore.query(
                tenant, [{}], messageSort, { limit: pageSize, cursor }
              );

              if (page.length === 0) { break; }

              for (const msg of page) {
                paginatedCids.push(await Message.getCid(msg));
              }

              if (!nextCursor) { break; }
              cursor = nextCursor;
              iterations++;
            }

            // All CIDs from pagination should match all CIDs from full query
            const allCids: string[] = [];
            for (const msg of allMessages) {
              allCids.push(await Message.getCid(msg));
            }
            expect(paginatedCids).toEqual(allCids);
          }
        ),
        { numRuns: Math.min(numRuns, 10) }
      );
    });
  });

  describe('idempotent put', () => {
    it('should allow putting the same message twice without error', async () => {
      await fc.assert(
        fc.asyncProperty(
          genericMessage(),
          indexKeyValues(),
          async (message, indexes) => {
            await messageStore.clear();

            indexes.messageTimestamp = message.descriptor.messageTimestamp;

            // Put the same message twice
            await messageStore.put(tenant, message, indexes);
            await messageStore.put(tenant, message, indexes);

            const cid = await Message.getCid(message);
            const retrieved = await messageStore.get(tenant, cid);
            expect(retrieved).toBeDefined();

            // Should still only count as one message
            const count = await messageStore.count(tenant, [{}], { messageTimestamp: SortDirection.Ascending });
            expect(count).toBe(1);
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });
});
