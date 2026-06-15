import type { DwnDatabaseType } from '../types.js';
import type { Kysely, Transaction } from 'kysely';

import { randomInt } from 'node:crypto';

export type TransactionOptions = {
  maxAttempts?: number;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 5;
const MAX_RETRY_DELAY_MS = 50;
const RETRYABLE_ERROR_CODES = new Set<unknown>([
  '1205',
  '1213',
  '40001',
  '40P01',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes the provided operation atomically within a database transaction.
 */
export async function executeWithTransaction<T>(
  database: Kysely<DwnDatabaseType>,
  operation: (transaction: Transaction<DwnDatabaseType>) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  for (let attempt = 1; ; attempt++) {
    try {
      return await database.transaction().execute(operation);
    } catch (error: unknown) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }

      await sleep(retryDelayMs(attempt));
    }
  }
}

export function retryDelayMs(attempt: number): number {
  const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempt - 1)));
  return delay + randomInt(delay + 1);
}

/**
 * Detects transient database transaction failures that are safe to retry by
 * re-running the entire transaction body on a fresh transaction.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, unknown>;
  if (RETRYABLE_ERROR_CODES.has(err.code) || RETRYABLE_ERROR_CODES.has(err.errno) || RETRYABLE_ERROR_CODES.has(err.sqlState)) {
    return true;
  }

  const message = typeof err.message === 'string' ? err.message : '';
  return message.includes('Deadlock found') ||
    message.includes('Lock wait timeout exceeded') ||
    message.includes('database is locked');
}
