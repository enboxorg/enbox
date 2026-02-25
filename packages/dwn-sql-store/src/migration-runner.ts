import type { Dialect } from './dialect/dialect.js';
import type { DwnMigrationFactory } from './migration-provider.js';
import type { Kysely, MigrationResultSet } from 'kysely';

import { allDwnMigrations } from './migrations/index.js';
import { DwnMigrationProvider } from './migration-provider.js';
import { Migrator } from 'kysely';

/**
 * Convenience function to run all DWN store migrations against a database.
 *
 * Uses Kysely's native {@link Migrator} with the {@link DwnMigrationProvider}
 * to apply pending migrations. The Migrator handles locking (Postgres uses
 * `pg_advisory_xact_lock`, MySQL uses `GET_LOCK`/`RELEASE_LOCK`, SQLite is
 * single-writer) and migration tracking via its own `kysely_migration` /
 * `kysely_migration_lock` tables.
 *
 * Call this once during application startup, before opening any stores —
 * e.g. in `getDwnConfig()` or equivalent initialization code.
 *
 * @param db - An open Kysely instance connected to the target database.
 * @param dialect - The dialect for the target database.
 * @param migrations - Optional custom migration list; defaults to the
 *   built-in {@link allDwnMigrations}.
 * @returns The names of newly applied migrations (empty if already up-to-date).
 * @throws If any migration fails (the Migrator rolls back only the failed migration).
 */
export async function runDwnStoreMigrations(
  db: Kysely<any>,
  dialect: Dialect,
  migrations?: ReadonlyArray<readonly [name: string, factory: DwnMigrationFactory]>,
): Promise<string[]> {
  const provider = new DwnMigrationProvider(dialect, migrations ?? allDwnMigrations);
  const migrator = new Migrator({ db, provider });
  const resultSet: MigrationResultSet = await migrator.migrateToLatest();

  if (resultSet.error) {
    // Re-throw the underlying error so callers get a useful stack trace.
    // The resultSet.results still contains info about which migrations
    // succeeded before the failure.
    throw resultSet.error;
  }

  return (resultSet.results ?? [])
    .filter((r) => r.status === 'Success')
    .map((r) => r.migrationName);
}
