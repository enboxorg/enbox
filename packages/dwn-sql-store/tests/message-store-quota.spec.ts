import type { DwnDatabaseType, KeyValues } from '../src/types.js';
import type { GenericMessage, MessageStoreQuota } from '@enbox/dwn-sdk-js';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import { MessageStoreSql } from '../src/message-store-sql.js';
import { runDwnStoreMigrations } from '../src/migration-runner.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnError, DwnErrorCode, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { mkdtempSync, rmSync } from 'node:fs';

type StoredMessage = {
  indexes: KeyValues;
  message: GenericMessage;
  messageCid: string;
};

describe('MessageStoreSql quota admission', () => {
  const dataLocation = mkdtempSync(join(tmpdir(), 'dwn-message-quota-'));
  const dialect = new SqliteDialect({
    database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> =>
      createBunSqliteDatabase(join(dataLocation, 'quota.sqlite'), { create: true }),
  });
  let db: Kysely<DwnDatabaseType>;
  let quota: MessageStoreQuota | undefined;
  let store: MessageStoreSql;

  beforeAll(async () => {
    db = new Kysely<DwnDatabaseType>({ dialect });
    await runDwnStoreMigrations(db, dialect);
    store = new MessageStoreSql(dialect, undefined, async () => quota);
    await store.open();
  });

  beforeEach(async () => {
    quota = undefined;
    await store.clear();
  });

  afterAll(async () => {
    await store.close();
    await db.destroy();
    rmSync(dataLocation, { recursive: true, force: true });
  });

  async function generateMessage(dataSize: number, isLatestBaseState = true): Promise<StoredMessage> {
    const { message } = await TestDataGenerator.generateRecordsWrite();
    const messageCid = await Message.getCid(message);
    const indexes: KeyValues = {
      interface        : 'Records',
      method           : 'Write',
      recordId         : message.recordId,
      dataSize,
      isLatestBaseState,
      messageTimestamp : message.descriptor.messageTimestamp,
    };
    return { indexes, message, messageCid };
  }

  it('should admit at most one of two concurrent inserts into the final message slot', async () => {
    const tenant = 'did:example:concurrent-quota';
    const writes = await Promise.all([generateMessage(1), generateMessage(1)]);
    quota = { maxMessages: 1, maxStorageBytes: 0 };

    const results = await Promise.allSettled(
      writes.map(({ indexes, message }) => store.put(tenant, message, indexes)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(DwnError);
    expect((rejection.reason as DwnError).code).toBe(DwnErrorCode.MessageStoreQuotaMessagesExceeded);
    expect(await store.count(tenant, [{}])).toBe(1);
  });

  it('should acknowledge an exact duplicate after the message limit is reached', async () => {
    const tenant = 'did:example:duplicate-quota';
    const stored = await generateMessage(1);
    quota = { maxMessages: 1, maxStorageBytes: 1 };

    expect((await store.put(tenant, stored.message, stored.indexes)).status).toBe('inserted');
    expect((await store.put(tenant, stored.message, stored.indexes)).status).toBe('duplicate');
    expect((await store.commitLatestState(tenant, {
      put: { message: stored.message, indexes: stored.indexes },
    })).status).toBe('duplicate');
  });

  it('should still quota-check index mutations attached to a duplicate transition', async () => {
    const tenant = 'did:example:duplicate-transition-quota';
    const latest = await generateMessage(100);
    const historical = await generateMessage(100, false);
    await store.put(tenant, latest.message, latest.indexes);
    await store.put(tenant, historical.message, historical.indexes);
    quota = { maxMessages: 2, maxStorageBytes: 100 };

    await expect(store.commitLatestState(tenant, {
      put     : { message: latest.message, indexes: latest.indexes },
      retains : [{
        messageCid : historical.messageCid,
        message    : historical.message,
        indexes    : { ...historical.indexes, isLatestBaseState: true },
      }],
    })).rejects.toThrow(DwnErrorCode.MessageStoreQuotaStorageExceeded);
  });

  it('should apply quota to exact transition growth and allow zero-growth updates', async () => {
    const tenant = 'did:example:transition-quota';
    const first = await generateMessage(100);
    await store.put(tenant, first.message, first.indexes);
    quota = { maxMessages: 2, maxStorageBytes: 100 };

    const second = await generateMessage(100);
    const retainedFirstIndexes = { ...first.indexes, isLatestBaseState: false };
    const secondResult = await store.commitLatestState(tenant, {
      put     : { message: second.message, indexes: second.indexes },
      retains : [{ messageCid: first.messageCid, message: first.message, indexes: retainedFirstIndexes }],
    });
    expect(secondResult).toMatchObject({ status: 'inserted' });

    const third = await generateMessage(100);
    const thirdResult = await store.commitLatestState(tenant, {
      put     : { message: third.message, indexes: third.indexes },
      retains : [{ messageCid: first.messageCid, message: first.message, indexes: retainedFirstIndexes }],
      deletes : [second.messageCid],
    });
    expect(thirdResult).toMatchObject({ status: 'inserted' });

    const growing = await generateMessage(101);
    await expect(store.commitLatestState(tenant, {
      put     : { message: growing.message, indexes: growing.indexes },
      retains : [{ messageCid: first.messageCid, message: first.message, indexes: retainedFirstIndexes }],
      deletes : [third.messageCid],
    })).rejects.toThrow(DwnErrorCode.MessageStoreQuotaStorageExceeded);

    expect(await store.get(tenant, growing.messageCid)).toBeUndefined();
    expect(await store.get(tenant, third.messageCid)).toBeDefined();
    expect(await store.count(tenant, [{}])).toBe(2);
  });

  it('should allow non-latest historical writes at the data quota', async () => {
    const tenant = 'did:example:historical-quota';
    const latest = await generateMessage(100);
    await store.put(tenant, latest.message, latest.indexes);
    const historical = await generateMessage(100, false);
    quota = { maxMessages: 0, maxStorageBytes: 100 };

    await expect(store.put(tenant, historical.message, historical.indexes)).resolves.toMatchObject({ status: 'inserted' });
  });
});
