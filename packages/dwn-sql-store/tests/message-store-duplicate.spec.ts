import { describe, expect, it } from 'bun:test';

import { isDuplicateKeyError, isMessageCidDuplicateKeyError } from '../src/message-store-sql.js';

// ---------------------------------------------------------------------------
// isDuplicateKeyError — unit tests for all dialect error shapes
// ---------------------------------------------------------------------------

describe('isDuplicateKeyError', () => {
  it.each([
    ['PostgreSQL unique_violation (code 23505)',
      'duplicate key value violates unique constraint "index_tenant_messageCid"',
      { code: '23505' }],
    ['MySQL ER_DUP_ENTRY (errno 1062)',
      'Duplicate entry \'did:dht:abc-bafyrei123\' for key \'index_tenant_messageCid\'',
      { code: 'ER_DUP_ENTRY', errno: 1062 }],
    ['SQLite SQLITE_CONSTRAINT with UNIQUE',
      'UNIQUE constraint failed: messageStoreMessages.tenant, messageStoreMessages.messageCid',
      { code: 'SQLITE_CONSTRAINT' }],
    ['bun:sqlite SQLITE_CONSTRAINT_PRIMARYKEY with UNIQUE message',
      'UNIQUE constraint failed: messageStoreMessages.tenant, messageStoreMessages.messageCid',
      { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }],
    ['fallback message matching (duplicate key + messageCid)',
      'duplicate key value violates unique constraint on messageCid column',
      {}],
    ['fallback message matching (Duplicate entry + unique constraint)',
      'Duplicate entry for key \'unique constraint\'',
      {}],
  ])('detects %s', (_name, message, properties) => {
    const err = Object.assign(new Error(message), properties);
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

describe('isMessageCidDuplicateKeyError', () => {
  it('detects the message-store message CID unique index', () => {
    const err = new Error('duplicate key value violates unique constraint "index_tenant_messageCid"');
    (err as any).code = '23505';
    (err as any).constraint = 'index_tenant_messageCid';

    expect(isMessageCidDuplicateKeyError(err)).toBe(true);
  });

  it('detects PostgreSQL message CID unique indexes with unquoted lowercase names', () => {
    const err = new Error('duplicate key value violates unique constraint "index_tenant_messagecid"');
    (err as any).code = '23505';
    (err as any).constraint = 'index_tenant_messagecid';

    expect(isMessageCidDuplicateKeyError(err)).toBe(true);
  });

  it('does not match replication position unique indexes', () => {
    const postgresSeqError = new Error('duplicate key value violates unique constraint "index_messageStoreMessages_tenant_seq"');
    (postgresSeqError as any).code = '23505';
    (postgresSeqError as any).constraint = 'index_messageStoreMessages_tenant_seq';

    const sqliteSeqError = new Error('UNIQUE constraint failed: messageStoreMessages.tenant, messageStoreMessages.seq');
    (sqliteSeqError as any).code = 'SQLITE_CONSTRAINT_UNIQUE';

    expect(isMessageCidDuplicateKeyError(postgresSeqError)).toBe(false);
    expect(isMessageCidDuplicateKeyError(sqliteSeqError)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration test for idempotent put() is in the shared testMessageStore()
// suite in @enbox/dwn-sdk-js, which runs against all SQL dialects
// (PostgreSQL, MySQL, SQLite) via dwn-sql-store/tests/test-suite.spec.ts.
// ---------------------------------------------------------------------------
