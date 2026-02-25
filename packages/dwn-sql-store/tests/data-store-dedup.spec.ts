import type { DwnDatabaseType } from '../src/types.js';

import { DataStoreSql } from '../src/data-store-sql.js';
import { Kysely } from 'kysely';
import { runDwnStoreMigrations } from '../src/migration-runner.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Cid, DataStream } from '@enbox/dwn-sdk-js';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

describe('DataStoreSql — content-addressed dedup', () => {
  const databaseDialects = [testMysqlDialect, testPostgresDialect, testSqliteDialect];

  for (const dialect of databaseDialects) {
    describe(`${dialect.name}`, () => {
      let store: DataStoreSql;
      let db: Kysely<DwnDatabaseType>;

      beforeAll(async () => {
        db = new Kysely<DwnDatabaseType>({ dialect });
        await runDwnStoreMigrations(db, dialect);

        store = new DataStoreSql(dialect);
        await store.open();
      });

      afterEach(async () => {
        await store.clear();
      });

      afterAll(async () => {
        await store.close();
        await db.destroy();
      });

      /**
       * Helper: compute a dataCid from bytes and create a ReadableStream.
       */
      async function prepareData(content: string): Promise<{ dataCid: string; dataStream: ReadableStream<Uint8Array>; bytes: Uint8Array }> {
        const bytes = new TextEncoder().encode(content);
        const dataCid = await Cid.computeDagPbCidFromBytes(bytes);
        const dataStream = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        return { dataCid, dataStream, bytes };
      }

      /**
       * Helper: create a fresh ReadableStream from bytes.
       */
      function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }

      // ─── Dedup on put ───────────────────────────────────────────────

      it('should deduplicate blocks when two records share the same dataCid', async () => {
        const { dataCid, dataStream, bytes } = await prepareData('shared content for dedup test');

        // First put stores blocks.
        const result1 = await store.put('did:example:alice', 'rec-1', dataCid, dataStream);
        expect(result1.dataSize).toBe(bytes.length);

        // Second put with the same dataCid should skip block storage.
        const result2 = await store.put('did:example:bob', 'rec-2', dataCid, streamFrom(bytes));
        expect(result2.dataSize).toBe(bytes.length);

        // Verify: two refs exist.
        const refs = await db.selectFrom('dataRefs').selectAll().execute();
        expect(refs.length).toBe(2);

        // Verify: blocks are stored only once (one set of blocks for this dataCid).
        const blocks = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', dataCid)
          .execute();

        // For small data, the importer produces 1 block (root = leaf).
        expect(blocks.length).toBe(1);

        // Both records should be readable.
        const get1 = await store.get('did:example:alice', 'rec-1', dataCid);
        expect(get1).toBeDefined();
        expect(get1!.dataSize).toBe(bytes.length);
        const readBytes1 = await DataStream.toBytes(get1!.dataStream);
        expect(new TextDecoder().decode(readBytes1)).toBe('shared content for dedup test');

        const get2 = await store.get('did:example:bob', 'rec-2', dataCid);
        expect(get2).toBeDefined();
        expect(get2!.dataSize).toBe(bytes.length);
      });

      it('should return correct dataSize on dedup put', async () => {
        const { dataCid, dataStream, bytes } = await prepareData('size verification data');

        await store.put('did:example:t1', 'rec-a', dataCid, dataStream);
        const result = await store.put('did:example:t2', 'rec-b', dataCid, streamFrom(bytes));

        expect(result.dataSize).toBe(bytes.length);
      });

      it('should be idempotent — putting the same (tenant, recordId, dataCid) twice is a no-op', async () => {
        const { dataCid, dataStream, bytes } = await prepareData('idempotent data');

        const result1 = await store.put('did:example:alice', 'rec-1', dataCid, dataStream);
        const result2 = await store.put('did:example:alice', 'rec-1', dataCid, streamFrom(bytes));

        expect(result1.dataSize).toBe(result2.dataSize);

        // Only one ref should exist.
        const refs = await db.selectFrom('dataRefs').selectAll().execute();
        expect(refs.length).toBe(1);
      });

      // ─── GC on delete ──────────────────────────────────────────────

      it('should keep blocks when deleting one ref but another ref still exists', async () => {
        const { dataCid, dataStream, bytes } = await prepareData('gc test data');

        await store.put('did:example:alice', 'rec-1', dataCid, dataStream);
        await store.put('did:example:bob', 'rec-2', dataCid, streamFrom(bytes));

        // Delete Alice's ref.
        await store.delete('did:example:alice', 'rec-1', dataCid);

        // Blocks should still exist (Bob's ref keeps them alive).
        const blocks = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', dataCid)
          .execute();
        expect(blocks.length).toBeGreaterThan(0);

        // Bob can still read the data.
        const get = await store.get('did:example:bob', 'rec-2', dataCid);
        expect(get).toBeDefined();
        expect(get!.dataSize).toBe(bytes.length);
      });

      it('should garbage-collect blocks when the last ref is deleted', async () => {
        const { dataCid, dataStream, bytes } = await prepareData('gc cleanup data');

        await store.put('did:example:alice', 'rec-1', dataCid, dataStream);
        await store.put('did:example:bob', 'rec-2', dataCid, streamFrom(bytes));

        // Delete both refs.
        await store.delete('did:example:alice', 'rec-1', dataCid);
        await store.delete('did:example:bob', 'rec-2', dataCid);

        // Blocks should be garbage-collected.
        const blocks = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', dataCid)
          .execute();
        expect(blocks.length).toBe(0);

        // No refs should remain.
        const refs = await db.selectFrom('dataRefs').selectAll().execute();
        expect(refs.length).toBe(0);
      });

      it('should garbage-collect blocks when single ref is deleted', async () => {
        const { dataCid, dataStream } = await prepareData('single ref gc');

        await store.put('did:example:alice', 'rec-1', dataCid, dataStream);
        await store.delete('did:example:alice', 'rec-1', dataCid);

        const blocks = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', dataCid)
          .execute();
        expect(blocks.length).toBe(0);
      });

      // ─── Isolation between different dataCids ──────────────────────

      it('should store different dataCids independently', async () => {
        const data1 = await prepareData('content A');
        const data2 = await prepareData('content B');

        await store.put('did:example:alice', 'rec-1', data1.dataCid, data1.dataStream);
        await store.put('did:example:alice', 'rec-2', data2.dataCid, data2.dataStream);

        // Each dataCid has its own blocks.
        const blocks1 = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', data1.dataCid)
          .execute();
        const blocks2 = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', data2.dataCid)
          .execute();

        expect(blocks1.length).toBeGreaterThan(0);
        expect(blocks2.length).toBeGreaterThan(0);

        // Deleting one doesn't affect the other.
        await store.delete('did:example:alice', 'rec-1', data1.dataCid);

        const get2 = await store.get('did:example:alice', 'rec-2', data2.dataCid);
        expect(get2).toBeDefined();
        expect(get2!.dataSize).toBe(data2.bytes.length);

        // Blocks for dataCid1 are GC'd, dataCid2 blocks remain.
        const remainingBlocks1 = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', data1.dataCid)
          .execute();
        expect(remainingBlocks1.length).toBe(0);

        const remainingBlocks2 = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', data2.dataCid)
          .execute();
        expect(remainingBlocks2.length).toBeGreaterThan(0);
      });

      // ─── get returns undefined for missing refs ────────────────────

      it('should return undefined for a non-existent ref', async () => {
        const result = await store.get('did:example:nobody', 'no-record', 'bafkreinotfound');
        expect(result).toBeUndefined();
      });

      // ─── delete is a no-op for non-existent refs ───────────────────

      it('should not throw when deleting a non-existent ref', async () => {
        // Should not throw.
        await store.delete('did:example:nobody', 'no-record', 'bafkreinotfound');
      });

      // ─── Orphaned blocks edge case ──────────────────────────────────

      it('should handle orphaned blocks — blocks exist but no reference row', async () => {
        // This tests the edge case at data-store-sql.ts lines 137-140:
        // blocks exist for a dataCid but no ref row exists (e.g. interrupted previous put).
        // The code path falls through to counting stream bytes.
        const { dataCid, dataStream, bytes } = await prepareData('orphan test data');

        // First, store the data normally to create both blocks and a ref.
        await store.put('did:example:alice', 'rec-1', dataCid, dataStream);

        // Now delete ONLY the ref, leaving blocks orphaned.
        await db
          .deleteFrom('dataRefs')
          .where('dataCid', '=', dataCid)
          .execute();

        // Verify blocks still exist but refs are gone.
        const blocksAfterDelete = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .where('rootDataCid', '=', dataCid)
          .execute();
        expect(blocksAfterDelete.length).toBeGreaterThan(0);

        const refsAfterDelete = await db
          .selectFrom('dataRefs')
          .selectAll()
          .where('dataCid', '=', dataCid)
          .execute();
        expect(refsAfterDelete.length).toBe(0);

        // Now put again with same dataCid — should hit the orphaned blocks path.
        // blocks exist (blocksExist=true) but no ref (otherRef=undefined),
        // so it uses countStreamBytes to get the data size.
        const result = await store.put('did:example:bob', 'rec-2', dataCid, streamFrom(bytes));
        expect(result.dataSize).toBe(bytes.length);

        // A new ref should have been created.
        const newRefs = await db
          .selectFrom('dataRefs')
          .selectAll()
          .where('dataCid', '=', dataCid)
          .execute();
        expect(newRefs.length).toBe(1);
        expect(newRefs[0].recordId).toBe('rec-2');
      });

      // ─── clear removes everything ──────────────────────────────────

      it('should remove all refs and blocks on clear', async () => {
        const data1 = await prepareData('clear test A');
        const data2 = await prepareData('clear test B');

        await store.put('did:example:alice', 'rec-1', data1.dataCid, data1.dataStream);
        await store.put('did:example:bob', 'rec-2', data2.dataCid, data2.dataStream);

        await store.clear();

        const refs = await db.selectFrom('dataRefs').selectAll().execute();
        const blocks = await db.selectFrom('dataBlocks').selectAll().execute();

        expect(refs.length).toBe(0);
        expect(blocks.length).toBe(0);
      });
    });
  }
});
