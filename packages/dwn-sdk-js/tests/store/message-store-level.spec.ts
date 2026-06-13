import type { KeyValues } from '../../src/types/query-types.js';
import type { Wake } from '../../src/index.js';
import type { CreateLevelDatabaseOptions, LevelDatabase } from '../../src/store/level-wrapper.js';

import { createLevelDatabase } from '../../src/store/level-wrapper.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { EventEmitterWakePublisher } from '../../src/event-stream/event-emitter-wake-publisher.js';
import { Message } from '../../src/core/message.js';
import { MessageStoreLevel } from '../../src/store/message-store-level.js';
import { PermissionsProtocol } from '../../src/protocols/permissions.js';
import { Replication } from '../../src/utils/replication.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

const ZERO_FINGERPRINT = '0'.repeat(64);

async function cidFingerprint(messageCid: string): Promise<string> {
  return Replication.fingerprintToHex(await Replication.hashMessageCid(messageCid));
}

function xorHex(a: string, b: string): string {
  return Replication.fingerprintToHex(
    Replication.xorFingerprint(Replication.hexToFingerprint(a), Replication.hexToFingerprint(b))
  );
}

let messageStore: MessageStoreLevel;
let wakePublisher: EventEmitterWakePublisher;
let wakes: Wake[];

describe('MessageStoreLevel Test Suite', () => {
  // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
  // so that different test suites can reuse the same backend store for testing
  beforeAll(async () => {
    wakePublisher = new EventEmitterWakePublisher();
    messageStore = new MessageStoreLevel({
      location: 'TEST-MESSAGESTORE',
      wakePublisher,
    });
    await messageStore.open();
  });

  beforeEach(async () => {
    await messageStore.clear(); // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
    wakes = [];
    wakePublisher.clear();
    wakePublisher.subscribe((wake) => { wakes.push(wake); });
  });

  afterAll(async () => {
    await messageStore.close();
  });

  describe('createLevelDatabase', function () {
    it('should be called if provided', async () => {
      // need to close the message store instance first before creating a new one with the same name below
      await messageStore.close();

      const locations = new Set;

      messageStore = new MessageStoreLevel({
        location: 'TEST-MESSAGESTORE',
        wakePublisher,
        createLevelDatabase<V>(location: string, options?: CreateLevelDatabaseOptions<V>): Promise<LevelDatabase<V>> {
          locations.add(location);
          return createLevelDatabase(location, options);
        }
      });
      await messageStore.open();

      expect(locations).toEqual(new Set([ 'TEST-MESSAGESTORE' ]));
    });
  });

  async function generateStoredMessage(overrides: { protocol?: string } = {}): Promise<{ message: any, messageCid: string, indexes: KeyValues }> {
    const { message } = await TestDataGenerator.generateRecordsWrite(overrides.protocol === undefined
      ? {}
      : { protocol: overrides.protocol, protocolPath: 'post' });
    const messageCid = await Message.getCid(message);
    const indexes: KeyValues = {
      interface         : 'Records',
      method            : 'Write',
      messageTimestamp  : message.descriptor.messageTimestamp,
      isLatestBaseState : true,
      ...(overrides.protocol !== undefined && { protocol: overrides.protocol }),
    };

    return { message, messageCid, indexes };
  }

  describe('replication log', () => {
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

      expect(wakes.map((wake) => wake.seq)).toEqual(['1', '2', '3']);

      const { events, cursor, drained } = await messageStore.logRead(alice.did);
      expect(events.map((entry) => entry.seq)).toEqual(['1', '2', '3']);
      expect(events.map((entry) => entry.messageCid)).toEqual(storedCids);
      expect(cursor!.position).toBe('3');
      expect(drained).toBe(true);
    });

    it('should treat duplicate puts as non-mutating', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message, indexes } = await generateStoredMessage();

      const first = await messageStore.put(alice.did, message, indexes);
      const second = await messageStore.put(alice.did, message, indexes);

      expect(first.status).toBe('inserted');
      expect(second.status).toBe('duplicate');
      expect(second.position).toBeUndefined();
      expect(wakes.map((wake) => wake.seq)).toEqual(['1']);

      const third = await generateStoredMessage();
      const thirdPut = await messageStore.put(alice.did, third.message, third.indexes);
      expect(thirdPut.position!.position).toBe('2');
    });

    it('should page with high-water cursors and omit messageCid for non-delivered tail positions', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/photos';

      const matching = await generateStoredMessage({ protocol });
      await messageStore.put(alice.did, matching.message, matching.indexes);
      for (let i = 0; i < 2; i++) {
        const other = await generateStoredMessage();
        await messageStore.put(alice.did, other.message, other.indexes);
      }

      const filtered = await messageStore.logRead(alice.did, { filters: [{ protocol }] });
      expect(filtered.events.map((entry) => entry.messageCid)).toEqual([matching.messageCid]);
      expect(filtered.drained).toBe(true);
      expect(filtered.cursor!.position).toBe('3');
      expect(filtered.cursor!.messageCid).toBeUndefined();

      const firstPage = await messageStore.logRead(alice.did, { limit: 2 });
      expect(firstPage.drained).toBe(false);
      expect(firstPage.cursor!.position).toBe('2');

      const secondPage = await messageStore.logRead(alice.did, { cursor: firstPage.cursor });
      expect(secondPage.drained).toBe(true);
      expect(secondPage.cursor!.position).toBe('3');
    });

    it('should not advance the log cursor when limit is zero', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const first = await generateStoredMessage();
      const second = await generateStoredMessage();

      const firstPut = await messageStore.put(alice.did, first.message, first.indexes);
      await messageStore.put(alice.did, second.message, second.indexes);

      const withoutCursor = await messageStore.logRead(alice.did, { limit: 0 });
      expect(withoutCursor.events).toEqual([]);
      expect(withoutCursor.cursor).toBeUndefined();
      expect(withoutCursor.drained).toBe(false);

      const withCursor = await messageStore.logRead(alice.did, { cursor: firstPut.position, limit: 0 });
      expect(withCursor.events).toEqual([]);
      expect(withCursor.cursor).toBe(firstPut.position);
      expect(withCursor.drained).toBe(false);
    });

    it('should reject cursors from the wrong stream or epoch', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message, indexes } = await generateStoredMessage();
      const putResult = await messageStore.put(alice.did, message, indexes);
      const cursor = putResult.position!;

      await expect(messageStore.logRead(alice.did, { cursor: { ...cursor, streamId: 'wrong-stream' } }))
        .rejects.toThrow('stream_mismatch');

      await messageStore.clear();
      await expect(messageStore.logRead(alice.did, { cursor }))
        .rejects.toThrow('epoch_mismatch');
    });
  });

  describe('updateIndexes', () => {
    it('should replace indexes in place without moving the row, stamping, or stripping inline data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const first = await generateStoredMessage();
      const second = await generateStoredMessage();

      await messageStore.put(alice.did, { ...first.message, encodedData: 'c29tZSBkYXRh' }, first.indexes);
      await messageStore.put(alice.did, second.message, second.indexes);
      const wakeCountBefore = wakes.length;

      await messageStore.updateIndexes(alice.did, first.messageCid, { ...first.indexes, isLatestBaseState: false });

      const { events } = await messageStore.logRead(alice.did);
      expect(events.map((entry) => entry.seq)).toEqual(['1', '2']);
      expect(events[0].indexes.isLatestBaseState).toBe(false);
      expect((await messageStore.get(alice.did, first.messageCid))!.encodedData).toBe('c29tZSBkYXRh');
      expect(wakes.length).toBe(wakeCountBefore);
      expect((await messageStore.logBounds(alice.did))!.latest.position).toBe('2');
    });

    it('should reject missing messages and fingerprint-scope mutations', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/photos';
      const { message, messageCid, indexes } = await generateStoredMessage({ protocol });

      await expect(messageStore.updateIndexes(alice.did, messageCid, indexes))
        .rejects.toThrow(DwnErrorCode.MessageStoreUpdateIndexesMessageNotFound);

      await messageStore.put(alice.did, message, indexes);
      await expect(messageStore.updateIndexes(alice.did, messageCid, { ...indexes, protocol: 'https://example.com/other' }))
        .rejects.toThrow(DwnErrorCode.MessageStoreFingerprintScopeMutation);

      const { protocol: _protocol, ...indexesWithoutProtocol } = indexes;
      await expect(messageStore.updateIndexes(alice.did, messageCid, indexesWithoutProtocol))
        .rejects.toThrow(DwnErrorCode.MessageStoreFingerprintScopeMutation);

      const grant = await generateStoredMessage();
      const grantIndexes: KeyValues = {
        interface         : 'Records',
        method            : 'Write',
        messageTimestamp  : grant.message.descriptor.messageTimestamp,
        isLatestBaseState : true,
        protocol          : PermissionsProtocol.uri,
        'tag.protocol'    : protocol,
      };
      await messageStore.put(alice.did, grant.message, grantIndexes);
      await expect(messageStore.updateIndexes(alice.did, grant.messageCid, { ...grantIndexes, 'tag.protocol': 'https://example.com/other' }))
        .rejects.toThrow(DwnErrorCode.MessageStoreFingerprintScopeMutation);
    });
  });

  describe('updateMessageAndIndexes', () => {
    it('should replace the stored payload and indexes without moving the row or stamping', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const first = await generateStoredMessage();
      const second = await generateStoredMessage();

      await messageStore.put(alice.did, { ...first.message, encodedData: 'c29tZSBkYXRh' }, first.indexes);
      await messageStore.put(alice.did, second.message, second.indexes);
      const wakeCountBefore = wakes.length;

      await messageStore.updateMessageAndIndexes(alice.did, first.messageCid, first.message, { ...first.indexes, isLatestBaseState: false });

      const { events } = await messageStore.logRead(alice.did);
      expect(events.map((entry) => entry.seq)).toEqual(['1', '2']);
      expect(events[0].indexes.isLatestBaseState).toBe(false);
      expect((await messageStore.get(alice.did, first.messageCid))!.encodedData).toBeUndefined();
      expect(wakes.length).toBe(wakeCountBefore);
      expect((await messageStore.logBounds(alice.did))!.latest.position).toBe('2');
    });

    it('should reject missing messages, CID mismatches, and fingerprint-scope mutations', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/photos';
      const { message, messageCid, indexes } = await generateStoredMessage({ protocol });
      const other = await generateStoredMessage({ protocol });

      await expect(messageStore.updateMessageAndIndexes(alice.did, messageCid, message, indexes))
        .rejects.toThrow(DwnErrorCode.MessageStoreUpdateMessageAndIndexesMessageNotFound);

      await messageStore.put(alice.did, message, indexes);
      await expect(messageStore.updateMessageAndIndexes(alice.did, messageCid, other.message, indexes))
        .rejects.toThrow(DwnErrorCode.MessageStoreUpdateMessageAndIndexesCidMismatch);

      await expect(messageStore.updateMessageAndIndexes(alice.did, messageCid, message, { ...indexes, protocol: 'https://example.com/other' }))
        .rejects.toThrow(DwnErrorCode.MessageStoreFingerprintScopeMutation);
    });
  });

  describe('completeData', () => {
    it('should update the existing row and redeliver it at a later position exactly once', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const stub = await generateStoredMessage();
      const other = await generateStoredMessage();

      await messageStore.put(alice.did, stub.message, { ...stub.indexes, isLatestBaseState: false });
      await messageStore.put(alice.did, other.message, other.indexes);

      const result = await messageStore.completeData(alice.did, stub.messageCid, stub.indexes, 'aGVsbG8');
      expect(result.position!.position).toBe('3');
      expect(result.position!.messageCid).toBe(stub.messageCid);
      expect(wakes.map((wake) => wake.seq)).toEqual(['1', '2', '3']);

      const storedMessage = await messageStore.get(alice.did, stub.messageCid);
      expect(storedMessage!.encodedData).toBe('aGVsbG8');

      const { events, cursor, drained } = await messageStore.logRead(alice.did);
      expect(events.map((entry) => entry.messageCid)).toEqual([stub.messageCid, other.messageCid, stub.messageCid]);
      expect(events.filter((entry) => entry.messageCid === stub.messageCid).map((entry) => entry.seq)).toEqual(['1', '1']);
      expect(cursor!.position).toBe('3');
      expect(drained).toBe(true);

      await expect(messageStore.completeData(alice.did, stub.messageCid, stub.indexes, 'aGVsbG8'))
        .rejects.toThrow(DwnErrorCode.MessageStoreCompleteDataAlreadyStamped);
    });

    it('should reject missing messages', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { messageCid, indexes } = await generateStoredMessage();

      await expect(messageStore.completeData(alice.did, messageCid, indexes))
        .rejects.toThrow(DwnErrorCode.MessageStoreCompleteDataMessageNotFound);
    });
  });

  describe('fingerprints', () => {
    it('should fold global, protocol, and permission domains and unfold deletes', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const photosProtocol = 'https://example.com/photos';

      const photo = await generateStoredMessage({ protocol: photosProtocol });
      await messageStore.put(alice.did, photo.message, photo.indexes);
      const photoFingerprint = await cidFingerprint(photo.messageCid);

      const grant = await generateStoredMessage();
      const grantIndexes: KeyValues = {
        interface         : 'Records',
        method            : 'Write',
        messageTimestamp  : grant.message.descriptor.messageTimestamp,
        isLatestBaseState : true,
        protocol          : PermissionsProtocol.uri,
        'tag.protocol'    : photosProtocol,
      };
      await messageStore.put(alice.did, grant.message, grantIndexes);
      const grantFingerprint = await cidFingerprint(grant.messageCid);

      expect(await messageStore.fingerprint(alice.did, [Replication.globalDomain])).toBe(xorHex(photoFingerprint, grantFingerprint));
      expect(await messageStore.fingerprint(alice.did, [Replication.protocolDomain(photosProtocol)])).toBe(photoFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.protocolDomain(PermissionsProtocol.uri)])).toBe(grantFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.permissionDomain(photosProtocol)])).toBe(grantFingerprint);

      const { 'tag.protocol': _tag, ...demotedGrantIndexes } = grantIndexes;
      await messageStore.updateIndexes(alice.did, grant.messageCid, { ...demotedGrantIndexes, isLatestBaseState: false });
      expect(await messageStore.fingerprint(alice.did, [Replication.permissionDomain(photosProtocol)])).toBe(grantFingerprint);

      await messageStore.delete(alice.did, grant.messageCid);
      expect(await messageStore.fingerprint(alice.did, [Replication.globalDomain])).toBe(photoFingerprint);
      expect(await messageStore.fingerprint(alice.did, [Replication.permissionDomain(photosProtocol)])).toBe(ZERO_FINGERPRINT);
    });
  });

  describe('epoch', () => {
    it('should persist across reopen and reset on clear', async () => {
      const initialEpoch = await messageStore.epoch();

      await messageStore.close();
      await messageStore.open();
      expect(await messageStore.epoch()).toBe(initialEpoch);

      await messageStore.clear();
      expect(await messageStore.epoch()).not.toBe(initialEpoch);
    });
  });
});
