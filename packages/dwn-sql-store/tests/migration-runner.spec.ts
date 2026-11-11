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

      // Order matters for foreign key constraints.
      const tablesToDrop = [
        'messageStoreRecordsTags',
        'messageStoreMessages',
        'dataRefs',
        'dataBlocks',
        'resumableTasks',
        'replicationCounters',
        'replicationFingerprints',
        'replicationMeta',
        'kysely_migration',
        'kysely_migration_lock',
      ];

      beforeEach(async () => {
        db = new Kysely<DwnDatabaseType>({ dialect });

        // Clean up all tables that migrations might create, plus Kysely's tracking tables.
        for (const table of tablesToDrop) {
          const exists = await dialect.hasTable(db, table);
          if (exists) {
            await db.schema.dropTable(table).execute();
          }
        }
      });

      afterAll(async () => {
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

      it('should apply the canonical baseline schema on a fresh database', async () => {
        const applied = await runDwnStoreMigrations(db, dialect);

        expect(applied).toEqual(['001-initial-schema']);

        expect(await dialect.hasTable(db, 'messageStoreMessages')).toBe(true);
        expect(await dialect.hasTable(db, 'messageStoreRecordsTags')).toBe(true);
        expect(await dialect.hasTable(db, 'dataRefs')).toBe(true);
        expect(await dialect.hasTable(db, 'dataBlocks')).toBe(true);
        expect(await dialect.hasTable(db, 'resumableTasks')).toBe(true);
        expect(await dialect.hasTable(db, 'replicationCounters')).toBe(true);
        expect(await dialect.hasTable(db, 'replicationFingerprints')).toBe(true);
        expect(await dialect.hasTable(db, 'replicationMeta')).toBe(true);
      });

      it('should record applied migrations in the kysely_migration table', async () => {
        await runDwnStoreMigrations(db, dialect);

        const rows = await db
          .selectFrom('kysely_migration' as any)
          .selectAll()
          .orderBy('name', 'asc')
          .execute();

        expect(rows).toHaveLength(1);
        expect((rows[0] as any).name).toBe('001-initial-schema');
        // Kysely uses `timestamp` column for when migration was applied
        expect((rows[0] as any).timestamp).toBeDefined();
      });

      // ─── Idempotency & incremental runner tests ─────────────────────

      it('should be idempotent — second run returns no new migrations', async () => {
        const firstRun = await runDwnStoreMigrations(db, dialect);
        expect(firstRun).toHaveLength(1);

        const secondRun = await runDwnStoreMigrations(db, dialect);
        expect(secondRun).toHaveLength(0);
      });

      it('should apply only pending migrations when some are already applied', async () => {
        const firstRun = await runDwnStoreMigrations(db, dialect, [allDwnMigrations[0]]);
        expect(firstRun).toEqual(['001-initial-schema']);

        const extendedMigrations: typeof allDwnMigrations = [
          ...allDwnMigrations,
          ['002-custom-column', (): Migration => ({
            async up(migrationDb: Kysely<any>): Promise<void> {
              await migrationDb.schema
                .alterTable('replicationMeta')
                .addColumn('notes', 'text')
                .execute();
            },
          })],
        ];

        const secondRun = await runDwnStoreMigrations(db, dialect, extendedMigrations);
        expect(secondRun).toEqual(['002-custom-column']);
      });

      it('should create hierarchical path columns with byte-stable indexed comparisons', async () => {
        await runDwnStoreMigrations(db, dialect);

        await db.insertInto('messageStoreMessages').values([
          {
            tenant              : 'did:example:alice',
            messageCid          : 'root',
            seq                 : '1',
            fingerprintScopes   : '[]',
            contextId           : 'root',
            modulePath          : 'thread',
            encodedMessageBytes : Buffer.from('root'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'child',
            seq                 : '2',
            fingerprintScopes   : '[]',
            contextId           : 'root/child',
            modulePath          : 'thread/note',
            encodedMessageBytes : Buffer.from('child'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'case-variant',
            seq                 : '3',
            fingerprintScopes   : '[]',
            contextId           : 'Root',
            modulePath          : 'Thread',
            encodedMessageBytes : Buffer.from('case-variant'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'case-variant-child',
            seq                 : '4',
            fingerprintScopes   : '[]',
            contextId           : 'Root/child',
            modulePath          : 'Thread/note',
            encodedMessageBytes : Buffer.from('case-variant-child'),
          },
          {
            tenant              : 'did:example:alice',
            messageCid          : 'padded-path',
            seq                 : '5',
            fingerprintScopes   : '[]',
            contextId           : 'other',
            modulePath          : 'thread ',
            encodedMessageBytes : Buffer.from('padded-path'),
          },
        ]).execute();

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

        const modulePaths = await db.selectFrom('messageStoreMessages')
          .select('messageCid')
          .where('tenant', '=', 'did:example:alice')
          .where('modulePath', '>=', 'thread/')
          .where('modulePath', '<', 'thread0')
          .execute();
        expect(modulePaths.map(({ messageCid }) => messageCid)).toEqual(['child']);

        const exactModulePath = await db.selectFrom('messageStoreMessages')
          .select('messageCid')
          .where('tenant', '=', 'did:example:alice')
          .where('modulePath', '=', 'thread')
          .execute();
        expect(exactModulePath.map(({ messageCid }) => messageCid)).toEqual(['root']);

        if (dialect.name === 'MySQL') {
          const columns = await sql<{ COLUMN_NAME: string; COLLATION_NAME: string }>`
            SELECT column_name, collation_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'messageStoreMessages'
              AND column_name IN ('contextId', 'modulePath')
            ORDER BY column_name
          `.execute(db);
          expect(columns.rows).toEqual([
            { COLUMN_NAME: 'contextId', COLLATION_NAME: 'ascii_bin' },
            { COLUMN_NAME: 'modulePath', COLLATION_NAME: 'utf8mb4_0900_bin' },
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
              AND column_name IN ('contextId', 'modulePath')
            ORDER BY column_name
          `.execute(db);
          expect(columns.rows).toEqual([
            { column_name: 'contextId', collation_name: 'C' },
            { column_name: 'modulePath', collation_name: 'C' },
          ]);
        }
      });

      // ─── Failure / rollback tests ───────────────────────────────────

      it('should leave database in last known-good state on migration failure', async () => {
        await runDwnStoreMigrations(db, dialect);

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

        expect(rows).toHaveLength(1);
        const names = rows.map((r: any) => r.name);
        expect(names).not.toContain('999-failing-migration');
      });

      // ─── Existing database adoption tests ───────────────────────────

      it('should adopt an existing database that already has tables but no kysely_migration', async () => {
        const migration001 = migration001InitialSchema(dialect);
        await migration001.up(db);

        expect(await dialect.hasTable(db, 'messageStoreMessages')).toBe(true);
        expect(await dialect.hasTable(db, 'dataRefs')).toBe(true);
        expect(await dialect.hasTable(db, 'kysely_migration')).toBe(false);

        const applied = await runDwnStoreMigrations(db, dialect);
        expect(applied).toEqual(['001-initial-schema']);

        const rows = await db
          .selectFrom('kysely_migration' as any)
          .selectAll()
          .execute();

        expect(rows).toHaveLength(1);
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
