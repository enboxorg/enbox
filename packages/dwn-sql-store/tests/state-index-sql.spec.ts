import type { DwnDatabaseType } from '../src/types.js';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { Kysely } from 'kysely';
import { runDwnStoreMigrations } from '../src/migration-runner.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { StateIndexSql } from '../src/state-index-sql.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('StateIndexSql', () => {
  // Share a single in-memory database so migrations and the store see the same tables.
  const sharedDb = createBunSqliteDatabase(':memory:', { create: true });
  const dialect = new SqliteDialect({
    database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> => sharedDb,
  });

  let stateIndex: StateIndexSql;

  const tenant = 'did:example:alice';
  const protocol = 'https://proto.example.com/v1';

  beforeAll(async () => {
    // Run migrations before opening the store — tables must exist first.
    const db = new Kysely<DwnDatabaseType>({ dialect });
    await runDwnStoreMigrations(db, dialect);

    stateIndex = new StateIndexSql(dialect);
    await stateIndex.open();
  });

  beforeEach(async () => {
    await stateIndex.clear();
  });

  afterAll(async () => {
    await stateIndex.close();
  });

  describe('open()', () => {
    it('should be idempotent — calling open() twice does not throw', async () => {
      // The state index is already open from beforeAll; calling open() again should be a no-op.
      await stateIndex.open();
      // Verify it still works.
      const root = await stateIndex.getRoot(tenant);
      expect(root).toBeInstanceOf(Uint8Array);
    });
  });

  describe('getRoot()', () => {
    it('should return a root hash for an empty tree', async () => {
      const root = await stateIndex.getRoot(tenant);
      expect(root).toBeInstanceOf(Uint8Array);
      expect(root.length).toBeGreaterThan(0);
    });

    it('should return a different root after inserting an entry', async () => {
      const emptyRoot = await stateIndex.getRoot(tenant);
      await stateIndex.insert(tenant, 'bafyCID1', {});
      const nonEmptyRoot = await stateIndex.getRoot(tenant);
      expect(nonEmptyRoot).not.toEqual(emptyRoot);
    });
  });

  describe('getProtocolRoot()', () => {
    it('should return a root hash for a protocol-scoped tree', async () => {
      await stateIndex.insert(tenant, 'bafyCID2', { protocol });
      const root = await stateIndex.getProtocolRoot(tenant, protocol);
      expect(root).toBeInstanceOf(Uint8Array);
      expect(root.length).toBeGreaterThan(0);
    });
  });

  describe('getSubtreeHash()', () => {
    it('should return a hash for the root prefix (empty prefix)', async () => {
      await stateIndex.insert(tenant, 'bafyCID3', {});
      const hash = await stateIndex.getSubtreeHash(tenant, []);
      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBeGreaterThan(0);
    });

    it('should return a hash for a left-child prefix', async () => {
      await stateIndex.insert(tenant, 'bafyCID4', {});
      const hash = await stateIndex.getSubtreeHash(tenant, [false]);
      expect(hash).toBeInstanceOf(Uint8Array);
    });

    it('should return a hash for a right-child prefix', async () => {
      await stateIndex.insert(tenant, 'bafyCID5', {});
      const hash = await stateIndex.getSubtreeHash(tenant, [true]);
      expect(hash).toBeInstanceOf(Uint8Array);
    });
  });

  describe('getProtocolSubtreeHash()', () => {
    it('should return a hash for the protocol-scoped subtree', async () => {
      await stateIndex.insert(tenant, 'bafyCID6', { protocol });
      const hash = await stateIndex.getProtocolSubtreeHash(tenant, protocol, []);
      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe('getLeaves()', () => {
    it('should return an empty array for a tree with no entries matching the prefix', async () => {
      const leaves = await stateIndex.getLeaves(tenant, [true, true, true, true, true]);
      expect(leaves).toEqual([]);
    });

    it('should return leaf CIDs after inserting entries', async () => {
      await stateIndex.insert(tenant, 'bafyCID7', {});
      await stateIndex.insert(tenant, 'bafyCID8', {});
      // With an empty prefix, getLeaves should return all leaves.
      const leaves = await stateIndex.getLeaves(tenant, []);
      expect(leaves).toContain('bafyCID7');
      expect(leaves).toContain('bafyCID8');
    });
  });

  describe('getProtocolLeaves()', () => {
    it('should return protocol-scoped leaf CIDs', async () => {
      await stateIndex.insert(tenant, 'bafyCID9', { protocol });
      await stateIndex.insert(tenant, 'bafyCID10', { protocol });
      const leaves = await stateIndex.getProtocolLeaves(tenant, protocol, []);
      expect(leaves).toContain('bafyCID9');
      expect(leaves).toContain('bafyCID10');
    });

    it('should not include CIDs from other protocols', async () => {
      await stateIndex.insert(tenant, 'bafyCID11', { protocol });
      await stateIndex.insert(tenant, 'bafyCID12', { protocol: 'https://other.protocol/v1' });
      const leaves = await stateIndex.getProtocolLeaves(tenant, protocol, []);
      expect(leaves).toContain('bafyCID11');
      expect(leaves).not.toContain('bafyCID12');
    });
  });

  describe('delete()', () => {
    it('should no-op when given an empty messageCids array', async () => {
      await stateIndex.insert(tenant, 'bafyCID13', {});
      const rootBefore = await stateIndex.getRoot(tenant);
      await stateIndex.delete(tenant, []);
      const rootAfter = await stateIndex.getRoot(tenant);
      expect(rootAfter).toEqual(rootBefore);
    });

    it('should remove an entry from both global and protocol trees', async () => {
      await stateIndex.insert(tenant, 'bafyCID14', { protocol });

      const leavesBeforeGlobal = await stateIndex.getLeaves(tenant, []);
      expect(leavesBeforeGlobal).toContain('bafyCID14');

      const leavesBefore = await stateIndex.getProtocolLeaves(tenant, protocol, []);
      expect(leavesBefore).toContain('bafyCID14');

      await stateIndex.delete(tenant, ['bafyCID14']);

      const leavesAfterGlobal = await stateIndex.getLeaves(tenant, []);
      expect(leavesAfterGlobal).not.toContain('bafyCID14');

      const leavesAfter = await stateIndex.getProtocolLeaves(tenant, protocol, []);
      expect(leavesAfter).not.toContain('bafyCID14');
    });

    it('should handle deleting a non-existent CID gracefully', async () => {
      // Should not throw when deleting a CID that was never inserted.
      await stateIndex.delete(tenant, ['bafyNonExistent']);
    });
  });
});
