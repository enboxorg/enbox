import Cursor from 'pg-cursor';
import pg from 'pg';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { createPool } from 'mysql2';
import { MysqlDialect } from '../src/dialect/mysql-dialect.js';
import { PostgresDialect } from '../src/dialect/postgres-dialect.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';

export const testMysqlDialect = new MysqlDialect({
  pool: async (): Promise<ReturnType<typeof createPool>> => createPool({
    host     : 'localhost',
    port     : 3306,
    database : 'dwn',
    user     : 'root',
    password : 'dwn'
  })
});

export const testPostgresDialect = new PostgresDialect({
  pool: async (): Promise<pg.Pool> => new pg.Pool({
    host     : 'localhost',
    port     : 5432,
    database : 'dwn',
    user     : 'root',
    password : 'dwn'
  }),
  cursor: Cursor
});

export const testSqliteDialect = new SqliteDialect({
  database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> => createBunSqliteDatabase('dwn.sqlite', { create: true }),
});

/**
 * Creates a fresh SQLite dialect with the given database file name.
 * Useful for tests that need an isolated database (e.g., DataStoreS3 tests).
 */
export function getTestSqliteDialect(filename = 'dwn-s3-test.sqlite'): SqliteDialect {
  return new SqliteDialect({
    database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> => createBunSqliteDatabase(filename, { create: true }),
  });
}
