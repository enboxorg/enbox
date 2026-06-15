import type { DwnDatabaseType } from '../src/types.js';
import type { Transaction } from 'kysely';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { executeWithTransaction, isRetryableTransactionError, retryDelayMs } from '../src/utils/transaction.js';
import { existsSync, unlinkSync } from 'node:fs';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

function unlinkIfExists(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

describe('Dialect tests', () => {
  const databaseDialects = [testMysqlDialect, testPostgresDialect, testSqliteDialect];
  for (const dialect of databaseDialects) {
    it(`hasTable() should work: ${dialect.name}`, async () => {
      const database = new Kysely<DwnDatabaseType>({ dialect });

      const randomTableName = `test_table_${TestDataGenerator.randomString(10)}`;

      let tableExists = await dialect.hasTable(database, randomTableName);
      expect(tableExists).toBe(false);

      await database.schema
        .createTable(randomTableName)
        .addColumn('anyColumn', 'text')
        .execute();

      tableExists = await dialect.hasTable(database, randomTableName);
      expect(tableExists).toBe(true);

      await database.schema.dropTable(randomTableName).execute();

      tableExists = await dialect.hasTable(database, randomTableName);
      expect(tableExists).toBe(false);
    });

    it(`executeWithTransaction() should rethrow errors: ${dialect.name}`,
      async (): Promise<void> => {
        const database = new Kysely<DwnDatabaseType>({ dialect });
        const operation = async (_transaction): Promise<void> => {
          throw new Error('Some error');
        };

        const executePromise = executeWithTransaction(database, operation);
        await expect(executePromise).rejects.toThrow('Some error');
      });
  }

  it('executeWithTransaction() should retry transient transaction errors', async () => {
    let attempts = 0;
    const deadlock = new Error('Deadlock found when trying to get lock');
    (deadlock as any).errno = 1213;

    const database = {
      transaction: (): { execute<T>(operation: (transaction: Transaction<DwnDatabaseType>) => Promise<T>): Promise<T> } => ({
        execute: async <T>(operation: (transaction: Transaction<DwnDatabaseType>) => Promise<T>): Promise<T> => {
          attempts++;
          if (attempts < 3) {
            throw deadlock;
          }
          return operation({} as Transaction<DwnDatabaseType>);
        },
      }),
    } as Kysely<DwnDatabaseType>;

    await expect(executeWithTransaction(database, async (): Promise<string> => 'ok')).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('retryDelayMs() should apply bounded jittered backoff', () => {
    const cases = [
      { attempt: 1, min: 5, max: 10 },
      { attempt: 2, min: 10, max: 20 },
      { attempt: 10, min: 50, max: 100 },
    ];

    for (const testCase of cases) {
      for (let i = 0; i < 20; i++) {
        const delay = retryDelayMs(testCase.attempt);
        expect(delay).toBeGreaterThanOrEqual(testCase.min);
        expect(delay).toBeLessThanOrEqual(testCase.max);
      }
    }
  });

  it('executeWithTransaction() should stop retrying after maxAttempts', async () => {
    let attempts = 0;
    const deadlock = new Error('Deadlock found when trying to get lock');
    (deadlock as any).errno = 1213;

    const database = {
      transaction: (): { execute<T>(operation: (transaction: Transaction<DwnDatabaseType>) => Promise<T>): Promise<T> } => ({
        execute: async <T>(): Promise<T> => {
          attempts++;
          throw deadlock;
        },
      }),
    } as Kysely<DwnDatabaseType>;

    await expect(executeWithTransaction(database, async (): Promise<string> => 'ok', { maxAttempts: 2 }))
      .rejects.toThrow('Deadlock found');
    expect(attempts).toBe(2);
  });

  it('isRetryableTransactionError() should not match unique constraint errors', () => {
    const duplicate = new Error('duplicate key value violates unique constraint "index_tenant_messageCid"');
    (duplicate as any).code = '23505';

    expect(isRetryableTransactionError(duplicate)).toBe(false);
  });

  it('createBunSqliteDatabase() should configure file-backed write databases for contention', () => {
    const path = join(tmpdir(), `enbox-sqlite-${TestDataGenerator.randomString(10)}.db`);
    const database = createBunSqliteDatabase(path);

    try {
      const timeout = database.prepare('PRAGMA busy_timeout').all([])[0] as { timeout: number };
      const journalMode = database.prepare('PRAGMA journal_mode').all([])[0] as { journal_mode: string };

      expect(timeout.timeout).toBe(5_000);
      expect(journalMode.journal_mode).toBe('wal');
    } finally {
      database.close();
      unlinkIfExists(path);
      unlinkIfExists(`${path}-shm`);
      unlinkIfExists(`${path}-wal`);
    }
  });
});
