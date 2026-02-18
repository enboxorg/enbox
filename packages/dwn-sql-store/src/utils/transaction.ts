import type { DwnDatabaseType } from '../types.js';
import type { Kysely, Transaction } from 'kysely';

/**
 * Executes the provided operation atomically within a database transaction.
 */
export async function executeWithTransaction(
  database: Kysely<DwnDatabaseType>,
  operation: (transaction: Transaction<DwnDatabaseType>) => Promise<void>
): Promise<void> {
  await database.transaction().execute(operation);
}
