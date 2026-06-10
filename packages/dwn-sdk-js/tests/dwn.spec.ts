import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../src/types/subscriptions.js';
import type { ProtocolDefinition } from '../src/index.js';
import type { ActiveTenantCheckResult, TenantGate } from '../src/index.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../src/index.js';

import sinon from 'sinon';

import { Dwn } from '../src/dwn.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { TestEventLog } from './test-event-stream.js';
import { TestStores } from './test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStoreLevel, EventEmitterEventLog, Message, MessageStoreLevel, ResumableTaskStoreLevel, StateIndexLevel } from '../src/index.js';
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
    });
  });
}
