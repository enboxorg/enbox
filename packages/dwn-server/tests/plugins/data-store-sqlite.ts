import type { DataStore } from '@enbox/dwn-sdk-js';

import { Kysely } from 'kysely';
import { createBunSqliteDatabase, DataStoreSql, runDwnStoreMigrations, SqliteDialect } from '@enbox/dwn-sql-store';

/**
 * An example of a plugin that is used for testing.
 * The points to note are:
 * - The class must be a default export.
 * - The constructor must not take any arguments.
 */
export default class DataStoreSqlite extends DataStoreSql implements DataStore {
  #dialect: SqliteDialect;

  constructor() {
    // Share a single in-memory database via a stable reference so that
    // migrations and store operations target the same `:memory:` DB.
    const sharedDb = createBunSqliteDatabase(':memory:');
    const dialect = new SqliteDialect({ database: async (): Promise<typeof sharedDb> => sharedDb });
    super(dialect);
    this.#dialect = dialect;

    // NOTE: the following line is added purely to test the constructor invocation.
    DataStoreSqlite.spyingTheConstructor();
  }

  /**
   * Runs DWN store migrations before delegating to the parent `open()`.
   * Plugin-based stores manage their own isolated DB, so they must
   * bootstrap the schema themselves.
   */
  public override async open(): Promise<void> {
    const db = new Kysely<Record<string, unknown>>({ dialect: this.#dialect });
    await runDwnStoreMigrations(db, this.#dialect);
    await super.open();
  }

  /**
   * NOTE: This method is introduced purely to indirectly test/spy invocation of the constructor.
   * As I was unable to find an easy way to directly spy the constructor.
   */
  public static spyingTheConstructor(): void {
  }
}
