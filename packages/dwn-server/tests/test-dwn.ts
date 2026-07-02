import type { Dialect } from '@enbox/dwn-sql-store';
import type { TenantGate } from '@enbox/dwn-sdk-js';

import { Kysely } from 'kysely';
import {
  createBunSqliteDatabase,
  DataStoreSql,
  MessageStoreSql,
  ResumableTaskStoreSql,
  runDwnStoreMigrations,
  SqliteDialect,
} from '@enbox/dwn-sql-store';
import { DidDht, DidKey, UniversalResolver } from '@enbox/dids';
import { DurableEventLog, Dwn, EventEmitterWakePublisher } from '@enbox/dwn-sdk-js';

import { runServerMigrations } from '../src/server-migration-runner.js';

/**
 * The result of `getTestDwn()`, bundling the DWN instance with the shared
 * dialect so tests that create an `HttpApi` can pass the same dialect to
 * the TTL cache (critical for in-memory SQLite).
 */
export type TestDwnResult = {
  dwn: Dwn;
  dialect: Dialect;
};

export async function getTestDwn(options: {
  tenantGate?: TenantGate,
  withEvents?: boolean,
} = {}): Promise<TestDwnResult> {
  const { tenantGate, withEvents = false } = options;

  // Share a single in-memory SQLite database across all stores and migrations.
  // Using `async () => sharedDb` ensures every Kysely instance points at the
  // same `:memory:` database (calling `createBunSqliteDatabase(':memory:')`
  // multiple times would create separate, unrelated databases).
  const sharedDb = createBunSqliteDatabase(':memory:');
  const dialect = new SqliteDialect({ database: async (): Promise<typeof sharedDb> => sharedDb });

  // Run DWN store and server migrations before creating stores.
  const migrationDb = new Kysely<Record<string, unknown>>({ dialect });
  await runDwnStoreMigrations(migrationDb, dialect);
  await runServerMigrations(migrationDb, dialect);

  const dataStore = new DataStoreSql(dialect);
  const wakePublisher = new EventEmitterWakePublisher();
  const messageStore = new MessageStoreSql(dialect);
  messageStore.setWakePublisher(wakePublisher);
  const resumableTaskStore = new ResumableTaskStoreSql(dialect);
  const eventLog = withEvents ? new DurableEventLog(messageStore, wakePublisher) : undefined;

  // NOTE: no resolver cache used here to avoid locking LevelDB
  const didResolver = new UniversalResolver({
    didResolvers: [DidDht, DidKey],
  });

  const dwn = await Dwn.create({
    dataStore,
    messageStore,
    resumableTaskStore,
    eventLog,
    tenantGate,
    didResolver
  });

  return { dwn, dialect };
}
