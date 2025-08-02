import { MysqlDialect } from '../src/dialect/mysql-dialect.js';
import { PostgresDialect } from '../src/dialect/postgres-dialect.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { createPool } from 'mysql2';
import pg from 'pg';
import Cursor from 'pg-cursor';
import Database from 'better-sqlite3';

export const testMysqlDialect = new MysqlDialect({
  pool: async () => createPool({
    host     : 'localhost',
    port     : 3306,
    database : 'dwn',
    user     : 'root',
    password : 'dwn'
  })
});

export const testPostgresDialect = new PostgresDialect({
  pool: async () => new pg.Pool({
    host     : 'localhost',
    port     : 5432,
    database : 'dwn',
    user     : 'root',
    password : 'dwn'
  }),
  cursor: Cursor
});

export const testSqliteDialect = new SqliteDialect({
  database: async () => new Database(
    'dwn.sqlite',
    {
      fileMustExist : true,
      // IMPORTANT: denotes how long to wait before attempting to execute a query when database is locked, and throws an error if it is still locked
      // The default is 5 seconds, see https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#new-databasepath-options
      // NOTE: this is also equivalent to setting the pragma "busy_timeout" directly: database.pragma('busy_timeout = 100');
      timeout       : 100 // 100ms
    }
  )
});
