import { MysqlDialect } from '../src/dialect/mysql-dialect.js';
import { PostgresDialect } from '../src/dialect/postgres-dialect.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { createPool } from 'mysql2';
import pg from 'pg';
import Cursor from 'pg-cursor';

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
  url: 'file:dwn.sqlite'
});
