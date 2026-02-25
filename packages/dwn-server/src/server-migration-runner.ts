import type { Kysely, Migration, MigrationResultSet } from 'kysely';

import { allServerMigrations } from './migrations/index.js';
import { Migrator } from 'kysely';

/**
 * Simple {@link MigrationProvider} that returns a static dictionary of
 * server migrations. Unlike DWN store migrations, server table DDL uses
 * only standard SQL types, so no dialect closure is needed.
 */
class ServerMigrationProvider {
  #migrations: Record<string, Migration>;

  constructor(migrations: Record<string, Migration>) {
    this.#migrations = migrations;
  }

  public async getMigrations(): Promise<Record<string, Migration>> {
    return this.#migrations;
  }
}

/**
 * Runs all pending DWN server migrations against the given database.
 *
 * Uses Kysely's native {@link Migrator} with a separate migration table
 * (`dwn_server_migration`) to avoid collisions with the DWN store
 * migrations that use the default `kysely_migration` table.
 *
 * Call this once during server startup, before creating admin stores,
 * registration stores, or the TTL cache.
 *
 * @param db - An open Kysely instance connected to the target database.
 * @param migrations - Optional custom migration dictionary; defaults to
 *   the built-in {@link allServerMigrations}.
 * @returns The names of newly applied migrations (empty if already up-to-date).
 * @throws If any migration fails.
 */
export async function runServerMigrations(
  db: Kysely<any>,
  migrations?: Record<string, Migration>,
): Promise<string[]> {
  const provider = new ServerMigrationProvider(migrations ?? allServerMigrations);
  const migrator = new Migrator({
    db,
    provider,
    migrationTableName     : 'dwn_server_migration',
    migrationLockTableName : 'dwn_server_migration_lock',
  });

  const resultSet: MigrationResultSet = await migrator.migrateToLatest();

  if (resultSet.error) {
    throw resultSet.error;
  }

  return (resultSet.results ?? [])
    .filter((r) => r.status === 'Success')
    .map((r) => r.migrationName);
}
