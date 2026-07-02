import type { Dialect } from '../src/dialect/dialect.js';
import type { DwnDatabaseType, KeyValues } from '../src/types.js';
import type { Wake, WakePublisher } from '@enbox/dwn-sdk-js';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { Kysely } from 'kysely';
import { MessageStoreSql } from '../src/message-store-sql.js';
import { runDwnStoreMigrations } from '../src/migration-runner.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  DwnErrorCode,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  Message,
  Replication,
  TestDataGenerator,
} from '@enbox/dwn-sdk-js';
import { testMysqlDialect, testPostgresDialect, testSqliteDialect } from './test-dialects.js';

const ZERO_FINGERPRINT = '0'.repeat(64);

class RecordingWakePublisher implements WakePublisher {
  public readonly wakes: Wake[] = [];

  public publish(wake: Wake): void {
    this.wakes.push(wake);
  }

  public clear(): void {
    this.wakes.length = 0;
  }
}

async function cidFingerprint(messageCid: string): Promise<string> {
  return Replication.fingerprintToHex(await Replication.hashMessageCid(messageCid));
}

function xorHex(a: string, b: string): string {
  return Replication.fingerprintToHex(
    Replication.xorFingerprint(Replication.hexToFingerprint(a), Replication.hexToFingerprint(b))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateStoredMessage(overrides: {
  protocol?: string;
  protocolPath?: string;
  recipient?: string;
  tags?: Record<string, string>;
} = {}): Promise<{ message: any, messageCid: string, indexes: KeyValues }> {
  const { message } = await TestDataGenerator.generateRecordsWrite({
    ...(overrides.protocol !== undefined && { protocol: overrides.protocol, protocolPath: overrides.protocolPath ?? 'post' }),
    ...(overrides.recipient !== undefined && { recipient: overrides.recipient }),
    ...(overrides.tags !== undefined && { tags: overrides.tags }),
  });

  const messageCid = await Message.getCid(message);
  const indexes: KeyValues = {
    interface         : 'Records',
    method            : 'Write',
    messageTimestamp  : message.descriptor.messageTimestamp,
    isLatestBaseState : true,
    recordId          : message.recordId,
  };

  if (message.descriptor.protocol !== undefined) {
    indexes.protocol = message.descriptor.protocol;
    indexes.protocolPath = message.descriptor.protocolPath;
  }
  if (message.descriptor.recipient !== undefined) {
    indexes.recipient = message.descriptor.recipient;
  }

  if (message.descriptor.tags !== undefined) {
    for (const [key, value] of Object.entries(message.descriptor.tags)) {
      indexes[`tag.${key}`] = value as string;
    }
  }

  return { message, messageCid, indexes };
}

function constructProtocolConfigureIndexes(message: any, author: string, isLatestBaseState: boolean): KeyValues {
  return {
    interface        : message.descriptor.interface,
    method           : message.descriptor.method,
    messageTimestamp : message.descriptor.messageTimestamp,
    author,
    protocol         : message.descriptor.definition.protocol,
    published        : message.descriptor.definition.published,
    isLatestBaseState,
  };
}

function runReplicationLogTests(dialect: Dialect): void {
  describe(`${dialect.name} replication feed`, () => {
    let db: Kysely<DwnDatabaseType>;
    let messageStore: MessageStoreSql;
    let wakePublisher: RecordingWakePublisher;

    beforeAll(async () => {
      db = new Kysely<DwnDatabaseType>({ dialect });
      await runDwnStoreMigrations(db, dialect);
      wakePublisher = new RecordingWakePublisher();
      messageStore = new MessageStoreSql(dialect, wakePublisher);
      await messageStore.open();
    });

    beforeEach(async () => {
      await messageStore.clear();
      wakePublisher.clear();
    });

    afterAll(async () => {
      await messageStore.close();
      await db?.destroy();
    });

    it('should append puts in commit order, return positions, and publish wakes', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const storedCids: string[] = [];

      for (let i = 0; i < 3; i++) {
        const { message, messageCid, indexes } = await generateStoredMessage();
        const result = await messageStore.put(alice.did, message, indexes);

        expect(result.status).toBe('inserted');
        expect(result.position!.position).toBe(String(i + 1));
        expect(result.position!.messageCid).toBe(messageCid);
        storedCids.push(messageCid);
      }

      expect(wakePublisher.wakes.map((wake) => wake.seq)).toEqual(['1', '2', '3']);

      const { events, cursor, drained } = await messageStore.logRead(alice.did);
      expect(events.map((entry) => entry.seq)).toEqual(['1', '2', '3']);
      expect(events.map((entry) => entry.messageCid)).toEqual(storedCids);
      expect(cursor!.position).toBe('3');
      expect(drained).toBe(true);
    });

    it('should assign gap-free monotonic positions for concurrent puts', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const writes = await Promise.all(
        Array.from({ length: 12 }, async () => generateStoredMessage())
      );

      const results = await Promise.all(
        writes.map(async ({ message, indexes }) => messageStore.put(alice.did, message, indexes))
      );
      const positions = results
        .map((result) => Number(result.position!.position))
        .sort((a, b) => a - b);

      expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      const { events, cursor, drained } = await messageStore.logRead(alice.did);
      expect(events).toHaveLength(12);
      expect(cursor!.position).toBe('12');
      expect(drained).toBe(true);
    });

    it('should let a second store read a gap-free stream while writes are in flight', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const readerStore = new MessageStoreSql(dialect);
      await readerStore.open();

      try {
        const writes = await Promise.all(
          Array.from({ length: 12 }, async () => generateStoredMessage())
        );
        let writesSettled = false;
        let cursor: Awaited<ReturnType<MessageStoreSql['logRead']>>['cursor'];
        const observedPositions: string[] = [];
        let drained = false;

        const writerPromise = Promise.all(
          writes.map(async ({ message, indexes }, index) => {
            await delay(index % 4);
            return messageStore.put(alice.did, message, indexes);
          })
        ).finally(() => {
          writesSettled = true;
        });

        const readNextPage = async (): Promise<void> => {
          const page = await readerStore.logRead(alice.did, { cursor, limit: 3 });
          observedPositions.push(...page.events.map((entry) => entry.position ?? entry.seq));
          cursor = page.cursor;
          drained = page.drained;
        };

        for (let attempt = 0; attempt < 200 && !writesSettled; attempt++) {
          await readNextPage();
          await delay(1);
        }

        const results = await writerPromise;
        const expectedPositions = results
          .map((result) => result.position!.position)
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        const finalPosition = expectedPositions.at(-1)!;

        for (let attempt = 0; attempt < 200; attempt++) {
          await readNextPage();
          if (drained && cursor!.position === finalPosition) {
            break;
          }
          await delay(1);
        }

        expect(results.map((result) => result.status)).toEqual(Array(12).fill('inserted'));
        expect(observedPositions).toEqual(expectedPositions);
        expect(cursor!.position).toBe(finalPosition);
        expect(drained).toBe(true);
      } finally {
        await readerStore.close();
      }
    });

    it('should treat duplicate puts as non-mutating', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message, indexes } = await generateStoredMessage();

      const first = await messageStore.put(alice.did, message, indexes);
      const second = await messageStore.put(alice.did, message, indexes);

      expect(first.status).toBe('inserted');
      expect(second.status).toBe('duplicate');
      expect(second.position).toBeUndefined();
      expect(wakePublisher.wakes.map((wake) => wake.seq)).toEqual(['1']);

      const third = await generateStoredMessage();
      const thirdPut = await messageStore.put(alice.did, third.message, third.indexes);
      expect(thirdPut.position!.position).toBe('2');
    });

    it('should surface replication position collisions instead of treating them as duplicate puts', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const first = await generateStoredMessage();
      const second = await generateStoredMessage();

      await messageStore.put(alice.did, first.message, first.indexes);
      await db
        .updateTable('replicationCounters')
        .set({ seq: '0' })
        .where('tenant', '=', alice.did)
        .execute();

      await expect(messageStore.put(alice.did, second.message, second.indexes)).rejects.toThrow();

      const rows = await db
        .selectFrom('messageStoreMessages')
        .select(['messageCid', 'seq'])
        .where('tenant', '=', alice.did)
        .execute();

      expect(rows.map((row) => ({ messageCid: row.messageCid, seq: String(row.seq) })))
        .toEqual([{ messageCid: first.messageCid, seq: '1' }]);
    });

    it('should preserve replication positions beyond Number.MAX_SAFE_INTEGER', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const highBase = 9_007_199_254_740_992n;
      const expectedPutPosition = highBase + 1n;

      await db
        .insertInto('replicationCounters')
        .values({ tenant: alice.did, seq: highBase.toString() })
        .execute();

      const stored = await generateStoredMessage();
      const put = await messageStore.put(alice.did, stored.message, stored.indexes);
      expect(put.position!.position).toBe(expectedPutPosition.toString());

      const { events, cursor, drained } = await messageStore.logRead(alice.did);
      expect(events.map((entry) => entry.position)).toEqual([
        expectedPutPosition.toString(),
      ]);
      expect(events.map((entry) => entry.seq)).toEqual([
        expectedPutPosition.toString(),
      ]);
      expect(cursor!.position).toBe(expectedPutPosition.toString());
      expect(drained).toBe(true);

      // logBounds reads the head via the cast getHead path — assert it also round-trips beyond 2^53.
      const bounds = await messageStore.logBounds(alice.did);
      expect(bounds!.oldest.position).toBe('0');
      expect(bounds!.latest.position).toBe(expectedPutPosition.toString());
    });

    it('should page with high-water cursors and preserve zero-limit cursor semantics', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/photos';

      const matching = await generateStoredMessage({ protocol });
      const matchingPut = await messageStore.put(alice.did, matching.message, matching.indexes);
      const other = await generateStoredMessage();
      const otherPut = await messageStore.put(alice.did, other.message, other.indexes);
      const tail = await generateStoredMessage();
      await messageStore.put(alice.did, tail.message, tail.indexes);

      const filtered = await messageStore.logRead(alice.did, { filters: [{ protocol }] });
      expect(filtered.events.map((entry) => entry.messageCid)).toEqual([matching.messageCid]);
      expect(filtered.drained).toBe(true);
      expect(filtered.cursor!.position).toBe('3');
      expect(filtered.cursor!.messageCid).toBeUndefined();

      const firstPage = await messageStore.logRead(alice.did, { limit: 2 });
      expect(firstPage.drained).toBe(false);
      expect(firstPage.cursor!.position).toBe('2');

      const secondPage = await messageStore.logRead(alice.did, { cursor: firstPage.cursor });
      expect(secondPage.events.map((entry) => entry.messageCid)).toEqual([tail.messageCid]);
      expect(secondPage.drained).toBe(true);
      expect(secondPage.cursor!.position).toBe('3');

      expect((await messageStore.logRead(alice.did, { limit: 0 })).drained).toBe(false);
      expect(await messageStore.logRead(alice.did, { cursor: matchingPut.position, limit: 0 }))
        .toMatchObject({ events: [], cursor: matchingPut.position, drained: false });
      expect(await messageStore.logRead(alice.did, { cursor: otherPut.position, limit: 0 }))
        .toMatchObject({ events: [], cursor: otherPut.position, drained: false });
    });

    it('should reject invalid cursors and resume from deleted cursor positions', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const first = await generateStoredMessage();
      const second = await generateStoredMessage();
      const firstPut = await messageStore.put(alice.did, first.message, first.indexes);
      await messageStore.put(alice.did, second.message, second.indexes);

      await expect(messageStore.logRead(alice.did, { cursor: { ...firstPut.position!, streamId: 'wrong-stream' } }))
        .rejects.toThrow('stream_mismatch');
      await expect(messageStore.logRead(alice.did, { cursor: { ...firstPut.position!, position: '3' } }))
        .rejects.toThrow('token_too_new');
      await expect(messageStore.logRead(alice.did, { cursor: { ...firstPut.position!, messageCid: 'bafy-wrong-message' } }))
        .rejects.toThrow('message_mismatch');

      await messageStore.delete(alice.did, first.messageCid);
      const resumed = await messageStore.logRead(alice.did, { cursor: firstPut.position });
      expect(resumed.events.map((entry) => entry.messageCid)).toEqual([second.messageCid]);
      expect(resumed.drained).toBe(true);

      const staleCursor = firstPut.position!;
      await messageStore.clear();
      await expect(messageStore.logRead(alice.did, { cursor: staleCursor }))
        .rejects.toThrow('epoch_mismatch');
    });

    it('should replace indexes in place without moving rows or mutating fingerprint scopes', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/photos';
      const first = await generateStoredMessage({ protocol });
      const second = await generateStoredMessage();

      await messageStore.put(alice.did, { ...first.message, encodedData: 'c29tZSBkYXRh' }, first.indexes);
      await messageStore.put(alice.did, second.message, second.indexes);
      const wakeCountBefore = wakePublisher.wakes.length;

      await messageStore.updateIndexes(alice.did, first.messageCid, { ...first.indexes, isLatestBaseState: false });

      const { events } = await messageStore.logRead(alice.did);
      expect(events.map((entry) => entry.seq)).toEqual(['1', '2']);
      expect(events[0].indexes.isLatestBaseState).toBe(false);
      expect((await messageStore.get(alice.did, first.messageCid))!.encodedData).toBe('c29tZSBkYXRh');
      expect(wakePublisher.wakes.length).toBe(wakeCountBefore);
      expect((await messageStore.logBounds(alice.did))!.latest.position).toBe('2');

      await expect(messageStore.updateIndexes(alice.did, first.messageCid, { ...first.indexes, protocol: 'https://example.com/other' }))
        .rejects.toThrow(DwnErrorCode.MessageStoreFingerprintScopeMutation);
    });

    it('should fold protocol configs and tombstones into protocol fingerprints and persist across reopen', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const photosProtocol = 'https://example.com/photos-fingerprint';
      const protocolDefinition = {
        protocol  : photosProtocol,
        published : false,
        types     : { post: { schema: 'post', dataFormats: ['text/plain'] } },
        structure : { post: {} },
      };
      const initialEpoch = await messageStore.epoch();

      const config = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const configIndexes = constructProtocolConfigureIndexes(config.message, alice.did, true);
      await messageStore.put(alice.did, config.message, configIndexes);
      const configFingerprint = await cidFingerprint(await Message.getCid(config.message));

      expect(await messageStore.fingerprint(alice.did, [Replication.protocolDomain(photosProtocol)])).toBe(configFingerprint);

      const photo = await generateStoredMessage({ protocol: photosProtocol });
      await messageStore.put(alice.did, photo.message, photo.indexes);
      const photoFingerprint = await cidFingerprint(photo.messageCid);

      const recordsDelete = await TestDataGenerator.generateRecordsDelete({
        author   : alice,
        recordId : photo.message.recordId,
      });
      const deleteIndexes = recordsDelete.recordsDelete.constructIndexes(photo.message, photo.message);
      await messageStore.put(alice.did, recordsDelete.message, deleteIndexes);
      const recordsDeleteCid = await Message.getCid(recordsDelete.message);
      const deleteFingerprint = await cidFingerprint(recordsDeleteCid);

      const expectedProtocolFingerprint = xorHex(xorHex(configFingerprint, photoFingerprint), deleteFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.protocolDomain(photosProtocol)]))
        .toBe(expectedProtocolFingerprint);

      const boundsBefore = await messageStore.logBounds(alice.did);
      const logBefore = await messageStore.logRead(alice.did);
      const globalFingerprintBefore = await messageStore.fingerprint(alice.did, [Replication.globalDomain]);

      await messageStore.close();
      await messageStore.open();

      expect(await messageStore.epoch()).toBe(initialEpoch);
      expect(await messageStore.logBounds(alice.did)).toEqual(boundsBefore);
      expect((await messageStore.logRead(alice.did)).events.map((entry) => entry.messageCid))
        .toEqual(logBefore.events.map((entry) => entry.messageCid));
      expect(await messageStore.fingerprint(alice.did, [Replication.globalDomain])).toBe(globalFingerprintBefore);
      expect(await messageStore.fingerprint(alice.did, [Replication.protocolDomain(photosProtocol)]))
        .toBe(expectedProtocolFingerprint);

      await messageStore.delete(alice.did, recordsDeleteCid);
      expect(await messageStore.fingerprint(alice.did, [Replication.protocolDomain(photosProtocol)]))
        .toBe(xorHex(configFingerprint, photoFingerprint));
      await messageStore.clear();
      expect(await messageStore.epoch()).not.toBe(initialEpoch);
      expect(await messageStore.fingerprint(alice.did, [Replication.globalDomain])).toBe(ZERO_FINGERPRINT);
    });

    it('should fold encryption control records into capability domains and SQL indexes', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/encrypted-chat-sql';
      const rolePath = 'chat/member';
      const contextId = 'chatRootRecordId';
      const keyId = 'a'.repeat(43);
      const roleAudienceHash = await Replication.roleAudienceHash({ contextId, protocol, rolePath });
      const recipientHash = await Replication.recipientHash(bob.did);

      const audience = await generateStoredMessage({
        protocol,
        protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        tags         : { protocol, rolePath, contextId, keyId },
      });
      await messageStore.put(alice.did, audience.message, audience.indexes);
      const audienceFingerprint = await cidFingerprint(audience.messageCid);

      const delivery = await generateStoredMessage({
        protocol,
        protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
        recipient    : bob.did,
        tags         : {
          protocol,
          rolePath,
          contextId,
          keyId,
          recipientAuthority: 'roleHolder',
        },
      });
      await messageStore.put(alice.did, delivery.message, delivery.indexes);
      const deliveryFingerprint = await cidFingerprint(delivery.messageCid);

      expect(await messageStore.fingerprint(alice.did, [Replication.globalDomain])).toBe(xorHex(audienceFingerprint, deliveryFingerprint));
      expect(await messageStore.fingerprint(alice.did, [Replication.protocolDomain(protocol)])).toBe(ZERO_FINGERPRINT);
      expect(await messageStore.fingerprint(alice.did, [Replication.audienceControlDomain(protocol)])).toBe(audienceFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.audienceControlRoleDomain(protocol, roleAudienceHash)]))
        .toBe(audienceFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.deliveryControlDomain(protocol)]))
        .toBe(deliveryFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.deliveryControlRoleDomain(protocol, roleAudienceHash)]))
        .toBe(deliveryFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.deliveryControlRecipientDomain(protocol, recipientHash)]))
        .toBe(deliveryFingerprint);

      const audienceQuery = await messageStore.query(alice.did, [{ protocol, [Replication.controlClassIndex]: 'audience' }]);
      expect(audienceQuery.messages.map((message) => (message.descriptor as { protocolPath?: string }).protocolPath))
        .toEqual([ENCRYPTION_CONTROL_AUDIENCE_PATH]);

      const deliveryQuery = await messageStore.query(alice.did, [{
        protocol,
        [Replication.controlClassIndex]     : 'delivery',
        [Replication.recipientHashIndex]    : recipientHash,
        [Replication.roleAudienceHashIndex] : roleAudienceHash,
      }]);
      expect(deliveryQuery.messages.map((message) => (message.descriptor as { protocolPath?: string }).protocolPath))
        .toEqual([ENCRYPTION_CONTROL_DELIVERY_PATH]);
    });
  });
}

describe('MessageStoreSql replication log', () => {
  for (const dialect of [testMysqlDialect, testPostgresDialect, testSqliteDialect]) {
    runReplicationLogTests(dialect);
  }

  it('should fail fast when pre-substrate rows exist without replication metadata', async () => {
    const sharedDb = createBunSqliteDatabase(':memory:', { create: true });
    const dialect = new SqliteDialect({
      database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> => sharedDb,
    });
    const db = new Kysely<DwnDatabaseType>({ dialect });
    await runDwnStoreMigrations(db, dialect);

    const { message } = await generateStoredMessage();
    const encodedMessageBlock = new TextEncoder().encode(JSON.stringify(message));
    await db
      .insertInto('messageStoreMessages')
      .values({
        tenant              : 'did:example:alice',
        messageCid          : await Message.getCid(message),
        encodedMessageBytes : encodedMessageBlock,
      })
      .execute();

    const messageStore = new MessageStoreSql(dialect);
    await expect(messageStore.open()).rejects.toThrow(DwnErrorCode.MessageStorePreSubstrateLayout);

    await db.destroy();
    sharedDb.close();
  });
});
