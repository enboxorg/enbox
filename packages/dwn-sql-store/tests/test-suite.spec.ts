import type { DwnDatabaseType } from '../src/types.js';

import { DataStoreSql } from '../src/data-store-sql.js';
import { Kysely } from 'kysely';
import { MessageStoreSql } from '../src/message-store-sql.js';
import { ResumableTaskStoreSql } from '../src/resumable-task-store-sql.js';
import { runDwnStoreMigrations } from '../src/migration-runner.js';
import { StateIndexSql } from '../src/state-index-sql.js';
import { TestSuite } from '@enbox/dwn-sdk-js/tests';
import { afterAll, beforeAll, describe } from 'bun:test';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

describe('SQL Store Test Suite', () => {
  describe('MysqlDialect Support', () => {
    let db: Kysely<DwnDatabaseType>;

    beforeAll(async () => {
      db = new Kysely<DwnDatabaseType>({ dialect: testMysqlDialect });
      await runDwnStoreMigrations(db, testMysqlDialect);
    });

    afterAll(async () => {
      await db?.destroy();
    });

    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testMysqlDialect),
      dataStore          : new DataStoreSql(testMysqlDialect),
      stateIndex         : new StateIndexSql(testMysqlDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testMysqlDialect),
    });
  });

  describe('PostgresDialect Support', () => {
    let db: Kysely<DwnDatabaseType>;

    beforeAll(async () => {
      db = new Kysely<DwnDatabaseType>({ dialect: testPostgresDialect });
      await runDwnStoreMigrations(db, testPostgresDialect);
    });

    afterAll(async () => {
      await db?.destroy();
    });

    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testPostgresDialect),
      dataStore          : new DataStoreSql(testPostgresDialect),
      stateIndex         : new StateIndexSql(testPostgresDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testPostgresDialect),
    });
  });

  describe('SqliteDialect Support', () => {
    let db: Kysely<DwnDatabaseType>;

    beforeAll(async () => {
      db = new Kysely<DwnDatabaseType>({ dialect: testSqliteDialect });
      await runDwnStoreMigrations(db, testSqliteDialect);
    });

    afterAll(async () => {
      await db?.destroy();
    });

    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testSqliteDialect),
      dataStore          : new DataStoreSql(testSqliteDialect),
      stateIndex         : new StateIndexSql(testSqliteDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testSqliteDialect),
    });
  });
});
