import type { DwnDatabaseType } from '../src/types.js';

import { executeWithTransaction } from '../src/utils/transaction.js';
import { Kysely } from 'kysely';
import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

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
});