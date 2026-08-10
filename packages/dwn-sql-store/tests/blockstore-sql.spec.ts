import type { DwnDatabaseType } from '../src/types.js';
import type { InputPair, Pair } from 'interface-blockstore';

import { BlockstoreSql } from '../src/blockstore-sql.js';
import { CID } from 'multiformats';
import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { Kysely } from 'kysely';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

/**
 * Creates a deterministic CID from an integer index.
 * Uses CIDv1 with raw codec (0x55) and identity multihash (0x00).
 */
function fakeCid(index: number): CID {
  // identity multihash: varint(0x00) + varint(length) + digest
  const digest = new Uint8Array([index & 0xff]);
  const multihash = new Uint8Array([0x00, digest.length, ...digest]);
  return CID.decode(new Uint8Array([
    0x01, // CIDv1
    0x55, // raw codec
    ...multihash,
  ]));
}

async function collectBytes(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

describe('BlockstoreSql', () => {
  const dialect = new SqliteDialect({
    database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> =>
      createBunSqliteDatabase(':memory:', { create: true }),
  });

  let db: Kysely<DwnDatabaseType>;
  let blockstore: BlockstoreSql;
  const rootDataCid = 'bafkreitestroot';

  beforeAll(async () => {
    db = new Kysely<DwnDatabaseType>({ dialect });

    // Create the dataBlocks table matching the schema from DataStoreSql.
    await db.schema
      .createTable('dataBlocks')
      .ifNotExists()
      .addColumn('rootDataCid', 'varchar(60)', (col) => col.notNull())
      .addColumn('blockCid', 'varchar(60)', (col) => col.notNull())
      .addColumn('data', 'blob', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('index_dataBlocks_rootDataCid_blockCid')
      .on('dataBlocks')
      .columns(['rootDataCid', 'blockCid'])
      .unique()
      .execute();
  });

  beforeEach(async () => {
    // Clear all rows between tests.
    await db.deleteFrom('dataBlocks').execute();
    blockstore = new BlockstoreSql(db, rootDataCid);
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ─── open / close ─────────────────────────────────────────────────────

  describe('open() / close()', () => {
    it('should be no-ops and not throw', async () => {
      await expect(blockstore.open()).resolves.toBeUndefined();
      await expect(blockstore.close()).resolves.toBeUndefined();
    });
  });

  // ─── put / get ────────────────────────────────────────────────────────

  describe('put()', () => {
    it('should store a block and return the same CID', async () => {
      const cid = fakeCid(1);
      const data = new Uint8Array([10, 20, 30]);

      const result = await blockstore.put(cid, data);

      expect(result.toString()).toBe(cid.toString());
    });

    it('should be idempotent when the same block is put twice', async () => {
      const cid = fakeCid(6);
      const data = new Uint8Array([1, 2, 3]);

      await blockstore.put(cid, data);
      const result = await blockstore.put(cid, data);

      expect(result.toString()).toBe(cid.toString());
    });
  });

  describe('get()', () => {
    it('should retrieve a previously stored block', async () => {
      const cid = fakeCid(2);
      const data = new Uint8Array([40, 50, 60]);

      await blockstore.put(cid, data);
      const retrieved = await collectBytes(blockstore.get(cid));

      expect(retrieved).toEqual(data);
    });

    it('should throw when block is not found', async () => {
      const cid = fakeCid(99);

      await expect(collectBytes(blockstore.get(cid))).rejects.toThrow('block not found');
    });
  });

  // ─── has ──────────────────────────────────────────────────────────────

  describe('has()', () => {
    it('should return true when block exists', async () => {
      const cid = fakeCid(3);
      await blockstore.put(cid, new Uint8Array([1]));

      expect(await blockstore.has(cid)).toBe(true);
    });

    it('should return false when block does not exist', async () => {
      const cid = fakeCid(100);

      expect(await blockstore.has(cid)).toBe(false);
    });
  });

  // ─── delete ───────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('should delete a block and verify it is gone', async () => {
      const cid = fakeCid(4);
      await blockstore.put(cid, new Uint8Array([7, 8, 9]));

      await blockstore.delete(cid);

      expect(await blockstore.has(cid)).toBe(false);
    });
  });

  // ─── isEmpty ──────────────────────────────────────────────────────────

  describe('isEmpty()', () => {
    it('should return true when no blocks exist for this rootDataCid', async () => {
      expect(await blockstore.isEmpty()).toBe(true);
    });

    it('should return false when blocks exist', async () => {
      await blockstore.put(fakeCid(5), new Uint8Array([1]));

      expect(await blockstore.isEmpty()).toBe(false);
    });
  });

  // ─── putMany ──────────────────────────────────────────────────────────

  describe('putMany()', () => {
    it('should store multiple blocks from an async generator', async () => {
      const pairs: InputPair[] = [
        { cid: fakeCid(10), bytes: new Uint8Array([10]) },
        { cid: fakeCid(11), bytes: new Uint8Array([11]) },
        { cid: fakeCid(12), bytes: new Uint8Array([12]) },
      ];

      async function* source(): AsyncIterable<InputPair> {
        for (const p of pairs) {
          yield p;
        }
      }

      const putCids: CID[] = [];
      for await (const cid of blockstore.putMany(source())) {
        putCids.push(cid);
      }

      expect(putCids).toHaveLength(3);
      expect(putCids[0].toString()).toBe(pairs[0].cid.toString());
      expect(putCids[1].toString()).toBe(pairs[1].cid.toString());
      expect(putCids[2].toString()).toBe(pairs[2].cid.toString());

      // Verify all are retrievable.
      for (const pair of pairs) {
        const data = await collectBytes(blockstore.get(pair.cid));
        expect(data).toEqual(pair.bytes);
      }
    });
  });

  // ─── getMany ──────────────────────────────────────────────────────────

  describe('getMany()', () => {
    it('should retrieve multiple blocks from an async generator of CIDs', async () => {
      const cid1 = fakeCid(20);
      const cid2 = fakeCid(21);
      await blockstore.put(cid1, new Uint8Array([20]));
      await blockstore.put(cid2, new Uint8Array([21]));

      async function* source(): AsyncIterable<CID> {
        yield cid1;
        yield cid2;
      }

      const results: Pair[] = [];
      for await (const pair of blockstore.getMany(source())) {
        results.push(pair);
      }

      expect(results).toHaveLength(2);
      expect(results[0].cid.toString()).toBe(cid1.toString());
      expect(await collectBytes(results[0].bytes)).toEqual(new Uint8Array([20]));
      expect(results[1].cid.toString()).toBe(cid2.toString());
      expect(await collectBytes(results[1].bytes)).toEqual(new Uint8Array([21]));
    });
  });

  // ─── getAll ───────────────────────────────────────────────────────────

  describe('getAll()', () => {
    it('should return all stored pairs for this rootDataCid', async () => {
      const cid1 = fakeCid(30);
      const cid2 = fakeCid(31);
      await blockstore.put(cid1, new Uint8Array([30]));
      await blockstore.put(cid2, new Uint8Array([31]));

      const results: Pair[] = [];
      for await (const pair of blockstore.getAll()) {
        results.push(pair);
      }

      expect(results).toHaveLength(2);

      // Check that both CIDs are present (order may vary).
      const cidStrings = results.map((p) => p.cid.toString()).sort();
      expect(cidStrings).toContain(cid1.toString());
      expect(cidStrings).toContain(cid2.toString());
    });

    it('should return nothing when store is empty', async () => {
      const results: Pair[] = [];
      for await (const pair of blockstore.getAll()) {
        results.push(pair);
      }

      expect(results).toHaveLength(0);
    });
  });

  // ─── deleteMany ───────────────────────────────────────────────────────

  describe('deleteMany()', () => {
    it('should delete multiple blocks from an async generator of CIDs', async () => {
      const cid1 = fakeCid(40);
      const cid2 = fakeCid(41);
      await blockstore.put(cid1, new Uint8Array([40]));
      await blockstore.put(cid2, new Uint8Array([41]));

      async function* source(): AsyncIterable<CID> {
        yield cid1;
        yield cid2;
      }

      const deletedCids: CID[] = [];
      for await (const cid of blockstore.deleteMany(source())) {
        deletedCids.push(cid);
      }

      expect(deletedCids).toHaveLength(2);
      expect(await blockstore.has(cid1)).toBe(false);
      expect(await blockstore.has(cid2)).toBe(false);
    });
  });

  // ─── clear ────────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('should delete all blocks for this rootDataCid', async () => {
      await blockstore.put(fakeCid(50), new Uint8Array([50]));
      await blockstore.put(fakeCid(51), new Uint8Array([51]));

      await blockstore.clear();

      expect(await blockstore.isEmpty()).toBe(true);
    });
  });

  // ─── isolation between rootDataCids ───────────────────────────────────

  describe('rootDataCid isolation', () => {
    it('should not return blocks from a different rootDataCid', async () => {
      const otherStore = new BlockstoreSql(db, 'bafkreiother');
      const cid = fakeCid(60);

      await blockstore.put(cid, new Uint8Array([60]));

      expect(await otherStore.has(cid)).toBe(false);
      expect(await otherStore.isEmpty()).toBe(true);
    });
  });
});
