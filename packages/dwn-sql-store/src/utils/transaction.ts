import { DwnDatabaseType } from '../types.js';
import { Kysely, Transaction } from 'kysely';

/**
 * Executes the provided transactional operation with retry if the database is locked.
 */
export async function executeWithRetryIfDatabaseIsLocked(
  database: Kysely<DwnDatabaseType>,
  operation: (transaction: Transaction<DwnDatabaseType>) => Promise<void>
): Promise<void>{
  let retryCount = 0;
  let success = false;
  while (!success) {
    try {
      await database.transaction().execute(operation);
      success = true;
    } catch (error) {
      // if error is "database is locked", we retry the transaction
      // this mainly happens when multiple transactions are trying to access the database at the same time in SQLite implementation.
      if (error.code === 'SQLITE_BUSY') {
        retryCount++;
        console.log(`Database is locked when attempting SQL operation, retrying #${retryCount}...`);
      } else {
        throw error;
      }
    }
  }
}