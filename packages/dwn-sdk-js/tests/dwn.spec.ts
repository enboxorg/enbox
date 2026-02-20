import type { DidResolver } from '@enbox/dids';
import type { EventStream } from '../src/types/subscriptions.js';
import type { ActiveTenantCheckResult, TenantGate } from '../src/index.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../src/index.js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStoreLevel, EventEmitterStream, MessageStoreLevel, ResumableTaskStoreLevel, StateIndexLevel } from '../src/index.js';

import { Dwn } from '../src/dwn.js';
import { Message } from '../src/core/message.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { TestEventStream } from './test-event-stream.js';
import { TestStores } from './test-stores.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testDwnClass(): void {
  describe('DWN', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let stateIndex: StateIndex;
    let eventStream: EventStream;
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

      eventStream = TestEventStream.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, eventStream, resumableTaskStore });
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
      // generate a `did:key` DID
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
        });

        const reply = await dwn.processMessage(alice.did, message, { dataStream });

        expect(reply.status.code).toBe(202);
      });

      it('should process RecordsQuery message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { author, message } = await TestDataGenerator.generateRecordsQuery({ author: alice });

        const tenant = author!.did;
        const reply = await dwn.processMessage(tenant, message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries).toEqual([]);
      });

      it('#191 - regression - should run JSON schema validation', async () => {
        const invalidMessage = {
          descriptor: {
            interface        : 'Records',
            method           : 'Read',
            messageTimestamp : '2023-07-25T10:20:30.123456Z'
          },
          authorization: {}
        };

        const validateJsonSchemaSpy = sinon.spy(Message, 'validateJsonSchema');

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const reply = await dwn.processMessage(alice.did, invalidMessage);

        sinon.assert.calledOnce(validateJsonSchemaSpy);

        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(`must have required property 'filter'`);
      });

      it('should throw 400 if given no interface or method found in message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const reply1 = await dwn.processMessage(alice.did, undefined ); // missing message entirely, thus missing both `interface` and `method`
        expect(reply1.status.code).toBe(400);
        expect(reply1.status.detail).toContain('Both interface and method must be present');

        const reply2 = await dwn.processMessage(alice.did, { descriptor: { method: 'anyValue' } }); // missing `interface`
        expect(reply2.status.code).toBe(400);
        expect(reply2.status.detail).toContain('Both interface and method must be present');

        const reply3 = await dwn.processMessage(alice.did, { descriptor: { interface: 'anyValue' } }); // missing `method`
        expect(reply3.status.code).toBe(400);
        expect(reply3.status.detail).toContain('Both interface and method must be present');
      });

      it('should throw 401 if message is targeted at a non active tenant', async () => {
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
        const eventStreamStub = sinon.createStubInstance(EventEmitterStream);

        const dwnWithConfig = await Dwn.create({
          tenantGate         : blockAllTenantGate,
          messageStore       : messageStoreStub,
          dataStore          : dataStoreStub,
          resumableTaskStore : resumableTaskStoreStub,
          stateIndex         : stateIndexStub,
          eventStream        : eventStreamStub
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
        const eventStreamStub = sinon.createStubInstance(EventEmitterStream);

        const dwnWithConfig = await Dwn.create({
          tenantGate         : blockAllTenantGate,
          messageStore       : messageStoreStub,
          dataStore          : dataStoreStub,
          resumableTaskStore : resumableTaskStoreStub,
          stateIndex         : stateIndexStub,
          eventStream        : eventStreamStub
        });

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { author, message } = await TestDataGenerator.generateRecordsQuery({ author: alice });

        const tenant = author!.did;
        const reply = await dwnWithConfig.processMessage(tenant, message);

        expect(reply.status.code).toBe(401);
        expect(reply.status.detail).toBe(customMessage);
      });
    });
  });
}
