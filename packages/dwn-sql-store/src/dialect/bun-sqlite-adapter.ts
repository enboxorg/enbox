/**
 * Adapter that wraps Bun's built-in SQLite (`bun:sqlite`) to conform to Kysely's
 * `SqliteDatabase` / `SqliteStatement` interfaces, enabling it as a drop-in
 * replacement for `better-sqlite3`.
 */
import { Database as BunDatabase } from 'bun:sqlite';

/**
 * Matches Kysely's SqliteStatement interface.
 */
interface KyselySqliteStatement {
  readonly reader: boolean;
  all(parameters: ReadonlyArray<unknown>): unknown[];
  run(parameters: ReadonlyArray<unknown>): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

/**
 * Matches Kysely's SqliteDatabase interface.
 */
interface KyselySqliteDatabase {
  close(): void;
  prepare(sql: string): KyselySqliteStatement;
}

/** SQL command prefixes that indicate a read/query operation. */
const READER_PREFIXES = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i;

/**
 * Creates a Kysely-compatible SQLite database backed by `bun:sqlite`.
 *
 * @param path - File path or `":memory:"` for in-memory database.
 * @param options - Options forwarded to `bun:sqlite`'s Database constructor.
 *   - `readonly`:  Open in read-only mode.
 *   - `create`:    Create the file if it doesn't exist (default: true).
 * @returns An object implementing Kysely's `SqliteDatabase` interface.
 */
export function createBunSqliteDatabase(
  path: string,
  options?: { readonly?: boolean; create?: boolean },
): KyselySqliteDatabase {
  const db = new BunDatabase(path, options);

  return {
    close(): void {
      db.close();
    },

    prepare(sql: string): KyselySqliteStatement {
      const stmt = db.prepare(sql);
      const isReader = READER_PREFIXES.test(sql);

      return {
        get reader(): boolean {
          return isReader;
        },

        all(parameters: ReadonlyArray<unknown>): unknown[] {
          return stmt.all(...(parameters as any[]));
        },

        run(parameters: ReadonlyArray<unknown>): {
          changes: number | bigint;
          lastInsertRowid: number | bigint;
        } {
          return stmt.run(...(parameters as any[])) as {
            changes: number | bigint;
            lastInsertRowid: number | bigint;
          };
        },
      };
    },
  };
}
