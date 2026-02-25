import type { StateIndex } from '@enbox/dwn-sdk-js';

import { Kysely } from 'kysely';
import { createBunSqliteDatabase, runDwnStoreMigrations, SqliteDialect, StateIndexSql } from '@enbox/dwn-sql-store';

/**
 * An example of a plugin. Used for testing.
 * The points to note are:
 * - The class must be a default export.
 * - The constructor must not take any arguments.
 */
export default class StateIndexSqlite extends StateIndexSql implements StateIndex {
  #dialect: SqliteDialect;

  constructor() {
    const sharedDb = createBunSqliteDatabase(':memory:');
    const dialect = new SqliteDialect({ database: async (): Promise<typeof sharedDb> => sharedDb });
    super(dialect);
    this.#dialect = dialect;

    // NOTE: the following line is added purely to test the constructor invocation.
    StateIndexSqlite.spyingTheConstructor();
  }

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
