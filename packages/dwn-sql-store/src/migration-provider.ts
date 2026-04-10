import type { Dialect } from './dialect/dialect.js';
import type { Migration, MigrationProvider } from 'kysely';

/**
 * Factory function type for DWN migrations. Each migration module exports a
 * factory that receives the {@link Dialect} and returns a standard Kysely
 * {@link Migration}. This closure pattern lets migrations use dialect-specific
 * DDL helpers (blob columns, auto-increment, `hasTable()`) without requiring
 * Kysely's `Migration.up()` signature to accept extra parameters.
 */
export type DwnMigrationFactory = (dialect: Dialect) => Migration;

/**
 * Kysely {@link MigrationProvider} for DWN store migrations.
 *
 * Wraps an ordered list of `(name, factory)` pairs. At resolution time each
 * factory is called with the dialect, producing the concrete Kysely
 * {@link Migration} objects that the `Migrator` consumes.
 *
 * @example
 * ```ts
 * const provider = new DwnMigrationProvider(dialect, allDwnMigrations);
 * const migrator  = new Migrator({ db, provider });
 * await migrator.migrateToLatest();
 * ```
 */
export class DwnMigrationProvider implements MigrationProvider {
  readonly #dialect: Dialect;
  #factories: ReadonlyArray<readonly [name: string, factory: DwnMigrationFactory]>;

  constructor(
    dialect: Dialect,
    factories: ReadonlyArray<readonly [name: string, factory: DwnMigrationFactory]>,
  ) {
    this.#dialect = dialect;
    this.#factories = factories;
  }

  /**
   * Called by the Kysely `Migrator` to retrieve all available migrations.
   * Keys are migration names (e.g. `'001-initial-schema'`); values are the
   * concrete `Migration` objects produced by invoking each factory with the
   * captured dialect.
   */
  public async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    for (const [name, factory] of this.#factories) {
      migrations[name] = factory(this.#dialect);
    }
    return migrations;
  }
}
