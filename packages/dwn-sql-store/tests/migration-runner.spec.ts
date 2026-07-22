import type { DwnDatabaseType } from '../src/types.js';
import type { Migration } from 'kysely';

import { allDwnMigrations } from '../src/migrations/index.js';
import { migration001InitialSchema } from '../src/migrations/001-initial-schema.js';
import { runDwnStoreMigrations } from '../src/migration-runner.js';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

describe('runDwnStoreMigrations (Kysely Migrator)', () => {
  const databaseDialects = [testMysqlDialect, testPostgresDialect, testSqliteDialect];

  for (const dialect of databaseDialects) {
    describe(`${dialect.name}`, () => {
      let db: Kysely<DwnDatabaseType>;

      beforeEach(async () => {
        db = new Kysely<DwnDatabaseType>({ dialect });

        // Clean up all tables that migrations might create, plus Kysely's tracking tables.
        // Order matters for foreign key constraints.
        const tablesToDrop = [
          'messageStoreRecordsTags',
          'messageStoreMessages',
          'dataRefs',
          'dataBlocks',
          'dataStore',
          'resumableTasks',
          'replicationCounters',
          'replicationFingerprints',
          'replicationMeta',
          'kysely_migration',
          'kysely_migration_lock',
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
          'replicationCounters',
          'replicationFingerprints',
          'replicationMeta',
          'kysely_migration',
          'kysely_migration_lock',
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

      it('should create Kysely migration tracking tables on first run', async () => {
        let exists = await dialect.hasTable(db, 'kysely_migration');
        expect(exists).toBe(false);

        await runDwnStoreMigrations(db, dialect);

        exists = await dialect.hasTable(db, 'kysely_migration');
        expect(exists).toBe(true);

        exists = await dialect.hasTable(db, 'kysely_migration_lock');
        expect(exists).toBe(true);
      });

      it('should apply all migrations on a fresh database', async () => {
        const applied = await runDwnStoreMigrations(db, dialect);

        expect(applied).toEqual([
          '001-initial-schema',
          '002-content-addressed-datastore',
          '003-add-squash-column',
          '004-replication-log',
          '005-byte-stable-hierarchical-paths',
        ]);

        // Verify tables created by migration 001
        expect(await dialect.hasTable(db, 'messageStoreMessages')).toBe(true);
        expect(await dialect.hasTable(db, 'messageStoreRecordsTags')).toBe(true);
        expect(await dialect.hasTable(db, 'resumableTasks')).toBe(true);
        expect(await dialect.hasTable(db, 'replicationCounters')).toBe(true);
        expect(await dialect.hasTable(db, 'replicationFingerprints')).toBe(true);
        expect(await dialect.hasTable(db, 'replicationMeta')).toBe(true);

        // Verify migration 002 created new tables and dropped old one
        expect(await dialect.hasTable(db, 'dataRefs')).toBe(true);
        expect(await dialect.hasTable(db, 'dataBlocks')).toBe(true);
        expect(await dialect.hasTable(db, 'dataStore')).toBe(false);
      });

      it('should record applied migrations in the kysely_migration table', async () => {
        await runDwnStoreMigrations(db, dialect);

        const rows = await db
          .selectFrom('kysely_migration' as any)
          .selectAll()
          .orderBy('name', 'asc')
          .execute();

        expect(rows).toHaveLength(5);
        expect((rows[0] as any).name).toBe('001-initial-schema');
        expect((rows[1] as any).name).toBe('002-content-addressed-datastore');
        expect((rows[2] as any).name).toBe('003-add-squash-column');
        expect((rows[3] as any).name).toBe('004-replication-log');
        expect((rows[4] as any).name).toBe('005-byte-stable-hierarchical-paths');
        // Kysely uses `timestamp` column for when migration was applied
        expect((rows[0] as any).timestamp).toBeDefined();
      });

      // ─── Idempotency tests ──────────────────────────────────────────

      it('should be idempotent — second run returns no new migrations', async () => {
        const firstRun = await runDwnStoreMigrations(db, dialect);
        expect(firstRun).toHaveLength(5);

        const secondRun = await runDwnStoreMigrations(db, dialect);
        expect(secondRun).toHaveLength(0);
      });

      it('should apply only pending migrations when some are already applied', async () => {
        // Run only migration 001
        const firstRun = await runDwnStoreMigrations(db, dialect, [allDwnMigrations[0]]);
        expect(firstRun).toEqual(['001-initial-schema']);

        // Now run all remaining migrations.
        const secondRun = await runDwnStoreMigrations(db, dialect);
        expect(secondRun).toEqual([
          '002-content-addressed-datastore',
          '003-add-squash-column',
          '004-replication-log',
          '005-byte-stable-hierarchical-paths',
        ]);
      });

      it('should migrate hierarchical paths to byte-stable indexed comparisons', async () => {
        await runDwnStoreMigrations(db, dialect, allDwnMigrations.slice(0, 4));

        await db.insertInto('messageStoreMessages').values([
          {
            tenant              : 'did:example:alice',
            messageCid          : 'root',
            contextId           : 'root',
            protocolPath        : 'thread',
            encodedMessageBytes : Buffer.from('root'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'child',
            contextId           : 'root/child',
            protocolPath        : 'thread/note',
            encodedMessageBytes : Buffer.from('child'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'case-variant',
            contextId           : 'Root',
            protocolPath        : 'Thread',
            encodedMessageBytes : Buffer.from('case-variant'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'case-variant-child',
            contextId           : 'Root/child',
            protocolPath        : 'Thread/note',
            encodedMessageBytes : Buffer.from('case-variant-child'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'padded-path',
            contextId           : 'other',
            protocolPath        : 'thread ',
            encodedMessageBytes : Buffer.from('padded-path'),
          },
        ] as any).execute();

        const applied = await runDwnStoreMigrations(db, dialect);
        expect(applied).toEqual(['005-byte-stable-hierarchical-paths']);

        const exact = await db.selectFrom('messageStoreMessages')
          .select('messageCid')
          .where('tenant', '=', 'did:example:alice')
          .where('contextId', '=', 'root')
          .execute();
        expect(exact.map(({ messageCid }) => messageCid)).toEqual(['root']);

        const descendants = await db.selectFrom('messageStoreMessages')
          .select('messageCid')
          .where('tenant', '=', 'did:example:alice')
          .where('contextId', '>=', 'root/')
          .where('contextId', '<', 'root0')
          .execute();
        expect(descendants.map(({ messageCid }) => messageCid)).toEqual(['child']);

        const protocolPaths = await db.selectFrom('messageStoreMessages')
          .select('messageCid')
          .where('tenant', '=', 'did:example:alice')
          .where('protocolPath', '>=', 'thread/')
          .where('protocolPath', '<', 'thread0')
          .execute();
        expect(protocolPaths.map(({ messageCid }) => messageCid)).toEqual(['child']);

        const exactProtocolPath = await db.selectFrom('messageStoreMessages')
          .select('messageCid')
          .where('tenant', '=', 'did:example:alice')
          .where('protocolPath', '=', 'thread')
          .execute();
        expect(exactProtocolPath.map(({ messageCid }) => messageCid)).toEqual(['root']);

        if (dialect.name === 'MySQL') {
          const columns = await sql<{ COLUMN_NAME: string; COLLATION_NAME: string }>`
            SELECT column_name, collation_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'messageStoreMessages'
              AND column_name IN ('contextId', 'protocolPath')
            ORDER BY column_name
          `.execute(db);
          expect(columns.rows).toEqual([
            { COLUMN_NAME: 'contextId', COLLATION_NAME: 'ascii_bin' },
            { COLUMN_NAME: 'protocolPath', COLLATION_NAME: 'utf8mb4_0900_bin' },
          ]);

          const indexColumns = await sql<{ prefixLength: number | null }>`
            SELECT sub_part AS prefixLength
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'messageStoreMessages'
              AND index_name = 'index_tenant_contextId_messageTimestamp'
              AND column_name = 'contextId'
          `.execute(db);
          expect(indexColumns.rows).toEqual([{ prefixLength: null }]);
        } else if (dialect.name === 'PostgreSQL') {
          const columns = await sql<{ column_name: string; collation_name: string }>`
            SELECT column_name, collation_name
            FROM information_schema.columns
            WHERE table_name = 'messageStoreMessages'
              AND column_name IN ('contextId', 'protocolPath')
            ORDER BY column_name
          `.execute(db);
          expect(columns.rows).toEqual([
            { column_name: 'contextId', collation_name: 'C' },
            { column_name: 'protocolPath', collation_name: 'C' },
          ]);
        }
      });

      if (dialect.name === 'MySQL') {
        it('should recover when the context index is missing before migration 005', async () => {
          await runDwnStoreMigrations(db, dialect, allDwnMigrations.slice(0, 4));
          await db.schema.dropIndex('index_tenant_contextId_messageTimestamp')
            .on('messageStoreMessages')
            .execute();

          const applied = await runDwnStoreMigrations(db, dialect);
          expect(applied).toEqual(['005-byte-stable-hierarchical-paths']);

          const indexColumns = await sql<{ COLUMN_NAME: string; SUB_PART: number | null }>`
            SELECT column_name, sub_part
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'messageStoreMessages'
              AND index_name = 'index_tenant_contextId_messageTimestamp'
            ORDER BY seq_in_index
          `.execute(db);
          expect(indexColumns.rows).toEqual([
            { COLUMN_NAME: 'tenant', SUB_PART: null },
            { COLUMN_NAME: 'contextId', SUB_PART: null },
            { COLUMN_NAME: 'messageTimestamp', SUB_PART: null },
          ]);
        });
      }

      // ─── Data migration tests ───────────────────────────────────────

      it('should migrate data from old dataStore to dataRefs + dataBlocks', async () => {
        // Step 1: Apply only migration 001 to create the old schema
        await runDwnStoreMigrations(db, dialect, [allDwnMigrations[0]]);

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

        // Step 3: Apply remaining migrations which should migrate data
        const applied = await runDwnStoreMigrations(db, dialect);
        expect(applied).toEqual([
          '002-content-addressed-datastore',
          '003-add-squash-column',
          '004-replication-log',
          '005-byte-stable-hierarchical-paths',
        ]);

        // Step 4: Verify data was migrated to dataRefs
        const refs = await db
          .selectFrom('dataRefs')
          .selectAll()
          .orderBy('dataCid', 'asc')
          .execute();

        expect(refs).toHaveLength(2);
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

        expect(blocks).toHaveLength(2);
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
        await runDwnStoreMigrations(db, dialect, [allDwnMigrations[0]]);

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

        // Step 3: Apply remaining migrations
        await runDwnStoreMigrations(db, dialect);

        // Step 4: Verify two refs but only one block
        const refs = await db
          .selectFrom('dataRefs')
          .selectAll()
          .execute();

        expect(refs).toHaveLength(2);

        const blocks = await db
          .selectFrom('dataBlocks')
          .selectAll()
          .execute();

        // Only one block should exist despite two refs (dedup via INSERT IGNORE/ON CONFLICT)
        expect(blocks).toHaveLength(1);
        expect(blocks[0].rootDataCid).toBe('bafkreishared');
      });

      it('should handle empty dataStore table gracefully', async () => {
        // Apply migration 001 (creates empty dataStore)
        await runDwnStoreMigrations(db, dialect, [allDwnMigrations[0]]);

        // Apply remaining migrations — should not fail on empty table
        const applied = await runDwnStoreMigrations(db, dialect);
        expect(applied).toEqual([
          '002-content-addressed-datastore',
          '003-add-squash-column',
          '004-replication-log',
          '005-byte-stable-hierarchical-paths',
        ]);

        // New tables exist, old one gone
        expect(await dialect.hasTable(db, 'dataRefs')).toBe(true);
        expect(await dialect.hasTable(db, 'dataBlocks')).toBe(true);
        expect(await dialect.hasTable(db, 'dataStore')).toBe(false);
      });

      // ─── Failure / rollback tests ───────────────────────────────────

      it('should leave database in last known-good state on migration failure', async () => {
        // Apply the real migrations first
        await runDwnStoreMigrations(db, dialect);

        // Try to apply with an additional failing migration
        const failingMigrationList: typeof allDwnMigrations = [
          ...allDwnMigrations,
          ['999-failing-migration', (): Migration => ({
            async up(): Promise<void> {
              throw new Error('intentional migration failure');
            },
          })],
        ];

        await expect(
          runDwnStoreMigrations(db, dialect, failingMigrationList)
        ).rejects.toThrow('intentional migration failure');

        // The failing migration should NOT be recorded
        const rows = await db
          .selectFrom('kysely_migration' as any)
          .selectAll()
          .execute();

        expect(rows).toHaveLength(5); // only the 5 real migrations
        const names = rows.map((r: any) => r.name);
        expect(names).not.toContain('999-failing-migration');
      });

      // ─── Existing database adoption tests ───────────────────────────

      it('should adopt an existing database that already has tables but no kysely_migration', async () => {
        // Simulate a pre-migration database: manually create the old schema
        // by running migration 001's up() directly (not through the runner)
        const migration001 = migration001InitialSchema(dialect);
        await migration001.up(db);

        // Verify tables exist but kysely_migration does not
        expect(await dialect.hasTable(db, 'messageStoreMessages')).toBe(true);
        expect(await dialect.hasTable(db, 'dataStore')).toBe(true);
        expect(await dialect.hasTable(db, 'kysely_migration')).toBe(false);

        // Now run all migrations through the runner
        const applied = await runDwnStoreMigrations(db, dialect);

        // Migration 001 should run but be a no-op (tables already exist due to hasTable checks)
        // The remaining migrations should run and perform their schema changes.
        expect(applied).toEqual([
          '001-initial-schema',
          '002-content-addressed-datastore',
          '003-add-squash-column',
          '004-replication-log',
          '005-byte-stable-hierarchical-paths',
        ]);

        // All should now be recorded
        const rows = await db
          .selectFrom('kysely_migration' as any)
          .selectAll()
          .execute();

        expect(rows).toHaveLength(5);
      });

      // ─── Empty migrations list test ─────────────────────────────────

      it('should handle empty migrations list gracefully', async () => {
        const applied = await runDwnStoreMigrations(db, dialect, []);
        expect(applied).toEqual([]);

        // Kysely creates the tracking tables even with no migrations
        expect(await dialect.hasTable(db, 'kysely_migration')).toBe(true);
      });
    });
  }
});
