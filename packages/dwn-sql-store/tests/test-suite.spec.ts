import { DataStoreSql } from '../src/data-store-sql.js';
import { describe } from 'bun:test';
import { MessageStoreSql } from '../src/message-store-sql.js';
import { ResumableTaskStoreSql } from '../src/resumable-task-store-sql.js';
import { StateIndexSql } from '../src/state-index-sql.js';
import { TestSuite } from '@enbox/dwn-sdk-js/tests';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

describe('SQL Store Test Suite', () => {
  describe('MysqlDialect Support', () => {
    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testMysqlDialect),
      dataStore          : new DataStoreSql(testMysqlDialect),
      stateIndex         : new StateIndexSql(testMysqlDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testMysqlDialect),
    });
  });

  describe('PostgresDialect Support', () => {
    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testPostgresDialect),
      dataStore          : new DataStoreSql(testPostgresDialect),
      stateIndex         : new StateIndexSql(testPostgresDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testPostgresDialect),
    });
  });

  describe('SqliteDialect Support', () => {
    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testSqliteDialect),
      dataStore          : new DataStoreSql(testSqliteDialect),
      stateIndex         : new StateIndexSql(testSqliteDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testSqliteDialect),
    });
  });
});