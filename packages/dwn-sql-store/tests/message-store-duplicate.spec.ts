import { describe, expect, it } from 'bun:test';

import { isDuplicateKeyError } from '../src/message-store-sql.js';

// ---------------------------------------------------------------------------
// isDuplicateKeyError — unit tests for all dialect error shapes
// ---------------------------------------------------------------------------

describe('isDuplicateKeyError', () => {
  it('detects PostgreSQL unique_violation (code 23505)', () => {
    const err = new Error('duplicate key value violates unique constraint "index_tenant_messageCid"');
    (err as any).code = '23505';
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('detects MySQL ER_DUP_ENTRY (errno 1062)', () => {
    const err = new Error('Duplicate entry \'did:dht:abc-bafyrei123\' for key \'index_tenant_messageCid\'');
    (err as any).errno = 1062;
    (err as any).code = 'ER_DUP_ENTRY';
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('detects SQLite SQLITE_CONSTRAINT with UNIQUE', () => {
    const err = new Error('UNIQUE constraint failed: messageStoreMessages.tenant, messageStoreMessages.messageCid');
    (err as any).code = 'SQLITE_CONSTRAINT';
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('detects bun:sqlite SQLITE_CONSTRAINT_PRIMARYKEY with UNIQUE message', () => {
    const err = new Error('UNIQUE constraint failed: messageStoreMessages.tenant, messageStoreMessages.messageCid');
    (err as any).code = 'SQLITE_CONSTRAINT_PRIMARYKEY';
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('detects via fallback message matching (duplicate key + messageCid)', () => {
    const err = new Error('duplicate key value violates unique constraint on messageCid column');
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('detects via fallback message matching (Duplicate entry + unique constraint)', () => {
    const err = new Error('Duplicate entry for key \'unique constraint\'');
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isDuplicateKeyError(new Error('connection refused'))).toBe(false);
    expect(isDuplicateKeyError(new Error('syntax error'))).toBe(false);
    expect(isDuplicateKeyError(new Error('timeout'))).toBe(false);
  });

  it('does not match null/undefined', () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
  });

  it('does not match non-error objects', () => {
    expect(isDuplicateKeyError({ message: 'not an error' })).toBe(false);
    expect(isDuplicateKeyError(42)).toBe(false);
    expect(isDuplicateKeyError('string')).toBe(false);
  });

  it('does not match SQLITE_CONSTRAINT without UNIQUE in message', () => {
    const err = new Error('NOT NULL constraint failed: table.column');
    (err as any).code = 'SQLITE_CONSTRAINT';
    expect(isDuplicateKeyError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration test for idempotent put() is in the shared testMessageStore()
// suite in @enbox/dwn-sdk-js, which runs against all SQL dialects
// (PostgreSQL, MySQL, SQLite) via dwn-sql-store/tests/test-suite.spec.ts.
// ---------------------------------------------------------------------------
