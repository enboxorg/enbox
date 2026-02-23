import type { DwnDatabaseType } from '../src/types.js';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { Kysely } from 'kysely';
import { SMTStoreSql } from '../src/smt-store-sql.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { hashToHex, hexToHash } from '@enbox/dwn-sdk-js';

describe('SMTStoreSql', () => {
  const dialect = new SqliteDialect({
    database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> =>
      createBunSqliteDatabase(':memory:', { create: true }),
  });

  let db: Kysely<DwnDatabaseType>;
  let store: SMTStoreSql;

  const tenant = 'did:example:alice';
  const scope = 'test-scope';

  beforeAll(async () => {
    db = new Kysely<DwnDatabaseType>({ dialect });

    // Create the stateIndexNodes table.
    await db.schema
      .createTable('stateIndexNodes')
      .ifNotExists()
      .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
      .addColumn('scope', 'varchar(200)', (col) => col.notNull())
      .addColumn('nodeHash', 'varchar(64)', (col) => col.notNull())
      .addColumn('nodeType', 'varchar(10)', (col) => col.notNull())
      .addColumn('leftHash', 'varchar(64)')
      .addColumn('rightHash', 'varchar(64)')
      .addColumn('leafKeyHash', 'varchar(64)')
      .addColumn('leafValueCid', 'varchar(60)')
      .execute();

    // Create the stateIndexRoots table.
    await db.schema
      .createTable('stateIndexRoots')
      .ifNotExists()
      .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
      .addColumn('scope', 'varchar(200)', (col) => col.notNull())
      .addColumn('rootHash', 'varchar(64)', (col) => col.notNull())
      .execute();
  });

  beforeEach(async () => {
    await db.deleteFrom('stateIndexNodes').execute();
    await db.deleteFrom('stateIndexRoots').execute();
    store = new SMTStoreSql({ db, tenant, scope });
  });

  afterAll(async () => {
    await db.destroy();
  });

  /**
   * Helper: create a Hash (Uint8Array) from a simple hex string.
   */
  function makeHash(hexStr: string): Uint8Array {
    return hexToHash(hexStr);
  }

  // ─── open / close ─────────────────────────────────────────────────────

  describe('open() / close()', () => {
    it('should be no-ops and not throw', async () => {
      await store.open();
      await store.close();
    });
  });

  // ─── getNode / putNode ────────────────────────────────────────────────

  describe('putNode() / getNode()', () => {
    it('should store and retrieve an internal node', async () => {
      const hash = makeHash('aa'.repeat(32));
      const leftHash = makeHash('bb'.repeat(32));
      const rightHash = makeHash('cc'.repeat(32));

      await store.putNode(hash, {
        type: 'internal',
        leftHash,
        rightHash,
      });

      const node = await store.getNode(hash);
      expect(node).toBeDefined();
      expect(node!.type).toBe('internal');
      if (node!.type === 'internal') {
        expect(hashToHex(node!.leftHash)).toBe(hashToHex(leftHash));
        expect(hashToHex(node!.rightHash)).toBe(hashToHex(rightHash));
      }
    });

    it('should store and retrieve a leaf node', async () => {
      const hash = makeHash('dd'.repeat(32));
      const keyHash = makeHash('ee'.repeat(32));
      const valueCid = 'bafkreileafvalue';

      await store.putNode(hash, {
        type: 'leaf',
        keyHash,
        valueCid,
      });

      const node = await store.getNode(hash);
      expect(node).toBeDefined();
      expect(node!.type).toBe('leaf');
      if (node!.type === 'leaf') {
        expect(hashToHex(node!.keyHash)).toBe(hashToHex(keyHash));
        expect(node!.valueCid).toBe(valueCid);
      }
    });

    it('should return undefined for a non-existent node', async () => {
      const hash = makeHash('ff'.repeat(32));

      const node = await store.getNode(hash);
      expect(node).toBeUndefined();
    });

    it('should overwrite an existing node (upsert)', async () => {
      const hash = makeHash('11'.repeat(32));
      const leftHash1 = makeHash('22'.repeat(32));
      const rightHash1 = makeHash('33'.repeat(32));
      const leftHash2 = makeHash('44'.repeat(32));
      const rightHash2 = makeHash('55'.repeat(32));

      await store.putNode(hash, {
        type      : 'internal',
        leftHash  : leftHash1,
        rightHash : rightHash1,
      });

      await store.putNode(hash, {
        type      : 'internal',
        leftHash  : leftHash2,
        rightHash : rightHash2,
      });

      const node = await store.getNode(hash);
      expect(node).toBeDefined();
      if (node!.type === 'internal') {
        expect(hashToHex(node!.leftHash)).toBe(hashToHex(leftHash2));
        expect(hashToHex(node!.rightHash)).toBe(hashToHex(rightHash2));
      }
    });
  });

  // ─── deleteNode ───────────────────────────────────────────────────────

  describe('deleteNode()', () => {
    it('should delete a node and verify it is gone', async () => {
      const hash = makeHash('66'.repeat(32));
      await store.putNode(hash, {
        type     : 'leaf',
        keyHash  : makeHash('77'.repeat(32)),
        valueCid : 'bafkreidelete',
      });

      await store.deleteNode(hash);

      const node = await store.getNode(hash);
      expect(node).toBeUndefined();
    });

    it('should not throw when deleting a non-existent node', async () => {
      const hash = makeHash('88'.repeat(32));
      await store.deleteNode(hash); // should not throw
    });
  });

  // ─── getRoot / setRoot ────────────────────────────────────────────────

  describe('getRoot() / setRoot()', () => {
    it('should return undefined when no root has been set', async () => {
      const root = await store.getRoot();
      expect(root).toBeUndefined();
    });

    it('should set and retrieve the root hash', async () => {
      const rootHash = makeHash('99'.repeat(32));
      await store.setRoot(rootHash);

      const retrieved = await store.getRoot();
      expect(retrieved).toBeDefined();
      expect(hashToHex(retrieved!)).toBe(hashToHex(rootHash));
    });

    it('should overwrite the root hash on subsequent setRoot calls', async () => {
      const rootHash1 = makeHash('ab'.repeat(32));
      const rootHash2 = makeHash('cd'.repeat(32));

      await store.setRoot(rootHash1);
      await store.setRoot(rootHash2);

      const retrieved = await store.getRoot();
      expect(hashToHex(retrieved!)).toBe(hashToHex(rootHash2));
    });
  });

  // ─── clear ────────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('should clear all nodes and root for this tenant+scope', async () => {
      const hash = makeHash('ab'.repeat(32));
      await store.putNode(hash, {
        type     : 'leaf',
        keyHash  : makeHash('cd'.repeat(32)),
        valueCid : 'bafkreiclear',
      });
      await store.setRoot(makeHash('ef'.repeat(32)));

      await store.clear();

      expect(await store.getNode(hash)).toBeUndefined();
      expect(await store.getRoot()).toBeUndefined();
    });
  });

  // ─── tenant/scope isolation ───────────────────────────────────────────

  describe('tenant/scope isolation', () => {
    it('should not return nodes from a different tenant or scope', async () => {
      const otherStore = new SMTStoreSql({ db, tenant: 'did:example:bob', scope });
      const hash = makeHash('12'.repeat(32));

      await store.putNode(hash, {
        type     : 'leaf',
        keyHash  : makeHash('34'.repeat(32)),
        valueCid : 'bafkreiisolation',
      });

      const node = await otherStore.getNode(hash);
      expect(node).toBeUndefined();
    });
  });
});
