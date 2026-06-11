import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../src/types/subscriptions.js';
import type { ProtocolDefinition } from '../src/index.js';
import type { ActiveTenantCheckResult, TenantGate } from '../src/index.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../src/index.js';

import sinon from 'sinon';

import { Dwn } from '../src/dwn.js';
import { TestEventLog } from './test-event-stream.js';
import { TestStores } from './test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStoreLevel, DataStream, EventEmitterEventLog, Jws, Message, MessageStoreLevel, RecordsDelete, RecordsRead, ResumableTaskStoreLevel, StateIndexLevel, Time } from '../src/index.js';
import { defaultTestProtocolDefinition, TestDataGenerator } from './utils/test-data-generator.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testDwnClass(): void {
  describe('DWN', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let stateIndex: StateIndex;
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
      stateIndex = stores.stateIndex;

      eventLog = TestEventLog.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, eventLog, resumableTaskStore });
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
        const stateIndexStub = sinon.createStubInstance(StateIndexLevel);
        const eventLogStub = sinon.createStubInstance(EventEmitterEventLog);

        const dwnWithConfig = await Dwn.create({
          tenantGate         : blockAllTenantGate,
          messageStore       : messageStoreStub,
          dataStore          : dataStoreStub,
          resumableTaskStore : resumableTaskStoreStub,
          stateIndex         : stateIndexStub,
          eventLog           : eventLogStub
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
        const stateIndexStub = sinon.createStubInstance(StateIndexLevel);
        const eventLogStub = sinon.createStubInstance(EventEmitterEventLog);

        const dwnWithConfig = await Dwn.create({
          tenantGate         : blockAllTenantGate,
          messageStore       : messageStoreStub,
          dataStore          : dataStoreStub,
          resumableTaskStore : resumableTaskStoreStub,
          stateIndex         : stateIndexStub,
          eventLog           : eventLogStub
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
      it('returns Duplicate and repairs the state index for an exact replay already in the message store', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        const initialReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(initialReply.status.code).toBe(202);

        const messageCid = await Message.getCid(message);
        await stateIndex.delete(alice.did, [messageCid]);
        expect(await stateIndex.getLeaves(alice.did, [])).not.toContain(messageCid);

        const result = await dwn.applyReplicatedMessage(alice.did, message);

        expect(result).toEqual({ kind: 'Duplicate' });
        expect(await stateIndex.getLeaves(alice.did, [])).toContain(messageCid);
      });

      it('returns Duplicate and repairs the event log for an exact replay already in the message store and state index', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        const initialReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(initialReply.status.code).toBe(202);

        const messageCid = await Message.getCid(message);
        expect(await stateIndex.getLeaves(alice.did, [])).toContain(messageCid);

        await eventLog.close();
        await eventLog.open();
        expect((await eventLog.read(alice.did)).events).toEqual([]);

        const result = await dwn.applyReplicatedMessage(alice.did, message);

        expect(result).toEqual({ kind: 'Duplicate' });
        const { events } = await eventLog.read(alice.did);
        expect(events.map(event => event.messageCid)).toContain(messageCid);
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
            contextId    : 'thread-context/comment-context',
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
        const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice });
        await Time.minimalSleep();
        const recordsDelete = await RecordsDelete.create({
          recordId : initialWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        await Time.minimalSleep();
        const update = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : initialWrite.recordsWrite,
        });

        // replica A: initial write and the newer update land first, the older tombstone last
        expect(await dwn.applyReplicatedMessage(
          alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
        )).toEqual({ kind: 'Applied' });
        expect(await dwn.applyReplicatedMessage(
          alice.did, update.message, { dataStream: DataStream.fromBytes(update.dataBytes) },
        )).toEqual({ kind: 'Applied' });
        expect(await dwn.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual({ kind: 'Applied' });

        // replica B: the tombstone lands before the newer update
        const messageStoreB = new MessageStoreLevel({
          blockstoreLocation : 'TEST-MESSAGESTORE-DELETEWINS',
          indexLocation      : 'TEST-INDEX-DELETEWINS',
        });
        const dataStoreB = new DataStoreLevel({ blockstoreLocation: 'TEST-DATASTORE-DELETEWINS' });
        const stateIndexB = new StateIndexLevel({ location: 'TEST-STATEINDEX-DELETEWINS' });
        const resumableTaskStoreB = new ResumableTaskStoreLevel({ location: 'TEST-RESUMABLE-TASK-STORE-DELETEWINS' });
        const dwnB = await Dwn.create({
          didResolver,
          messageStore       : messageStoreB,
          dataStore          : dataStoreB,
          stateIndex         : stateIndexB,
          eventLog           : new EventEmitterEventLog(),
          resumableTaskStore : resumableTaskStoreB,
        });

        try {
          await messageStoreB.clear();
          await dataStoreB.clear();
          await stateIndexB.clear();
          await resumableTaskStoreB.clear();

          expect((await dwnB.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);
          expect(await dwnB.applyReplicatedMessage(
            alice.did, initialWrite.message, { dataStream: DataStream.fromBytes(initialWrite.dataBytes!) },
          )).toEqual({ kind: 'Applied' });
          expect(await dwnB.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual({ kind: 'Applied' });
          expect(await dwnB.applyReplicatedMessage(
            alice.did, update.message, { dataStream: DataStream.fromBytes(update.dataBytes) },
          )).toEqual({ kind: 'Superseded' });

          // both replicas read the record as deleted and report identical state roots
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

          expect(await stateIndexB.getRoot(alice.did)).toEqual(await stateIndex.getRoot(alice.did));
        } finally {
          await dwnB.close();
        }
      });
    });
  });
}
