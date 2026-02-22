import type { Dialect } from './dialect/dialect.js';
import type { Kysely } from 'kysely';

import { allMigrations } from './migrations/index.js';

/**
 * A single migration step. Migrations are TypeScript functions (not raw SQL)
 * so they can use the Dialect abstraction for cross-dialect column types.
 */
export type Migration = {
  /** Unique sequential name, e.g. '001-initial-schema'. */
  name: string;
  /**
   * Apply this migration. Receives the Kysely instance and dialect for
   * dialect-aware DDL (blob types, auto-increment, etc.).
   */
  up(db: Kysely<any>, dialect: Dialect): Promise<void>;
};

type MigrationRecord = {
  name: string;
  appliedAt: string;
};

type MigrationDatabaseType = {
  dwn_migrations: MigrationRecord;
};

/**
 * Minimal forward-only migration runner for dwn-sql-store.
 *
 * Tracks applied migrations in a `dwn_migrations` table and applies
 * pending migrations in sequential order on each call to `run()`.
 *
 * Design decisions:
 * - Forward-only: no rollback support. Keep migrations simple and additive.
 * - TypeScript migrations: use the Dialect interface for cross-dialect DDL.
 * - Idempotent: calling `run()` on an up-to-date database is a no-op.
 * - Transaction per migration: each migration runs in its own transaction
 *   so a failure leaves the database in the last known-good state.
 */
/**
 * Convenience function to run all DWN store migrations against a database.
 *
 * Creates a `MigrationRunner` with the full set of built-in migrations and
 * runs them. Call this once during application startup, before opening any
 * stores — e.g. in `getDwnConfig()` or equivalent initialization code.
 *
 * @param db - An open Kysely instance connected to the target database.
 * @param dialect - The dialect for the target database.
 * @returns The names of newly applied migrations (empty if already up-to-date).
 */
export async function runDwnStoreMigrations(db: Kysely<any>, dialect: Dialect): Promise<string[]> {
  const runner = new MigrationRunner(db, dialect, allMigrations);
  return runner.run();
}

export class MigrationRunner {
  #db: Kysely<MigrationDatabaseType>;
  #dialect: Dialect;
  #migrations: Migration[];

  constructor(db: Kysely<any>, dialect: Dialect, migrations: Migration[]) {
    this.#db = db as Kysely<MigrationDatabaseType>;
    this.#dialect = dialect;
    this.#migrations = migrations;
  }

  /**
   * Ensure the `dwn_migrations` tracking table exists, then apply any
   * pending migrations in order. Returns the names of newly applied migrations.
   */
  public async run(): Promise<string[]> {
    await this.#ensureMigrationTable();

    const applied = await this.#getAppliedMigrations();
    const appliedSet = new Set(applied);
    const pending = this.#migrations.filter((m) => !appliedSet.has(m.name));

    const newlyApplied: string[] = [];
    for (const migration of pending) {
      await this.#applyMigration(migration);
      newlyApplied.push(migration.name);
    }

    return newlyApplied;
  }

  /**
   * Create the `dwn_migrations` table if it does not already exist.
   */
  async #ensureMigrationTable(): Promise<void> {
    const exists = await this.#dialect.hasTable(this.#db, 'dwn_migrations');
    if (exists) {
      return;
    }

    await this.#db.schema
      .createTable('dwn_migrations')
      .ifNotExists()
      .addColumn('name', 'varchar(255)', (col) => col.primaryKey().notNull())
      .addColumn('appliedAt', 'varchar(30)', (col) => col.notNull())
      .execute();
  }

  /**
   * Get the list of migration names that have already been applied.
   */
  async #getAppliedMigrations(): Promise<string[]> {
    const rows = await this.#db
      .selectFrom('dwn_migrations')
      .select('name')
      .orderBy('name', 'asc')
      .execute();

    return rows.map((r) => r.name);
  }

  /**
   * Apply a single migration within a transaction and record it.
   */
  async #applyMigration(migration: Migration): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      // Run the migration
      await migration.up(trx as unknown as Kysely<any>, this.#dialect);

      // Record it as applied
      await (trx as unknown as Kysely<MigrationDatabaseType>)
        .insertInto('dwn_migrations')
        .values({
          name      : migration.name,
          appliedAt : new Date().toISOString(),
        })
        .execute();
    });
  }
}
