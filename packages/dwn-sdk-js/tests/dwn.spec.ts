import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../src/types/subscriptions.js';
import type { Persona } from './utils/test-data-generator.js';
import type { ActiveTenantCheckResult, TenantGate } from '../src/index.js';
import type { DataStore, MessageStore, ResumableTaskStore } from '../src/index.js';
import type { ProtocolDefinition, ReplicationApplyResult } from '../src/index.js';

import sinon from 'sinon';

import nestedProtocol from './vectors/protocol-definitions/nested.json' with { type: 'json' };

import { Dwn } from '../src/dwn.js';
import { TestEventLog } from './test-event-stream.js';
import { TestStores } from './test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '../src/store/level.js';
import {
  DataStream,
  DwnErrorCode,
  DwnMethodName,
  Jws,
  Message,
  RecordsDelete,
  RecordsRead,
  RecordsWrite,
  Time
} from '../src/index.js';
import { defaultTestProtocolDefinition, TestDataGenerator } from './utils/test-data-generator.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testDwnClass(): void {
  describe('DWN', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    // important to follow the `beforeAll` and `afterAll` pattern to initialize and clean the stores in tests
    // so that different test suites can reuse the same backend store for testing
    beforeAll(async () => {
      didResolver = new UniversalResolver({ didResolvers: [DidKey] });

      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      resumableTaskStore = stores.resumableTaskStore;

      eventLog = TestEventLog.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, resumableTaskStore });
    });

    beforeEach(async () => {
      sinon.restore(); // wipe all stubs/spies/mocks/fakes from previous test

      await messageStore.clear(); // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
    });

    afterAll(async () => {
      sinon.restore();
      await dwn.close();
    });

    describe('processMessage()', () => {
      it('should process RecordsWrite message signed by a `did:key` DID', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        const reply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(reply.status.code).toBe(202);
      });

      it('should process RecordsQuery message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateRecordsQuery({ author: alice });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(200);
      });

      it('should process RecordsDelete message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateRecordsDelete({ author: alice });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(404);
      });

      it('should process ProtocolsConfigure message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateProtocolsConfigure({ author: alice });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(202);
      });

      it('should process ProtocolsQuery message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateProtocolsQuery({ author: alice });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(200);
      });

      it('should return a 400 if message is invalid', async () => {
        const reply = await dwn.processMessage('did:example:alice', { } as any);
        expect(reply.status.code).toBe(400);
      });

      it('should return a 401 if tenant gate blocks the message', async () => {
        // tenant gate that blocks everyone
        const blockAllTenantGate: TenantGate = {
          async isActiveTenant(): Promise<ActiveTenantCheckResult> {
            return { isActiveTenant: false };
          }
        };

        const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
        const dataStoreStub = sinon.createStubInstance(DataStoreLevel);
        const resumableTaskStoreStub = sinon.createStubInstance(ResumableTaskStoreLevel);
        const dwnWithConfig = await Dwn.create({
          tenantGate         : blockAllTenantGate,
          messageStore       : messageStoreStub,
          dataStore          : dataStoreStub,
          resumableTaskStore : resumableTaskStoreStub,
        });

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { author, message } = await TestDataGenerator.generateRecordsQuery({ author: alice });

        const tenant = author!.did;
        const reply = await dwnWithConfig.processMessage(tenant, message);

        expect(reply.status.code).toBe(401);
        expect(reply.status.detail).toContain('not an active tenant');
      });

      it('should throw 401 with custom message from tenant gate if provided', async () => {
        // tenant gate that blocks everyone with a custom message
        const customMessage = 'a custom not-an-active-tenant message';
        const blockAllTenantGate: TenantGate = {
          async isActiveTenant(): Promise<ActiveTenantCheckResult> {
            return { isActiveTenant: false, detail: customMessage };
          }
        };
        const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
        const dataStoreStub = sinon.createStubInstance(DataStoreLevel);
        const resumableTaskStoreStub = sinon.createStubInstance(ResumableTaskStoreLevel);
        const dwnWithConfig = await Dwn.create({
          tenantGate         : blockAllTenantGate,
          messageStore       : messageStoreStub,
          dataStore          : dataStoreStub,
          resumableTaskStore : resumableTaskStoreStub,
        });

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { author, message } = await TestDataGenerator.generateRecordsQuery({ author: alice });

        const tenant = author!.did;
        const reply = await dwnWithConfig.processMessage(tenant, message);

        expect(reply.status.code).toBe(401);
        expect(reply.status.detail).toBe(customMessage);
      });
    });

    describe('applyReplicatedMessage()', () => {
      it('returns Duplicate for an exact replay already in the message store', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        const initialReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(initialReply.status.code).toBe(202);

        const result = await dwn.applyReplicatedMessage(alice.did, message);

        expect(result).toEqual({ kind: 'Duplicate' });
      });

      it('returns resolved cross-protocol role dependencies for replicated role-authorized queries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const threadsProtocol: ProtocolDefinition = {
          protocol  : 'https://threads.example.com',
          published : true,
          types     : {
            participant : {},
            thread      : {},
          },
          structure: {
            thread: {
              participant: {
                $role: true,
              },
            },
          },
        };
        const commentsProtocol: ProtocolDefinition = {
          protocol  : 'https://comments.example.com',
          published : true,
          uses      : {
            threads: threadsProtocol.protocol,
          },
          types: {
            comment: {},
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {},
            },
          },
        };
        const threadsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : threadsProtocol,
        });
        expect((await dwn.processMessage(alice.did, threadsConfigure.message)).status.code).toBe(202);
        const commentsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : commentsProtocol,
        });
        expect((await dwn.processMessage(alice.did, commentsConfigure.message)).status.code).toBe(202);

        const query = await TestDataGenerator.generateRecordsQuery({
          author       : bob,
          protocolRole : 'threads:thread/participant',
          filter       : {
            contextId    : 'thread-context',
            protocol     : commentsProtocol.protocol,
            protocolPath : 'thread/comment',
          },
        });

        const result = await dwn.applyReplicatedMessage(alice.did, query.message);

        expect(result).toEqual({
          kind    : 'Incomplete',
          missing : [{
            type          : 'Role',
            contextPrefix : 'thread-context',
            protocol      : threadsProtocol.protocol,
            protocolPath  : 'thread/participant',
            recipient     : bob.did,
          }],
        });
      });

      it('classifies exact child replay as Duplicate before checking that the parent is still active', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const nestedProtocol: ProtocolDefinition = {
          protocol  : 'https://example.com/nested-duplicate',
          published : false,
          types     : {
            parent : {},
            child  : {},
          },
          structure: {
            parent: {
              child: {},
            },
          },
        };
        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : nestedProtocol,
        });
        expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

        const parent = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : nestedProtocol.protocol,
          protocolPath : 'parent',
        });
        expect((await dwn.processMessage(alice.did, parent.message, { dataStream: parent.dataStream })).status.code).toBe(202);

        const child = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : nestedProtocol.protocol,
          protocolPath    : 'parent/child',
          parentContextId : parent.message.contextId,
        });
        expect((await dwn.processMessage(alice.did, child.message, { dataStream: child.dataStream })).status.code).toBe(202);

        const parentDelete = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : parent.message.recordId,
        });
        expect((await dwn.processMessage(alice.did, parentDelete.message)).status.code).toBe(202);

        const result = await dwn.applyReplicatedMessage(alice.did, child.message);

        expect(result).toEqual({ kind: 'Duplicate' });
      });

      it('classifies a replicated write older than the squash floor as Superseded', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const squashProtocol: ProtocolDefinition = {
          protocol  : 'https://example.com/replicated-squash',
          published : true,
          types     : {
            document : {},
            patch    : {},
          },
          structure: {
            document: {
              patch: {
                $immutable : true,
                $squash    : true,
              },
            },
          },
        };
        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : squashProtocol,
        });
        expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

        const document = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : squashProtocol.protocol,
          protocolPath : 'document',
        });
        expect((await dwn.processMessage(alice.did, document.message, { dataStream: document.dataStream })).status.code).toBe(202);

        const squashTimestamp = Time.createOffsetTimestamp({ seconds: 10 });
        const squashRecord = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : squashProtocol.protocol,
          protocolPath     : 'document/patch',
          parentContextId  : document.message.contextId,
          dateCreated      : squashTimestamp,
          messageTimestamp : squashTimestamp,
          squash           : true,
        });
        expect((await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream })).status.code).toBe(202);

        // A replica replaying a pre-squash write is a normal multi-replica race: it must
        // converge as a no-op, never surface as a terminal failure.
        const olderTimestamp = Time.createOffsetTimestamp({ seconds: 5 });
        const olderPatch = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          protocol         : squashProtocol.protocol,
          protocolPath     : 'document/patch',
          parentContextId  : document.message.contextId,
          dateCreated      : olderTimestamp,
          messageTimestamp : olderTimestamp,
        });

        const result = await dwn.applyReplicatedMessage(alice.did, olderPatch.message, { dataStream: olderPatch.dataStream });

        expect(result).toEqual({ kind: 'Superseded' });
      });

      it('converges to the same deleted state when a write and an older tombstone apply in either order', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // one shared ProtocolsConfigure message, processed on BOTH replicas so their
        // state roots remain directly comparable
        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : defaultTestProtocolDefinition,
        });
        expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

        // initial write -> tombstone -> newer update, with strictly increasing timestamps
        const datePublished = '2025-01-05T00:00:00.000000Z';
        const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice });
        await Time.minimalSleep();
        const recordsDelete = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        await Time.minimalSleep();
        const updateDataBytes = TestDataGenerator.randomBytes(32);
        const update = await RecordsWrite.createFrom({
          recordsWriteMessage : initialWrite.message,
          data                : updateDataBytes,
          published           : true,
          datePublished,
          tags                : { team: 'blue' },
          signer              : Jws.createSigner(alice),
        });

        // replica A: initial write and the newer update land first, the older tombstone last
        expect(await dwn.applyReplicatedMessage(
          alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(await dwn.applyReplicatedMessage(
          alice.did, update.message, { dataStream: DataStream.fromBytes(updateDataBytes) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(await dwn.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));

        // replica B: the tombstone lands before the newer update
        const messageStoreB = new MessageStoreLevel({
          location: 'TEST-MESSAGESTORE-DELETEWINS',
        });
        const dataStoreB = new DataStoreLevel({ blockstoreLocation: 'TEST-DATASTORE-DELETEWINS' });
        const resumableTaskStoreB = new ResumableTaskStoreLevel({ location: 'TEST-RESUMABLE-TASK-STORE-DELETEWINS' });
        const dwnB = await Dwn.create({
          didResolver,
          messageStore       : messageStoreB,
          dataStore          : dataStoreB,
          resumableTaskStore : resumableTaskStoreB,
        });

        try {
          await messageStoreB.clear();
          await dataStoreB.clear();
          await resumableTaskStoreB.clear();

          expect((await dwnB.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);
          expect(await dwnB.applyReplicatedMessage(
            alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
          )).toEqual(expect.objectContaining({ kind: 'Applied' }));
          expect(await dwnB.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));
          expect(await dwnB.applyReplicatedMessage(
            alice.did, update.message, { dataStream: DataStream.fromBytes(updateDataBytes) },
          )).toEqual({ kind: 'Superseded' });

          // both replicas read the record as deleted and retain the update-derived tombstone visibility
          const readA = await RecordsRead.create({
            signer : Jws.createSigner(alice),
            filter : { recordId: initialWrite.message.recordId },
          });
          expect((await dwn.processMessage(alice.did, readA.message)).status.code).toBe(404);
          const readB = await RecordsRead.create({
            signer : Jws.createSigner(alice),
            filter : { recordId: initialWrite.message.recordId },
          });
          expect((await dwnB.processMessage(alice.did, readB.message)).status.code).toBe(404);

          const tombstoneFilter = {
            'method'        : 'Delete',
            'tag.team'      : 'blue',
            'published'     : true,
            'datePublished' : datePublished,
          };
          const { messages: tombstonesA } = await messageStore.query(alice.did, [tombstoneFilter]);
          const { messages: tombstonesB } = await messageStoreB.query(alice.did, [tombstoneFilter]);
          expect(tombstonesA).toHaveLength(1);
          expect(tombstonesB).toHaveLength(1);
          expect(await Message.getCid(tombstonesA[0])).toBe(await Message.getCid(recordsDelete.message));
          expect(await Message.getCid(tombstonesB[0])).toBe(await Message.getCid(recordsDelete.message));
        } finally {
          await dwnB.close();
        }
      });

      it('rejects a tombstone-beaten replicated write when its data does not match its descriptor', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : defaultTestProtocolDefinition,
        });
        expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

        const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice });
        expect(await dwn.applyReplicatedMessage(
          alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));

        const recordsDelete = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        expect(await dwn.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));

        await Time.minimalSleep();
        const updateDataBytes = TestDataGenerator.randomBytes(32);
        const update = await RecordsWrite.createFrom({
          recordsWriteMessage : initialWrite.message,
          data                : updateDataBytes,
          tags                : { team: 'blue' },
          signer              : Jws.createSigner(alice),
        });
        const malformedDataBytes = TestDataGenerator.randomBytes(32);

        const result = await dwn.applyReplicatedMessage(
          alice.did, update.message, { dataStream: DataStream.fromBytes(malformedDataBytes) },
        );

        expect(result.kind).toBe('Invalid');
        expect((result as { reason: string }).reason).toContain(DwnErrorCode.RecordsWriteDataCidMismatch);

        const updateCid = await Message.getCid(update.message);
        const { messages } = await messageStore.query(alice.did, [{ recordId: initialWrite.message.recordId }]);
        const messageCids = await Promise.all(messages.map(message => Message.getCid(message)));
        expect(messageCids).not.toContain(updateCid);

        const { messages: reindexedTombstones } = await messageStore.query(alice.did, [{
          method     : DwnMethodName.Delete,
          'tag.team' : 'blue',
        }]);
        expect(reindexedTombstones).toHaveLength(0);
      });

      it('reports missing data for tombstone-beaten replicated writes without data', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const scenarios = [
          { dataBytes: TestDataGenerator.randomBytes(32), storage: 'inline' },
          { dataBytes: TestDataGenerator.randomBytes(31_000), storage: 'data-store' },
        ];

        for (const { dataBytes, storage } of scenarios) {
          const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, data: dataBytes });
          expect(await dwn.applyReplicatedMessage(
            alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(dataBytes) },
          )).toEqual(expect.objectContaining({ kind: 'Applied' }));

          const recordsDelete = await RecordsDelete.create({
            recordId : initialWrite.message.recordId,
            signer   : Jws.createSigner(alice),
          });
          expect(await dwn.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));

          await Time.minimalSleep();
          const update = await RecordsWrite.createFrom({
            recordsWriteMessage : initialWrite.message,
            tags                : { storage },
            signer              : Jws.createSigner(alice),
          });

          const result = await dwn.applyReplicatedMessage(alice.did, update.message);
          expect(result).toEqual({
            kind    : 'Incomplete',
            missing : [{
              type     : 'RecordData',
              recordId : update.message.recordId,
              dataCid  : update.message.descriptor.dataCid,
              protocol : update.message.descriptor.protocol,
            }],
          });

          const updateCid = await Message.getCid(update.message);
          expect(await messageStore.get(alice.did, updateCid)).toBeUndefined();

          const { messages: reindexedTombstones } = await messageStore.query(alice.did, [{
            method        : DwnMethodName.Delete,
            'tag.storage' : storage,
          }]);
          expect(reindexedTombstones).toHaveLength(0);
        }
      });

      it('accepts a tombstone-beaten replicated write with a valid large data stream', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice });
        expect(await dwn.applyReplicatedMessage(
          alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));

        const recordsDelete = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        expect(await dwn.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));

        await Time.minimalSleep();
        const updateDataBytes = TestDataGenerator.randomBytes(31_000);
        const update = await RecordsWrite.createFrom({
          recordsWriteMessage : initialWrite.message,
          data                : updateDataBytes,
          tags                : { storage: 'data-store' },
          signer              : Jws.createSigner(alice),
        });

        expect(await dwn.applyReplicatedMessage(
          alice.did, update.message, { dataStream: DataStream.fromBytes(updateDataBytes) },
        )).toEqual({ kind: 'Superseded' });

        const updateCid = await Message.getCid(update.message);
        expect(await messageStore.get(alice.did, updateCid)).toBeDefined();

        const { messages: reindexedTombstones } = await messageStore.query(alice.did, [{
          method        : DwnMethodName.Delete,
          'tag.storage' : 'data-store',
        }]);
        expect(reindexedTombstones).toHaveLength(1);
        expect(await Message.getCid(reindexedTombstones[0])).toBe(await Message.getCid(recordsDelete.message));
      });

      it('applies the handler stale-tombstone gate on resumable-task replay', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice });
        expect((await dwn.processMessage(alice.did, initialWrite.message, { dataStream: initialWrite.dataStream })).status.code).toBe(202);

        // generate the losing delete first so it is older than the tombstone admitted below
        const staleDelete = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        await Time.minimalSleep();
        const recordsDelete = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        expect((await dwn.processMessage(alice.did, recordsDelete.message)).status.code).toBe(202);

        // replaying the beaten delete through the task path must be a no-op — the same lattice
        // gate as admission — leaving the canonical tombstone as the record's newest message
        await dwn['storageController'].performRecordsDelete({ tenant: alice.did, message: staleDelete.message });

        const tombstoneCid = await Message.getCid(recordsDelete.message);
        const staleDeleteCid = await Message.getCid(staleDelete.message);
        expect(await messageStore.get(alice.did, tombstoneCid)).toBeDefined();
        expect(await messageStore.get(alice.did, staleDeleteCid)).toBeUndefined();
      });

      it('converges competing plain tombstones to one canonical winner in either order', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : defaultTestProtocolDefinition,
        });
        expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

        // two independently authored plain tombstones for the same record, d1 older than d2
        const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const d1 = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        await Time.minimalSleep();
        const d2 = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });

        // replica A: d1 lands first, then d2 displaces it
        expect(await dwn.applyReplicatedMessage(
          alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(await dwn.applyReplicatedMessage(alice.did, d1.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(await dwn.applyReplicatedMessage(alice.did, d2.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));

        // replica B: d2 lands first; the beaten d1 converges as a Superseded no-op
        const messageStoreB = new MessageStoreLevel({
          location: 'TEST-MESSAGESTORE-DELETEWINS',
        });
        const dataStoreB = new DataStoreLevel({ blockstoreLocation: 'TEST-DATASTORE-DELETEWINS' });
        const resumableTaskStoreB = new ResumableTaskStoreLevel({ location: 'TEST-RESUMABLE-TASK-STORE-DELETEWINS' });
        const dwnB = await Dwn.create({
          didResolver,
          messageStore       : messageStoreB,
          dataStore          : dataStoreB,
          resumableTaskStore : resumableTaskStoreB,
        });

        try {
          await messageStoreB.clear();
          await dataStoreB.clear();
          await resumableTaskStoreB.clear();

          expect((await dwnB.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);
          expect(await dwnB.applyReplicatedMessage(
            alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
          )).toEqual(expect.objectContaining({ kind: 'Applied' }));
          expect(await dwnB.applyReplicatedMessage(alice.did, d2.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));
          expect(await dwnB.applyReplicatedMessage(alice.did, d1.message)).toEqual({ kind: 'Superseded' });

          // both replicas hold d2 as the canonical tombstone
          const d1Cid = await Message.getCid(d1.message);
          const d2Cid = await Message.getCid(d2.message);
          expect(await messageStore.get(alice.did, d2Cid)).toBeDefined();
          expect(await messageStore.get(alice.did, d1Cid)).toBeUndefined();
          expect(await messageStoreB.get(alice.did, d2Cid)).toBeDefined();
          expect(await messageStoreB.get(alice.did, d1Cid)).toBeUndefined();
        } finally {
          await dwnB.close();
        }
      });

      it('a prune beats a newer plain delete in either order and purges descendants on both replicas', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const nestedProtocolDefinition = nestedProtocol as ProtocolDefinition;
        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : nestedProtocolDefinition,
        });
        expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

        // parent foo with child bar, then a prune of foo and a NEWER plain delete of foo
        const foo = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : nestedProtocolDefinition.protocol,
          protocolPath : 'foo',
          schema       : nestedProtocolDefinition.types.foo.schema,
          dataFormat   : nestedProtocolDefinition.types.foo.dataFormats![0],
        });
        const bar = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : nestedProtocolDefinition.protocol,
          protocolPath    : 'foo/bar',
          parentContextId : foo.message.contextId,
          schema          : nestedProtocolDefinition.types.bar.schema,
          dataFormat      : nestedProtocolDefinition.types.bar.dataFormats![0],
        });
        const prune = await RecordsDelete.create({
          recordId : foo.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(alice),
        });
        await Time.minimalSleep();
        const plainDelete = await RecordsDelete.create({
          recordId : foo.message.recordId,
          signer   : Jws.createSigner(alice),
        });

        // replica A: prune first, then the newer plain delete loses on class
        expect(await dwn.applyReplicatedMessage(
          alice.did, foo.message, { dataStream: DataStream.fromBytes(foo.dataBytes!) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(await dwn.applyReplicatedMessage(
          alice.did, bar.message, { dataStream: DataStream.fromBytes(bar.dataBytes!) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(await dwn.applyReplicatedMessage(alice.did, prune.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(await dwn.applyReplicatedMessage(alice.did, plainDelete.message)).toEqual({ kind: 'Superseded' });

        // replica B: the newer plain delete lands first; the prune still wins and cascades
        const messageStoreB = new MessageStoreLevel({
          location: 'TEST-MESSAGESTORE-DELETEWINS',
        });
        const dataStoreB = new DataStoreLevel({ blockstoreLocation: 'TEST-DATASTORE-DELETEWINS' });
        const resumableTaskStoreB = new ResumableTaskStoreLevel({ location: 'TEST-RESUMABLE-TASK-STORE-DELETEWINS' });
        const dwnB = await Dwn.create({
          didResolver,
          messageStore       : messageStoreB,
          dataStore          : dataStoreB,
          resumableTaskStore : resumableTaskStoreB,
        });

        try {
          await messageStoreB.clear();
          await dataStoreB.clear();
          await resumableTaskStoreB.clear();

          expect((await dwnB.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);
          expect(await dwnB.applyReplicatedMessage(
            alice.did, foo.message, { dataStream: DataStream.fromBytes(foo.dataBytes!) },
          )).toEqual(expect.objectContaining({ kind: 'Applied' }));
          expect(await dwnB.applyReplicatedMessage(
            alice.did, bar.message, { dataStream: DataStream.fromBytes(bar.dataBytes!) },
          )).toEqual(expect.objectContaining({ kind: 'Applied' }));
          expect(await dwnB.applyReplicatedMessage(alice.did, plainDelete.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));
          expect(await dwnB.applyReplicatedMessage(alice.did, prune.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));

          // the child is purged on both replicas
          const barCid = await Message.getCid(bar.message);
          expect(await messageStore.get(alice.did, barCid)).toBeUndefined();
          expect(await messageStoreB.get(alice.did, barCid)).toBeUndefined();
        } finally {
          await dwnB.close();
        }
      });

      const deepNestedProtocol: ProtocolDefinition = {
        protocol  : 'https://example.com/deep-nested',
        published : false,
        types     : {
          foo : {},
          bar : {},
          baz : {},
          qux : {},
        },
        structure: {
          foo: {
            bar: {
              baz: {
                qux: {},
              },
            },
          },
        },
      };

      type GeneratedWrite = Awaited<ReturnType<typeof TestDataGenerator.generateRecordsWrite>>;

      // Installs `deepNestedProtocol` on the local DWN and builds a foo -> bar -> baz -> qux
      // record chain under it. None of the generated records are stored; each test applies the
      // subset it needs to shape local ancestor presence.
      async function generateDeepNestedChain(
        alice: Persona,
      ): Promise<{ foo: GeneratedWrite; bar: GeneratedWrite; baz: GeneratedWrite; qux: GeneratedWrite }> {
        const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : deepNestedProtocol,
        });
        expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

        const foo = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : deepNestedProtocol.protocol,
          protocolPath : 'foo',
        });
        const bar = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : deepNestedProtocol.protocol,
          protocolPath    : 'foo/bar',
          parentContextId : foo.message.contextId,
        });
        const baz = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : deepNestedProtocol.protocol,
          protocolPath    : 'foo/bar/baz',
          parentContextId : bar.message.contextId,
        });
        const qux = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : deepNestedProtocol.protocol,
          protocolPath    : 'foo/bar/baz/qux',
          parentContextId : baz.message.contextId,
        });

        return { foo, bar, baz, qux };
      }

      it('emits one ref per missing contextId segment in a single Incomplete', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { foo, bar, baz, qux } = await generateDeepNestedChain(alice);

        // no ancestors are present locally: a single apply names every missing segment,
        // root-first, with the immediate parent keeping its existing Parent ref shape
        const result = await dwn.applyReplicatedMessage(
          alice.did, qux.message, { dataStream: DataStream.fromBytes(qux.dataBytes!) },
        );

        expect(result).toEqual({
          kind    : 'Incomplete',
          missing : [
            { type: 'Ancestor', recordId: foo.message.recordId, protocol: deepNestedProtocol.protocol },
            { type: 'Ancestor', recordId: bar.message.recordId, protocol: deepNestedProtocol.protocol },
            { type: 'Parent', recordId: baz.message.recordId, protocol: deepNestedProtocol.protocol },
          ],
        });
      });

      it('lists only the locally-missing ancestor segments when part of the chain is present', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { foo, bar, baz, qux } = await generateDeepNestedChain(alice);

        // the root of the chain is already present locally
        expect(await dwn.applyReplicatedMessage(
          alice.did, foo.message, { dataStream: DataStream.fromBytes(foo.dataBytes!) },
        )).toEqual(expect.objectContaining({ kind: 'Applied' }));

        const result = await dwn.applyReplicatedMessage(
          alice.did, qux.message, { dataStream: DataStream.fromBytes(qux.dataBytes!) },
        );

        expect(result).toEqual({
          kind    : 'Incomplete',
          missing : [
            { type: 'Ancestor', recordId: bar.message.recordId, protocol: deepNestedProtocol.protocol },
            { type: 'Parent', recordId: baz.message.recordId, protocol: deepNestedProtocol.protocol },
          ],
        });
      });

      it('resolves a deep ancestor chain in a bounded number of fetch-and-retry passes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { foo, bar, baz, qux } = await generateDeepNestedChain(alice);

        const chainWritesByRecordId = new Map([
          [foo.message.recordId, foo],
          [bar.message.recordId, bar],
          [baz.message.recordId, baz],
        ]);

        // engine loop: apply the deepest record, fetch whatever the Incomplete names, retry
        let applyAttempts = 0;
        let result: ReplicationApplyResult;
        do {
          applyAttempts += 1;
          result = await dwn.applyReplicatedMessage(
            alice.did, qux.message, { dataStream: DataStream.fromBytes(qux.dataBytes!) },
          );

          if (result.kind === 'Incomplete') {
            for (const ref of result.missing) {
              if (ref.type !== 'Ancestor' && ref.type !== 'Parent') {
                throw new Error(`Incomplete named an unexpected dependency ref type: ${ref.type}`);
              }
              const ancestor = chainWritesByRecordId.get(ref.recordId);
              if (ancestor === undefined) {
                throw new Error(`Incomplete named an unexpected ancestor: ${ref.recordId}`);
              }
              expect(await dwn.applyReplicatedMessage(
                alice.did, ancestor.message, { dataStream: DataStream.fromBytes(ancestor.dataBytes!) },
              )).toEqual(expect.objectContaining({ kind: 'Applied' }));
            }
          }
        } while (result.kind === 'Incomplete' && applyAttempts < 4);

        // the full 4-level chain resolves in two passes — one Incomplete naming all three
        // ancestors, then a clean apply — never one round trip per ancestry level
        expect(result).toEqual(expect.objectContaining({ kind: 'Applied' }));
        expect(applyAttempts).toBe(2);
      });
    });
  });
}
