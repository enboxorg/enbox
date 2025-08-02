import { DataStoreSql } from '../src/data-store-sql.js';
import { EventLogSql } from '../src/event-log-sql.js';
import { MessageStoreSql } from '../src/message-store-sql.js';
import { ResumableTaskStoreSql } from '../src/resumable-task-store-sql.js';
import { TestSuite } from '@tbd54566975/dwn-sdk-js/tests';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

// Remove when we Node.js v18 is no longer supported by this project.
// Node.js v18 maintenance begins 2023-10-18 and is EoL 2025-04-30: https://github.com/nodejs/release#release-schedule
import { webcrypto } from 'node:crypto';
// @ts-expect-error ignore type mismatch
if (!globalThis.crypto) globalThis.crypto = webcrypto;

describe('SQL Store Test Suite', () => {
  describe('MysqlDialect Support', () => {
    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testMysqlDialect),
      dataStore          : new DataStoreSql(testMysqlDialect),
      eventLog           : new EventLogSql(testMysqlDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testMysqlDialect),
    });
  });

  describe('PostgresDialect Support', () => {
    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testPostgresDialect),
      dataStore          : new DataStoreSql(testPostgresDialect),
      eventLog           : new EventLogSql(testPostgresDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testPostgresDialect),
    });
  });

  describe('SqliteDialect Support', () => {
    TestSuite.runInjectableDependentTests({
      messageStore       : new MessageStoreSql(testSqliteDialect),
      dataStore          : new DataStoreSql(testSqliteDialect),
      eventLog           : new EventLogSql(testSqliteDialect),
      resumableTaskStore : new ResumableTaskStoreSql(testSqliteDialect),
    });
  });
});