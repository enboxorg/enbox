import type { DwnDatabaseType } from '../src/types.js';

import { allMigrations } from '../src/migrations/index.js';
import { Kysely } from 'kysely';
import { migration001InitialSchema } from '../src/migrations/001-initial-schema.js';
import { MigrationRunner } from '../src/migration-runner.js';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

describe('MigrationRunner', () => {
  const databaseDialects = [testMysqlDialect, testPostgresDialect, testSqliteDialect];

  for (const dialect of databaseDialects) {
    describe(`${dialect.name}`, () => {
      let db: Kysely<DwnDatabaseType>;

      beforeEach(async () => {
        db = new Kysely<DwnDatabaseType>({ dialect });

        // Clean up all tables that migrations might create, plus the tracking table.
        // Order matters for foreign key constraints.
        const tablesToDrop = [
          'messageStoreRecordsTags',
          'messageStoreMessages',
          'dataRefs',
          'dataBlocks',
          'dataStore',
          'resumableTasks',
          'stateIndexNodes',
          'stateIndexRoots',
          'stateIndexMeta',
          'dwn_migrations',
        ];

        for (const table of tablesToDrop) {
          const exists = await dialect.hasTable(db, table);
          if (exists) {
            await db.schema.dropTable(table).execute();
          }
        }
      });

      afterAll(async () => {
        // Final cleanup
        const tablesToDrop = [
          'messageStoreRecordsTags',
          'messageStoreMessages',
          'dataRefs',
          'dataBlocks',
          'dataStore',
          'resumableTasks',
          'stateIndexNodes',
          'stateIndexRoots',
          'stateIndexMeta',
          'dwn_migrations',
        ];

        const cleanupDb = new Kysely<DwnDatabaseType>({ dialect });
        for (const table of tablesToDrop) {
          const exists = await dialect.hasTable(cleanupDb, table);
          if (exists) {
            await cleanupDb.schema.dropTable(table).execute();
          }
        }
        await cleanupDb.destroy();
      });

      // ─── Fresh database tests ───────────────────────────────────────

      it('should create dwn_migrations tracking table on first run', async () => {
        const runner = new MigrationRunner(db, dialect, []);

        let exists = await dialect.hasTable(db, 'dwn_migrations');
        expect(exists).toBe(false);

        await runner.run();

        exists = await dialect.hasTable(db, 'dwn_migrations');
        expect(exists).toBe(true);
      });

      it('should apply all migrations on a fresh database', async () => {
        const runner = new MigrationRunner(db, dialect, allMigrations);
        const applied = await runner.run();

        expect(applied).toEqual([
          '001-initial-schema',
          '002-content-addressed-datastore',
        ]);

        // Verify tables created by migration 001
        expect(await dialect.hasTable(db, 'messageStoreMessages')).toBe(true);
        expect(await dialect.hasTable(db, 'messageStoreRecordsTags')).toBe(true);
        expect(await dialect.hasTable(db, 'resumableTasks')).toBe(true);
        expect(await dialect.hasTable(db, 'stateIndexNodes')).toBe(true);
        expect(await dialect.hasTable(db, 'stateIndexRoots')).toBe(true);
        expect(await dialect.hasTable(db, 'stateIndexMeta')).toBe(true);

        // Verify migration 002 created new tables and dropped old one
        expect(await dialect.hasTable(db, 'dataRefs')).toBe(true);
        expect(await dialect.hasTable(db, 'dataBlocks')).toBe(true);
        expect(await dialect.hasTable(db, 'dataStore')).toBe(false);
      });

      it('should record applied migrations in the dwn_migrations table', async () => {
        const runner = new MigrationRunner(db, dialect, allMigrations);
        await runner.run();

        const rows = await db
          .selectFrom('dwn_migrations' as any)
          .selectAll()
          .orderBy('name', 'asc')
          .execute();

        expect(rows.length).toBe(2);
        expect((rows[0] as any).name).toBe('001-initial-schema');
        expect((rows[1] as any).name).toBe('002-content-addressed-datastore');
        // appliedAt should be a valid ISO date string
        expect((rows[0] as any).appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect((rows[1] as any).appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      // ─── Idempotency tests ──────────────────────────────────────────

      it('should be idempotent — second run returns no new migrations', async () => {
        const runner = new MigrationRunner(db, dialect, allMigrations);

        const firstRun = await runner.run();
        expect(firstRun.length).toBe(2);

        const secondRun = await runner.run();
        expect(secondRun.length).toBe(0);
      });

      it('should apply only pending migrations when some are already applied', async () => {
        // Run only migration 001
        const runner1 = new MigrationRunner(db, dialect, [migration001InitialSchema]);
        const firstRun = await runner1.run();
        expect(firstRun).toEqual(['001-initial-schema']);

        // Now run with all migrations — only 002 should be applied
        const runner2 = new MigrationRunner(db, dialect, allMigrations);
        const secondRun = await runner2.run();
        expect(secondRun).toEqual(['002-content-addressed-datastore']);
      });

      // ─── Data migration tests ───────────────────────────────────────

      it('should migrate data from old dataStore to dataRefs + dataBlocks', async () => {
        // Step 1: Apply only migration 001 to create the old schema
        const runner1 = new MigrationRunner(db, dialect, [migration001InitialSchema]);
        await runner1.run();

        // Step 2: Insert test data into old dataStore table
        const testData1 = Buffer.from('hello world');
        const testData2 = Buffer.from('goodbye world');

        await db
          .insertInto('dataStore')
          .values({
            tenant   : 'did:example:alice',
            recordId : 'record-1',
            dataCid  : 'bafkreiabc',
            data     : testData1,
          } as any)
          .execute();

        await db
          .insertInto('dataStore')
          .values({
            tenant   : 'did:example:bob',
            recordId : 'record-2',
            dataCid  : 'bafkreidef',
            data     : testData2,
          } as any)
          .execute();

        // Step 3: Apply migration 002 which should migrate data
        const runner2 = new MigrationRunner(db, dialect, allMigrations);
        const applied = await runner2.run();
        expect(applied).toEqual(['002-content-addressed-datastore']);

        // Step 4: Verify data was migrated to dataRefs
        const refs = await db
          .selectFrom('dataRefs')
          .selectAll()
          .orderBy('dataCid', 'asc')
          .execute();

        expect(refs.length).toBe(2);
        expect(refs[0].tenant).toBe('did:example:alice');
        expect(refs[0].recordId).toBe('record-1');
        expect(refs[0].dataCid).toBe('bafkreiabc');
        expect(Number(refs[0].dataSize)).toBe(testData1.length);

        expect(refs[1].tenant).toBe('did:example:bob');
        expect(refs[1].recordId).toBe('record-2');
        expect(refs[1].dataCid).toBe('bafkreidef');
        expect(Number(refs[1].dataSize)).toBe(testData2.length);

        // Step 5: Verify data was migrated to dataBlocks
        const blocks = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .orderBy('rootDataCid', 'asc')
          .execute();

        expect(blocks.length).toBe(2);
        expect(blocks[0].rootDataCid).toBe('bafkreiabc');
        expect(blocks[0].blockCid).toBe('bafkreiabc');
        expect(Buffer.from(blocks[0].data).toString()).toBe('hello world');

        expect(blocks[1].rootDataCid).toBe('bafkreidef');
        expect(blocks[1].blockCid).toBe('bafkreidef');
        expect(Buffer.from(blocks[1].data).toString()).toBe('goodbye world');

        // Step 6: Verify old dataStore table was dropped
        expect(await dialect.hasTable(db, 'dataStore')).toBe(false);
      });

      it('should deduplicate blocks when multiple records share the same dataCid', async () => {
        // Step 1: Apply only migration 001
        const runner1 = new MigrationRunner(db, dialect, [migration001InitialSchema]);
        await runner1.run();

        // Step 2: Insert two records with the same dataCid
        const sharedData = Buffer.from('shared content');

        await db
          .insertInto('dataStore')
          .values({
            tenant   : 'did:example:alice',
            recordId : 'record-1',
            dataCid  : 'bafkreishared',
            data     : sharedData,
          } as any)
          .execute();

        await db
          .insertInto('dataStore')
          .values({
            tenant   : 'did:example:bob',
            recordId : 'record-2',
            dataCid  : 'bafkreishared',
            data     : sharedData,
          } as any)
          .execute();

        // Step 3: Apply migration 002
        const runner2 = new MigrationRunner(db, dialect, allMigrations);
        await runner2.run();

        // Step 4: Verify two refs but only one block
        const refs = await db
          .selectFrom('dataRefs')
          .selectAll()
          .execute();

        expect(refs.length).toBe(2);

        const blocks = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .execute();

        // Only one block should exist despite two refs (dedup via INSERT IGNORE/ON CONFLICT)
        expect(blocks.length).toBe(1);
        expect(blocks[0].rootDataCid).toBe('bafkreishared');
      });

      it('should handle empty dataStore table gracefully', async () => {
        // Apply migration 001 (creates empty dataStore)
        const runner1 = new MigrationRunner(db, dialect, [migration001InitialSchema]);
        await runner1.run();

        // Apply migration 002 — should not fail on empty table
        const runner2 = new MigrationRunner(db, dialect, allMigrations);
        const applied = await runner2.run();
        expect(applied).toEqual(['002-content-addressed-datastore']);

        // New tables exist, old one gone
        expect(await dialect.hasTable(db, 'dataRefs')).toBe(true);
        expect(await dialect.hasTable(db, 'dataBlocks')).toBe(true);
        expect(await dialect.hasTable(db, 'dataStore')).toBe(false);
      });

      // ─── Failure / rollback tests ───────────────────────────────────

      it('should leave database in last known-good state on migration failure', async () => {
        const failingMigration = {
          name: '999-failing-migration',
          async up(): Promise<void> {
            throw new Error('intentional migration failure');
          },
        };

        // Apply the real migrations first
        const runner1 = new MigrationRunner(db, dialect, allMigrations);
        await runner1.run();

        // Try to apply a failing migration
        const runner2 = new MigrationRunner(db, dialect, [
          ...allMigrations,
          failingMigration,
        ]);

        await expect(runner2.run()).rejects.toThrow('intentional migration failure');

        // The failing migration should NOT be recorded
        const rows = await db
          .selectFrom('dwn_migrations' as any)
          .selectAll()
          .execute();

        expect(rows.length).toBe(2); // only the 2 real migrations
        const names = rows.map((r: any) => r.name);
        expect(names).not.toContain('999-failing-migration');
      });

      // ─── Existing database adoption tests ───────────────────────────

      it('should adopt an existing database that already has tables but no dwn_migrations', async () => {
        // Simulate a pre-migration database: manually create the old schema
        // by running migration 001 directly (not through the runner)
        await migration001InitialSchema.up(db, dialect);

        // Verify tables exist but dwn_migrations does not
        expect(await dialect.hasTable(db, 'messageStoreMessages')).toBe(true);
        expect(await dialect.hasTable(db, 'dataStore')).toBe(true);
        expect(await dialect.hasTable(db, 'dwn_migrations')).toBe(false);

        // Now run all migrations through the runner
        const runner = new MigrationRunner(db, dialect, allMigrations);
        const applied = await runner.run();

        // Migration 001 should run but be a no-op (tables already exist due to hasTable checks)
        // Migration 002 should run and perform the actual schema change
        expect(applied).toEqual([
          '001-initial-schema',
          '002-content-addressed-datastore',
        ]);

        // Both should now be recorded
        const rows = await db
          .selectFrom('dwn_migrations' as any)
          .selectAll()
          .execute();

        expect(rows.length).toBe(2);
      });

      // ─── Empty migrations list test ─────────────────────────────────

      it('should handle empty migrations list gracefully', async () => {
        const runner = new MigrationRunner(db, dialect, []);
        const applied = await runner.run();
        expect(applied).toEqual([]);

        // Only the tracking table should exist
        expect(await dialect.hasTable(db, 'dwn_migrations')).toBe(true);
      });
    });
  }
});
