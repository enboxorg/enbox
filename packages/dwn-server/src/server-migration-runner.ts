import type { Dialect } from '@enbox/dwn-sql-store';
import type { ServerMigrationFactory } from './migrations/index.js';
import type { Kysely, Migration, MigrationProvider, MigrationResultSet } from 'kysely';

import { allServerMigrations } from './migrations/index.js';
import { Migrator } from 'kysely';

/**
 * {@link MigrationProvider} for server migrations. Wraps an ordered list of
 * `(name, factory)` pairs. At resolution time each factory is called with the
 * dialect, producing the concrete Kysely {@link Migration} objects.
 */
class ServerMigrationProvider implements MigrationProvider {
  readonly #dialect: Dialect;
  #factories: ReadonlyArray<readonly [name: string, factory: ServerMigrationFactory]>;

  constructor(
    dialect: Dialect,
    factories: ReadonlyArray<readonly [name: string, factory: ServerMigrationFactory]>,
  ) {
    this.#dialect = dialect;
    this.#factories = factories;
  }

  public async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    for (const [name, factory] of this.#factories) {
      migrations[name] = factory(this.#dialect);
    }
    return migrations;
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
 * @param dialect - The dialect for the target database. Passed to each
 *   migration factory so it can use dialect-specific DDL helpers.
 * @param migrations - Optional custom migration list; defaults to the
 *   built-in {@link allServerMigrations}.
 * @returns The names of newly applied migrations (empty if already up-to-date).
 * @throws If any migration fails.
 */
export async function runServerMigrations(
  db: Kysely<any>,
  dialect: Dialect,
  migrations?: ReadonlyArray<readonly [name: string, factory: ServerMigrationFactory]>,
): Promise<string[]> {
  const provider = new ServerMigrationProvider(dialect, migrations ?? allServerMigrations);
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
