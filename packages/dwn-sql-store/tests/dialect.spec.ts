import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { DwnDatabaseType } from '../src/types.js';
import { executeWithRetryIfDatabaseIsLocked } from '../src/utils/transaction.js';
import { Kysely } from 'kysely';
import { TestDataGenerator } from '@tbd54566975/dwn-sdk-js';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

chai.use(chaiAsPromised);

describe('Dialect tests', () => {
  const databaseDialects = [testMysqlDialect, testPostgresDialect, testSqliteDialect];
  for (const dialect of databaseDialects) {
    it(`hasTable() should work: ${dialect.name}`, async () => {
      const database = new Kysely<DwnDatabaseType>({ dialect });

      const randomTableName = `test_table_${TestDataGenerator.randomString(10)}`;

      let tableExists = await dialect.hasTable(database, randomTableName);
      expect(tableExists).to.be.false;

      await database.schema
        .createTable(randomTableName)
        .addColumn('anyColumn', 'text')
        .execute();

      tableExists = await dialect.hasTable(database, randomTableName);
      expect(tableExists).to.be.true;

      await database.schema.dropTable(randomTableName).execute();

      tableExists = await dialect.hasTable(database, randomTableName);
      expect(tableExists).to.be.false;
    });

    it(`executeWithRetryIfDatabaseIsLocked() should rethrow error if its not due to database being locked: ${dialect.name}: ${dialect.name}`, async () => {
      const database = new Kysely<DwnDatabaseType>({ dialect });
      const operation = async (_transaction) => {
        throw new Error('Some error');
      };

      const executePromise = executeWithRetryIfDatabaseIsLocked(database, operation);
      await expect(executePromise).to.be.rejectedWith('Some error');
    });
  }
});