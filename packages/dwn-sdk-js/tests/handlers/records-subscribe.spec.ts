import type { DidResolver } from '@enbox/dids';
import type { DataStore, MessageStore, ProtocolDefinition, ProtocolRuleSet, RecordsDeleteMessage, RecordsWriteMessage, ResumableTaskStore } from '../../src/index.js';
import type { EventLog, EventSubscription, SubscriptionListener, SubscriptionMessage } from '../../src/types/subscriptions.js';
import type { GenerateGrantCreateOutput, Persona } from '../utils/test-data-generator.js';
import type { RecordEvent, RecordsFilter } from '../../src/types/records-types.js';

import sinon from 'sinon';

import { sleep } from '@enbox/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../../src/types/encryption-types.js';
import { GrantAuthorization } from '../../src/core/grant-authorization.js';
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { MessageStoreLevel } from '../../src/store/level.js';
import { PermissionsProtocol } from '../../src/protocols/permissions.js';
import { Poller } from '../utils/poller.js';
import { ProtocolAuthorization } from '../../src/core/protocol-authorization.js';
import { RecordsSubscribe } from '../../src/interfaces/records-subscribe.js';
import { RecordsSubscribeHandler } from '../../src/handlers/records-subscribe.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { createAudienceControlWrite, createDeliveryControlWrite, installEncryptedProtocol, processControlWrite } from '../utils/encryption-control-test-utils.js';
import { DateSort, DurableEventLog, Dwn, DwnError, DwnErrorCode, DwnInterfaceName, DwnMethodName, PermissionGrant, Time } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH } from '../../src/core/constants.js';

import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';

export function testRecordsSubscribeHandler(): void {
  describe('RecordsSubscribeHandler.handle()', () => {
    describe('EventLog disabled',() => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let resumableTaskStore: ResumableTaskStore;
      let dataStore: DataStore;
      let dwn: Dwn;

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      beforeAll(async () => {
        didResolver = new UniversalResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        resumableTaskStore = stores.resumableTaskStore;

        dwn = await Dwn.create({
          didResolver,
          messageStore,
          dataStore,
          resumableTaskStore,
        });

      });

      beforeEach(async () => {
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('should respond with a 501 if subscriptions are not supported', async () => {
        await dwn.close(); // close the original dwn instance
        dwn = await Dwn.create({ didResolver, messageStore, dataStore, resumableTaskStore }); // leave out eventLog

        const alice = await TestDataGenerator.generateDidKeyPersona();
        // attempt to subscribe
        const { message } = await TestDataGenerator.generateRecordsSubscribe({
          author: alice,
        });
        const subscriptionMessageReply = await dwn.processMessage(alice.did, message, { subscriptionHandler: (_) => {} });
        expect(subscriptionMessageReply.status.code).toBe(501, subscriptionMessageReply.status.detail);
        expect(subscriptionMessageReply.status.detail).toContain(DwnErrorCode.RecordsSubscribeEventLogUnimplemented);
      });
    });

    describe('functional tests', () => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let dataStore: DataStore;
      let resumableTaskStore: ResumableTaskStore;
      let eventLog: EventLog;
      let dwn: Dwn;

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
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
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('should return a subscription object', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'some-schema' },
        });

        // Send records subscribe message
        const reply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler: () => {} });
        expect(reply.status.code).toBe(200);
        expect(reply.subscription).toBeDefined();
        expect(reply.entries).toBeDefined();
        expect(reply.entries!).toHaveLength(0); // no matching records exist yet
      });

      it('should return initial entries matching the filter', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write some records before subscribing
        const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://test-schema' });
        const write1Reply = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        expect(write1Reply.status.code).toBe(202);

        const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://test-schema' });
        const write2Reply = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        expect(write2Reply.status.code).toBe(202);

        // write a record with a different schema that should NOT be in the entries
        const write3 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://other-schema' });
        const write3Reply = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(write3Reply.status.code).toBe(202);

        // subscribe with a filter that matches only the first two writes
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'http://test-schema' },
        });
        const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler: () => {} });
        expect(subReply.status.code).toBe(200);
        expect(subReply.subscription).toBeDefined();
        expect(subReply.entries).toBeDefined();
        expect(subReply.entries!).toHaveLength(2);

        const returnedRecordIds = subReply.entries!.map(e => e.recordId);
        expect(returnedRecordIds).toContain(write1.message.recordId);
        expect(returnedRecordIds).toContain(write2.message.recordId);
      });

      it('should use created-ascending order for Query and Subscribe snapshots by default', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://default-created-order';
        const earlierTimestamp = Time.getCurrentTimestamp();
        const laterTimestamp = Time.createOffsetTimestamp({ seconds: 1 }, earlierTimestamp);

        // Process the later record first so insertion order cannot satisfy the assertion accidentally.
        const laterWrite = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          schema,
          dateCreated      : laterTimestamp,
          messageTimestamp : laterTimestamp,
        });
        const earlierWrite = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          schema,
          dateCreated      : earlierTimestamp,
          messageTimestamp : earlierTimestamp,
        });
        expect((await dwn.processMessage(alice.did, laterWrite.message, { dataStream: laterWrite.dataStream })).status.code).toBe(202);
        expect((await dwn.processMessage(alice.did, earlierWrite.message, { dataStream: earlierWrite.dataStream })).status.code).toBe(202);

        const recordsQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { schema } });
        const queryReply = await dwn.processMessage(alice.did, recordsQuery.message);

        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: alice, filter: { schema } });
        const subscribeReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler: () => {} });

        const expectedRecordIds = [earlierWrite.message.recordId, laterWrite.message.recordId];
        expect(queryReply.entries?.map(entry => entry.recordId)).toEqual(expectedRecordIds);
        expect(subscribeReply.entries?.map(entry => entry.recordId)).toEqual(expectedRecordIds);
        await subscribeReply.subscription!.close();
      });

      it('should return and deliver only published records to an anonymous subscriber', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://anonymous-published-subscribe';
        const initialPublished = await TestDataGenerator.generateRecordsWrite({ author: alice, schema, published: true });
        const initialUnpublished = await TestDataGenerator.generateRecordsWrite({ author: alice, schema, published: false });
        const initialPublishedReply = await dwn.processMessage(
          alice.did, initialPublished.message, { dataStream: initialPublished.dataStream }
        );
        const initialUnpublishedReply = await dwn.processMessage(
          alice.did, initialUnpublished.message, { dataStream: initialUnpublished.dataStream }
        );
        expect(initialPublishedReply.status.code).toBe(202);
        expect(initialUnpublishedReply.status.code).toBe(202);

        const receivedEvents: RecordEvent[] = [];
        const anonymousSubscribe = await RecordsSubscribe.create({ filter: { schema } });
        const subscribeReply = await dwn.processMessage(alice.did, anonymousSubscribe.message, {
          subscriptionHandler: (message): void => {
            if (message.type === 'event') {
              receivedEvents.push(message.event as RecordEvent);
            }
          },
        });

        expect(subscribeReply.status.code).toBe(200);
        expect(subscribeReply.entries?.map(entry => entry.recordId)).toEqual([initialPublished.message.recordId]);

        const liveUnpublished = await TestDataGenerator.generateRecordsWrite({ author: alice, schema, published: false });
        const livePublished = await TestDataGenerator.generateRecordsWrite({ author: alice, schema, published: true });
        const liveUnpublishedReply = await dwn.processMessage(
          alice.did, liveUnpublished.message, { dataStream: liveUnpublished.dataStream }
        );
        const livePublishedReply = await dwn.processMessage(
          alice.did, livePublished.message, { dataStream: livePublished.dataStream }
        );
        expect(liveUnpublishedReply.status.code).toBe(202);
        expect(livePublishedReply.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(receivedEvents).toHaveLength(1);
          expect((receivedEvents[0].message as RecordsWriteMessage).recordId).toBe(livePublished.message.recordId);
        });
        await subscribeReply.subscription!.close();
      });

      it('should support pagination on initial entries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write 5 records
        for (let i = 0; i < 5; i++) {
          const write = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://paginated' });
          const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
          expect(writeReply.status.code).toBe(202);
        }

        // subscribe with a limit of 2
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author     : alice,
          filter     : { schema: 'http://paginated' },
          pagination : { limit: 2 },
        });
        const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler: () => {} });
        expect(subReply.status.code).toBe(200);
        expect(subReply.subscription).toBeDefined();
        expect(subReply.entries).toBeDefined();
        expect(subReply.entries!).toHaveLength(2);
        expect(subReply.cursor).toBeDefined();
      });

      it('should include initialWrite for updated records in entries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // create a record
        const write = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://update-test' });
        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        // update the record
        const update = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : write.recordsWrite,
        });
        const updateReply = await dwn.processMessage(alice.did, update.message, { dataStream: update.dataStream });
        expect(updateReply.status.code).toBe(202);

        // subscribe and check the entries
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'http://update-test' },
        });
        const querySpy = sinon.spy(messageStore, 'query');
        const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler: () => {} });
        expect(subReply.status.code).toBe(200);
        expect(subReply.entries).toBeDefined();
        expect(subReply.entries!).toHaveLength(1);

        // the entry should be the update, with initialWrite attached
        expect(subReply.entries![0].recordId).toBe(write.message.recordId);
        expect(subReply.entries![0].initialWrite).toBeDefined();
        expect(subReply.entries![0].initialWrite!.descriptor.dateCreated).toBe(write.message.descriptor.dateCreated);
        expect(querySpy.getCalls().some((call): boolean =>
          (call.args[1] as Array<{ entryId?: string | string[] }>).some((filter): boolean =>
            filter.entryId === write.message.recordId ||
            (Array.isArray(filter.entryId) && filter.entryId.includes(write.message.recordId))
          )
        )).toBe(true);
      });

      it('should omit an updated record with no initial write from the initial snapshot', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://missing-initial-write';
        const initialDateCreated = Time.createOffsetTimestamp({ seconds: -10 });
        const write = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          schema,
          dateCreated      : initialDateCreated,
          messageTimestamp : initialDateCreated,
        });
        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        const update = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : write.recordsWrite,
        });
        const updateReply = await dwn.processMessage(alice.did, update.message, { dataStream: update.dataStream });
        expect(updateReply.status.code).toBe(202);

        // Simulate store corruption: leave the latest update indexed but remove its retained
        // initial-write row (the write path commits both atomically, so only corruption or
        // partial deletion can produce this state).
        await messageStore.delete(alice.did, await Message.getCid(write.message));

        const healthyWrite1 = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          schema,
          dateCreated      : Time.createOffsetTimestamp({ seconds: 1 }, initialDateCreated),
          messageTimestamp : Time.createOffsetTimestamp({ seconds: 1 }, initialDateCreated),
        });
        const healthyWrite2 = await TestDataGenerator.generateRecordsWrite({
          author           : alice,
          schema,
          dateCreated      : Time.createOffsetTimestamp({ seconds: 2 }, initialDateCreated),
          messageTimestamp : Time.createOffsetTimestamp({ seconds: 2 }, initialDateCreated),
        });
        expect((await dwn.processMessage(alice.did, healthyWrite1.message, { dataStream: healthyWrite1.dataStream })).status.code).toBe(202);
        expect((await dwn.processMessage(alice.did, healthyWrite2.message, { dataStream: healthyWrite2.dataStream })).status.code).toBe(202);

        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author   : alice,
          filter   : { schema },
          dateSort : DateSort.CreatedAscending,
        });
        const warnSpy = sinon.stub(console, 'warn');
        const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler: () => {} });

        expect(subReply.status.code).toBe(200);
        expect(subReply.subscription).toBeDefined();
        expect(subReply.entries!.map(entry => entry.recordId)).toEqual([
          healthyWrite1.message.recordId,
          healthyWrite2.message.recordId,
        ]);
        expect(subReply.entries!.some(entry => entry.recordId === write.message.recordId)).toBe(false);
        expect(warnSpy.getCalls().some(call =>
          String(call.args[0]).includes(DwnErrorCode.RecordsWriteGetInitialWriteNotFound) &&
          String(call.args[0]).includes('RecordsSubscribe') &&
          String(call.args[0]).includes(write.message.recordId)
        )).toBe(true);

        await subReply.subscription!.close();
      });

      it('should receive live write and delete events after the initial snapshot', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write a record before subscribing
        const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://live-test' });
        const write1Reply = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        expect(write1Reply.status.code).toBe(202);

        // subscribe
        const receivedEvents: RecordEvent[] = [];
        const subscriptionHandler: SubscriptionListener = (msg): void => { if (msg.type === 'event') { receivedEvents.push(msg.event as RecordEvent); } };
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'http://live-test' },
        });
        const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler });
        expect(subReply.status.code).toBe(200);
        expect(subReply.entries!).toHaveLength(1); // initial entries has write1

        // write another record after subscribing
        const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://live-test' });
        const write2Reply = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        expect(write2Reply.status.code).toBe(202);

        // wait for the event to arrive
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(receivedEvents).toHaveLength(1);
          expect((receivedEvents[0].message as RecordsWriteMessage).recordId).toBe(write2.message.recordId);
        });

        const delete2 = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : write2.message.recordId,
        });
        const delete2Reply = await dwn.processMessage(alice.did, delete2.message);
        expect(delete2Reply.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(receivedEvents).toHaveLength(2);
          expect(receivedEvents[1].message.descriptor.method).toBe(DwnMethodName.Delete);
          expect((receivedEvents[1].message as RecordsDeleteMessage).descriptor.recordId).toBe(write2.message.recordId);
        });
        await subReply.subscription!.close();
      });

      it('should project exact-tuple audience control subscription snapshots and live events to the current key', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-subscribe-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role    : true,
              $actions : [{ who: 'anyone', can: ['create'] }],
            },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;
        const initialAudience = await createAudienceControlWrite({
          author      : bob,
          dateCreated : Time.createOffsetTimestamp({ seconds: 1 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, initialAudience);

        const receivedEvents: RecordEvent[] = [];
        const subscriptionHandler: SubscriptionListener = (msg): void => {
          if (msg.type === 'event') {
            receivedEvents.push(msg.event as RecordEvent);
          }
        };
        const recordsSubscribe = await RecordsSubscribe.create({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags         : {
              protocol  : protocolDefinition.protocol,
              rolePath  : 'member',
              contextId : '',
            },
          },
          signer: Jws.createSigner(bob),
        });
        const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler });
        expect(subReply.status.code).toBe(200);
        expect(subReply.entries?.map(entry => entry.recordId)).toEqual([initialAudience.recordsWrite.message.recordId]);

        const nonCurrentLiveAudience = await createAudienceControlWrite({
          author      : carol,
          dateCreated : Time.createOffsetTimestamp({ seconds: 2 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, nonCurrentLiveAudience);

        const currentLiveAudience = await createAudienceControlWrite({
          author      : alice,
          dateCreated : Time.createOffsetTimestamp({ seconds: 3 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, currentLiveAudience);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          const liveRecordIds = receivedEvents.map(event => (event.message as RecordsWriteMessage).recordId);
          expect(liveRecordIds).toContain(currentLiveAudience.recordsWrite.message.recordId);
          expect(liveRecordIds).not.toContain(nonCurrentLiveAudience.recordsWrite.message.recordId);
        });
      });

      it('should deliver live exact-keyId audience events even when the key is not current', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-subscribe-exact-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role    : true,
              $actions : [{ who: 'anyone', can: ['create'] }],
            },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;
        const currentAudience = await createAudienceControlWrite({
          author      : alice,
          dateCreated : Time.createOffsetTimestamp({ seconds: 1 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, currentAudience);

        const nonCurrentLiveAudience = await createAudienceControlWrite({
          author      : carol,
          dateCreated : Time.createOffsetTimestamp({ seconds: 2 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });

        const receivedEvents: RecordEvent[] = [];
        const subscriptionHandler: SubscriptionListener = (msg): void => {
          if (msg.type === 'event') {
            receivedEvents.push(msg.event as RecordEvent);
          }
        };
        const recordsSubscribe = await RecordsSubscribe.create({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags         : {
              protocol  : protocolDefinition.protocol,
              rolePath  : 'member',
              contextId : '',
              keyId     : nonCurrentLiveAudience.keyId,
            },
          },
          signer: Jws.createSigner(bob),
        });
        const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler });
        expect(subReply.status.code).toBe(200);
        expect(subReply.entries?.map(entry => entry.recordId)).toEqual([]);

        await processControlWrite(dwn, alice.did, nonCurrentLiveAudience);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(receivedEvents.map(event => (event.message as RecordsWriteMessage).recordId)).toEqual([
            nonCurrentLiveAudience.recordsWrite.message.recordId,
          ]);
        });
      });

      it('should deliver live delivery control events only to the recipient', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-subscribe-delivery.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;
        const audience = await createAudienceControlWrite({
          author   : alice,
          protocol : protocolDefinition.protocol,
          rolePath : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const roleRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          data         : Encoder.stringToBytes('bob is a member'),
          dataFormat   : 'application/json',
          protocol     : protocolDefinition.protocol,
          protocolPath : 'member',
          recipient    : bob.did,
          schema       : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, roleRecord.message, { dataStream: roleRecord.dataStream })).status.code).toBe(202);

        const bobEvents: RecordEvent[] = [];
        const carolEvents: RecordEvent[] = [];
        const delegatedCarolEvents: RecordEvent[] = [];
        const carolGrant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : carol,
          delegated : true,
          scope     : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            protocol  : protocolDefinition.protocol,
          },
        });
        expect((await dwn.processMessage(alice.did, carolGrant.message, { dataStream: carolGrant.dataStream })).status.code).toBe(202);

        const bobSubscribe = await RecordsSubscribe.create({
          filter : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer : Jws.createSigner(bob),
        });
        const carolSubscribe = await RecordsSubscribe.create({
          filter : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer : Jws.createSigner(carol),
        });
        const delegatedCarolSubscribe = await RecordsSubscribe.create({
          delegatedGrant : carolGrant.dataEncodedMessage,
          filter         : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer         : Jws.createSigner(carol),
        });
        const bobReply = await dwn.processMessage(alice.did, bobSubscribe.message, {
          subscriptionHandler: (msg): void => {
            if (msg.type === 'event') {
              bobEvents.push(msg.event as RecordEvent);
            }
          },
        });
        const carolReply = await dwn.processMessage(alice.did, carolSubscribe.message, {
          subscriptionHandler: (msg): void => {
            if (msg.type === 'event') {
              carolEvents.push(msg.event as RecordEvent);
            }
          },
        });
        const delegatedCarolReply = await dwn.processMessage(alice.did, delegatedCarolSubscribe.message, {
          subscriptionHandler: (msg): void => {
            if (msg.type === 'event') {
              delegatedCarolEvents.push(msg.event as RecordEvent);
            }
          },
        });
        expect(bobReply.status.code).toBe(200);
        expect(carolReply.status.code).toBe(200);
        expect(delegatedCarolReply.status.code).toBe(200);

        const delivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          protocol           : protocolDefinition.protocol,
          recipient          : bob.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, delivery);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(bobEvents.map(event => (event.message as RecordsWriteMessage).recordId)).toContain(delivery.recordsWrite.message.recordId);
        });
        await sleep(200);
        expect(carolEvents.map(event => (event.message as RecordsWriteMessage).recordId)).not.toContain(delivery.recordsWrite.message.recordId);
        const delegatedCarolRecordIds = delegatedCarolEvents.map(event => (event.message as RecordsWriteMessage).recordId);
        expect(delegatedCarolRecordIds).not.toContain(delivery.recordsWrite.message.recordId);
      });

      describe('delivery authorization', () => {
        const createGrantAuthorizedSubscription = async (input: {
          dateExpires?: string;
          delegated: boolean;
          protocol: string;
        }): Promise<{
          alice: Persona;
          grant: GenerateGrantCreateOutput;
          received: SubscriptionMessage[];
          subscription: EventSubscription;
        }> => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const grantee = await TestDataGenerator.generateDidKeyPersona();
          const protocolDefinition: ProtocolDefinition = {
            protocol  : input.protocol,
            published : false,
            types     : { note: {} },
            structure : { note: {} },
          };
          const configure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
          expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);

          const grant = await TestDataGenerator.generateGrantCreate({
            author      : alice,
            grantedTo   : grantee,
            dateExpires : input.dateExpires ?? Time.createOffsetTimestamp({ seconds: 60 }),
            delegated   : input.delegated,
            scope       : {
              interface    : DwnInterfaceName.Records,
              method       : DwnMethodName.Read,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'note',
            },
          });
          expect((await dwn.processMessage(alice.did, grant.message, { dataStream: grant.dataStream })).status.code).toBe(202);

          const received: SubscriptionMessage[] = [];
          const recordsSubscribe = await RecordsSubscribe.create({
            delegatedGrant    : input.delegated ? grant.dataEncodedMessage : undefined,
            filter            : { protocol: protocolDefinition.protocol, protocolPath: 'note' },
            permissionGrantId : input.delegated ? undefined : grant.message.recordId,
            signer            : Jws.createSigner(grantee),
          });
          const reply = await dwn.processMessage(alice.did, recordsSubscribe.message, {
            subscriptionHandler: (message): void => { received.push(message); },
          });
          expect(reply.status.code).toBe(200);

          return { alice, grant, received, subscription: reply.subscription! };
        };

        const writeNote = async (
          alice: Persona,
          protocol: string,
        ): Promise<void> => {
          const write = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol,
            protocolPath : 'note',
          });
          expect((await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream })).status.code).toBe(202);
        };

        const revokeGrant = async (
          alice: Persona,
          grant: GenerateGrantCreateOutput,
        ): Promise<void> => {
          const revocation = await PermissionsProtocol.createRevocation({
            signer : Jws.createSigner(alice),
            grant  : PermissionGrant.parse(grant.dataEncodedMessage),
          });
          const reply = await dwn.processMessage(alice.did, revocation.recordsWrite.message, {
            dataStream: DataStream.fromBytes(revocation.permissionRevocationBytes),
          });
          expect(reply.status.code).toBe(202);
        };

        const expectTerminalAuthorizationFailure = async (
          received: SubscriptionMessage[],
          expectedEventCount: number,
        ): Promise<void> => {
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'error')).toHaveLength(1);
          });
          expect(received.find(message => message.type === 'error')?.error.code)
            .toBe(DwnErrorCode.RecordsSubscribeDeliveryAuthorizationFailed);
          expect(received.filter(message => message.type === 'event')).toHaveLength(expectedEventCount);
        };

        it('stops direct grant delivery after revocation', async () => {
          const protocol = 'http://records-subscribe-direct-revoked';
          const { alice, grant, received, subscription } = await createGrantAuthorizedSubscription({
            delegated: false,
            protocol,
          });
          const closeSpy = sinon.spy(subscription, 'close');

          await writeNote(alice, protocol);
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'event')).toHaveLength(1);
          });
          await Time.minimalSleep();
          await revokeGrant(alice, grant);
          await writeNote(alice, protocol);

          await expectTerminalAuthorizationFailure(received, 1);
          expect(closeSpy.calledOnce).toBe(true);
        });

        it('stops direct grant delivery after expiry', async () => {
          const protocol = 'http://records-subscribe-direct-expired';
          const dateExpires = Time.createOffsetTimestamp({ seconds: 60 });
          const { alice, received } = await createGrantAuthorizedSubscription({
            dateExpires,
            delegated: false,
            protocol,
          });

          await writeNote(alice, protocol);
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'event')).toHaveLength(1);
          });
          sinon.stub(Time, 'getCurrentTimestamp').returns(Time.createOffsetTimestamp({ seconds: 1 }, dateExpires));
          await writeNote(alice, protocol);

          await expectTerminalAuthorizationFailure(received, 1);
        });

        it('stops author-delegate delivery after revocation', async () => {
          const protocol = 'http://records-subscribe-delegate-revoked';
          const { alice, grant, received } = await createGrantAuthorizedSubscription({
            delegated: true,
            protocol,
          });

          await writeNote(alice, protocol);
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'event')).toHaveLength(1);
          });
          await Time.minimalSleep();
          await revokeGrant(alice, grant);
          await writeNote(alice, protocol);

          await expectTerminalAuthorizationFailure(received, 1);
        });

        it('stops author-delegate delivery after expiry', async () => {
          const protocol = 'http://records-subscribe-delegate-expired';
          const dateExpires = Time.createOffsetTimestamp({ seconds: 60 });
          const { alice, received } = await createGrantAuthorizedSubscription({
            dateExpires,
            delegated: true,
            protocol,
          });

          await writeNote(alice, protocol);
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'event')).toHaveLength(1);
          });
          sinon.stub(Time, 'getCurrentTimestamp').returns(Time.createOffsetTimestamp({ seconds: 1 }, dateExpires));
          await writeNote(alice, protocol);

          await expectTerminalAuthorizationFailure(received, 1);
        });

        it('preserves event order and emits one terminal error for concurrent delivery failures', async () => {
          const protocol = 'http://records-subscribe-ordered-delivery';
          const { alice, received } = await createGrantAuthorizedSubscription({
            delegated: false,
            protocol,
          });
          let firstAuthorizationStarted!: () => void;
          let releaseFirstAuthorization!: () => void;
          const firstAuthorizationStartedPromise = new Promise<void>((resolve) => { firstAuthorizationStarted = resolve; });
          const releaseFirstAuthorizationPromise = new Promise<void>((resolve) => { releaseFirstAuthorization = resolve; });
          const authorizationStub = sinon.stub(GrantAuthorization, 'performBaseValidation');
          authorizationStub.onFirstCall().callsFake(async (): Promise<void> => {
            firstAuthorizationStarted();
            await releaseFirstAuthorizationPromise;
          });
          authorizationStub.onSecondCall().throws(new DwnError(
            DwnErrorCode.GrantAuthorizationGrantRevoked,
            'permission grant revoked',
          ));

          await writeNote(alice, protocol);
          await firstAuthorizationStartedPromise;
          await writeNote(alice, protocol);
          await writeNote(alice, protocol);
          await Time.minimalSleep();
          expect(received).toHaveLength(0);

          releaseFirstAuthorization();
          await expectTerminalAuthorizationFailure(received, 1);
          const [eventMessage, errorMessage] = received;
          expect(eventMessage.type).toBe('event');
          expect(errorMessage.type).toBe('error');

          await writeNote(alice, protocol);
          await Time.minimalSleep();
          expect(received).toHaveLength(2);
          expect(authorizationStub.callCount).toBe(2);
        });

        it('emits a retryable terminal error when delivery revalidation itself fails', async () => {
          const protocol = 'http://records-subscribe-revalidation-failed';
          const { alice, received, subscription } = await createGrantAuthorizedSubscription({
            delegated: false,
            protocol,
          });
          const closeSpy = sinon.spy(subscription, 'close');
          const authorizationStub = sinon.stub(GrantAuthorization, 'performBaseValidation')
            .rejects(new Error('validation state unavailable'));

          await writeNote(alice, protocol);
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'error')).toHaveLength(1);
          });
          expect(received.find(message => message.type === 'error')?.error.code)
            .toBe(DwnErrorCode.RecordsSubscribeDeliveryFailed);
          expect(received.filter(message => message.type === 'event')).toHaveLength(0);
          expect(closeSpy.calledOnce).toBe(true);

          await writeNote(alice, protocol);
          await Time.minimalSleep();
          expect(received.filter(message => message.type === 'error')).toHaveLength(1);
          expect(authorizationStub.callCount).toBe(1);
        });

        it('stops a root-role subscription after the role record is deleted', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocolDefinition: ProtocolDefinition = {
            protocol  : 'http://records-subscribe-root-role-deleted',
            published : false,
            types     : { friend: {}, note: {} },
            structure : {
              friend : { $role: true },
              note   : { $actions: [{ role: 'friend', can: ['read'] }] },
            },
          };
          const configure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
          expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
          const role = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'friend',
          });
          expect((await dwn.processMessage(alice.did, role.message, { dataStream: role.dataStream })).status.code).toBe(202);

          const received: SubscriptionMessage[] = [];
          const subscribe = await RecordsSubscribe.create({
            filter       : { protocol: protocolDefinition.protocol, protocolPath: 'note' },
            protocolRole : 'friend',
            signer       : Jws.createSigner(bob),
          });
          const subscribeReply = await dwn.processMessage(alice.did, subscribe.message, {
            subscriptionHandler: (message): void => { received.push(message); },
          });
          expect(subscribeReply.status.code).toBe(200);
          const closeSpy = sinon.spy(subscribeReply.subscription!, 'close');

          await writeNote(alice, protocolDefinition.protocol);
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'event')).toHaveLength(1);
          });
          const roleDelete = await TestDataGenerator.generateRecordsDelete({ author: alice, recordId: role.message.recordId });
          expect((await dwn.processMessage(alice.did, roleDelete.message)).status.code).toBe(202);
          await writeNote(alice, protocolDefinition.protocol);

          await expectTerminalAuthorizationFailure(received, 1);
          expect(closeSpy.calledOnce).toBe(true);
          await writeNote(alice, protocolDefinition.protocol);
          await Time.minimalSleep();
          expect(received.filter(message => message.type === 'error')).toHaveLength(1);
          expect(received.filter(message => message.type === 'event')).toHaveLength(1);
        });

        it('stops a context-role subscription after the role record is deleted', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocolDefinition: ProtocolDefinition = {
            protocol  : 'http://records-subscribe-context-role-deleted',
            published : false,
            types     : { thread: {}, participant: {}, note: {} },
            structure : {
              thread: {
                participant : { $role: true },
                note        : { $actions: [{ role: 'thread/participant', can: ['read'] }] },
              },
            },
          };
          const configure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
          expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
          const thread = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          expect((await dwn.processMessage(alice.did, thread.message, { dataStream: thread.dataStream })).status.code).toBe(202);
          const role = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/participant',
            parentContextId : thread.message.contextId,
          });
          expect((await dwn.processMessage(alice.did, role.message, { dataStream: role.dataStream })).status.code).toBe(202);

          const received: SubscriptionMessage[] = [];
          const subscribe = await RecordsSubscribe.create({
            filter: {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/note',
              contextId    : thread.message.contextId,
            },
            protocolRole : 'thread/participant',
            signer       : Jws.createSigner(bob),
          });
          const subscribeReply = await dwn.processMessage(alice.did, subscribe.message, {
            subscriptionHandler: (message): void => { received.push(message); },
          });
          expect(subscribeReply.status.code).toBe(200);

          const writeContextNote = async (): Promise<void> => {
            const note = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/note',
              parentContextId : thread.message.contextId,
            });
            expect((await dwn.processMessage(alice.did, note.message, { dataStream: note.dataStream })).status.code).toBe(202);
          };
          await writeContextNote();
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(received.filter(message => message.type === 'event')).toHaveLength(1);
          });
          const roleDelete = await TestDataGenerator.generateRecordsDelete({ author: alice, recordId: role.message.recordId });
          expect((await dwn.processMessage(alice.did, roleDelete.message)).status.code).toBe(202);
          await writeContextNote();

          await expectTerminalAuthorizationFailure(received, 1);
        });

        it('does not run dynamic authorization checks for static subscription paths', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocolDefinition: ProtocolDefinition = {
            protocol  : 'http://records-subscribe-static-delivery',
            published : false,
            types     : { note: {} },
            structure : { note: {} },
          };
          const configure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
          expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);

          const ownerReceived: SubscriptionMessage[] = [];
          const recipientReceived: SubscriptionMessage[] = [];
          const anonymousReceived: SubscriptionMessage[] = [];
          const ownerSubscribe = await RecordsSubscribe.create({
            filter : { protocol: protocolDefinition.protocol, protocolPath: 'note' },
            signer : Jws.createSigner(alice),
          });
          const recipientSubscribe = await RecordsSubscribe.create({
            filter : { protocol: protocolDefinition.protocol, protocolPath: 'note' },
            signer : Jws.createSigner(bob),
          });
          const anonymousSubscribe = await RecordsSubscribe.create({
            filter: { protocol: protocolDefinition.protocol, protocolPath: 'note', published: true },
          });
          expect((await dwn.processMessage(alice.did, ownerSubscribe.message, {
            subscriptionHandler: (message): void => { ownerReceived.push(message); },
          })).status.code).toBe(200);
          expect((await dwn.processMessage(alice.did, recipientSubscribe.message, {
            subscriptionHandler: (message): void => { recipientReceived.push(message); },
          })).status.code).toBe(200);
          expect((await dwn.processMessage(alice.did, anonymousSubscribe.message, {
            subscriptionHandler: (message): void => { anonymousReceived.push(message); },
          })).status.code).toBe(200);

          const grantAuthorizationSpy = sinon.spy(GrantAuthorization, 'performBaseValidation');
          const protocolAuthorizationSpy = sinon.spy(ProtocolAuthorization, 'authorizeQueryOrSubscribe');
          const write = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'note',
            published    : true,
          });
          expect((await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream })).status.code).toBe(202);

          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(ownerReceived.filter(message => message.type === 'event')).toHaveLength(1);
            expect(recipientReceived.filter(message => message.type === 'event')).toHaveLength(1);
            expect(anonymousReceived.filter(message => message.type === 'event')).toHaveLength(1);
          });
          expect(grantAuthorizationSpy.callCount).toBe(0);
          expect(protocolAuthorizationSpy.callCount).toBe(0);
        });
      });

      describe('cursor-based subscriptions', () => {
        it('should use EventLog catch-up when cursor is provided (no initial MessageStore query)', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // Read the EventLog to get the current cursor position before writing records.
          const { cursor: cursorBefore } = await eventLog.read(alice.did);

          // Write records before subscribing.
          const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://cursor-test' });
          const write1Reply = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
          expect(write1Reply.status.code).toBe(202);

          const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://cursor-test' });
          const write2Reply = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
          expect(write2Reply.status.code).toBe(202);

          // Subscribe with the cursor from before the writes. The handler takes the
          // EventLog catch-up path, replaying events through the subscription handler.
          const receivedEvents: RecordEvent[] = [];
          const subscriptionHandler: SubscriptionListener = (msg): void => { if (msg.type === 'event') { receivedEvents.push(msg.event as RecordEvent); } };
          const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : alice,
            filter : { schema: 'http://cursor-test' },
            cursor : cursorBefore,
          });

          const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler });
          expect(subReply.status.code).toBe(200);
          expect(subReply.subscription).toBeDefined();

          // In cursor mode, initial entries are NOT returned via the reply —
          // they come through the subscription handler as catch-up events.
          // The handler wraps SubscriptionListener→SubscriptionListener,
          // so we get plain RecordEvents (EOSE is silently consumed).
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
          });

          // Verify the catch-up events are our records.
          const recordIds = receivedEvents.map(e => (e.message as RecordsWriteMessage).recordId);
          expect(recordIds).toContain(write1.message.recordId);
          expect(recordIds).toContain(write2.message.recordId);
        });

        it('should receive live events after cursor catch-up', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // Write a record before subscribing.
          const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://cursor-live' });
          await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });

          // Read to get a cursor that includes write1's protocol config + the record.
          const { cursor: cursorAfterWrite1 } = await eventLog.read(alice.did);

          // Write another record that we'll want to catch up on.
          const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://cursor-live' });
          await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });

          const receivedEvents: RecordEvent[] = [];
          const subscriptionHandler: SubscriptionListener = (msg): void => { if (msg.type === 'event') { receivedEvents.push(msg.event as RecordEvent); } };
          const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : alice,
            filter : { schema: 'http://cursor-live' },
            cursor : cursorAfterWrite1,
          });
          const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler });
          expect(subReply.status.code).toBe(200);

          // Wait for catch-up event (write2).
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
          });

          // Write a live record after subscribing.
          const write3 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://cursor-live' });
          await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });

          // Wait for the live event.
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
          });

          const recordIds = receivedEvents.map(e => (e.message as RecordsWriteMessage).recordId);
          expect(recordIds).toContain(write2.message.recordId);
          expect(recordIds).toContain(write3.message.recordId);
        });

        it('should filter catch-up events when cursor and filter are provided', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // Get cursor before writing.
          const { cursor: cursorBefore } = await eventLog.read(alice.did);

          // Write records with different schemas.
          const matchWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://filter-match' });
          await dwn.processMessage(alice.did, matchWrite.message, { dataStream: matchWrite.dataStream });

          const noMatchWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'http://filter-other' });
          await dwn.processMessage(alice.did, noMatchWrite.message, { dataStream: noMatchWrite.dataStream });

          const receivedEvents: RecordEvent[] = [];
          const subscriptionHandler: SubscriptionListener = (msg): void => { if (msg.type === 'event') { receivedEvents.push(msg.event as RecordEvent); } };
          const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : alice,
            filter : { schema: 'http://filter-match' },
            cursor : cursorBefore,
          });
          const subReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler });
          expect(subReply.status.code).toBe(200);

          // Wait for catch-up events. Should only get the matching one.
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(receivedEvents).toHaveLength(1);
            expect((receivedEvents[0].message as RecordsWriteMessage).recordId).toBe(matchWrite.message.recordId);
          });
        });
      });

      it('should return 400 if protocol is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // subscribe for non-normalized protocol
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { protocol: 'example.com/' },
        });

        // overwrite protocol because #create auto-normalizes protocol
        recordsSubscribe.message.descriptor.filter.protocol = 'example.com/';

        // Re-create auth because we altered the descriptor after signing
        recordsSubscribe.message.authorization = await Message.createAuthorization({
          descriptor : recordsSubscribe.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records subscribe message
        const reply = await dwn.processMessage(alice.did, recordsSubscribe.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.UrlProtocolNotNormalized);
      });

      it('should return 400 if schema is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // subscribe for non-normalized schema
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'example.com/' },
        });

        // overwrite schema because #create auto-normalizes schema
        recordsSubscribe.message.descriptor.filter.schema = 'example.com/';

        // Re-create auth because we altered the descriptor after signing
        recordsSubscribe.message.authorization = await Message.createAuthorization({
          descriptor : recordsSubscribe.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records subscribe message
        const reply = await dwn.processMessage(alice.did, recordsSubscribe.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.UrlSchemaNotNormalized);
      });

      it('should return 400 if published is set to false and a datePublished range is provided', async () => {
        const fromDatePublished = Time.getCurrentTimestamp();
        const alice = await TestDataGenerator.generateDidKeyPersona();
        // set to true so create does not fail
        const recordSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { datePublished: { from: fromDatePublished }, published: true }
        });

        // set to false
        recordSubscribe.message.descriptor.filter.published = false;
        const subscribeResponse = await dwn.processMessage(alice.did, recordSubscribe.message);
        expect(subscribeResponse.status.code).toBe(400);
        expect(subscribeResponse.status.detail).toContain('descriptor/filter/published: must be equal to one of the allowed values');
      });

      it('should return 401 for anonymous subscriptions that filter explicitly for unpublished records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // create an unpublished record
        const draftWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'post' });
        const draftWriteReply = await dwn.processMessage(alice.did, draftWrite.message, { dataStream: draftWrite.dataStream });
        expect(draftWriteReply.status.code).toBe(202);

        // validate that alice can subscribe
        const unpublishedPostSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: alice, filter: { schema: 'post', published: false } });
        const unpublishedPostReply = await dwn.processMessage(alice.did, unpublishedPostSubscribe.message, { subscriptionHandler: () => {} });
        expect(unpublishedPostReply.status.code).toBe(200);
        expect(unpublishedPostReply.subscription).toBeDefined();

        // anonymous subscribe for unpublished records
        const unpublishedAnonymous = await RecordsSubscribe.create({ filter: { schema: 'post', published: false } });
        const anonymousPostReply = await dwn.processMessage(alice.did, unpublishedAnonymous.message);
        expect(anonymousPostReply.status.code).toBe(401);
        expect(anonymousPostReply.status.detail).toContain('Missing JWS');
        expect(anonymousPostReply.subscription).toBeUndefined();
      });

      it('should subscribe to unpublished records authorized by permissionGrantId', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const { message: unpublished, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, unpublished, { dataStream });
        expect(writeReply.status.code).toBe(202);

        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface    : DwnInterfaceName.Records,
            method       : DwnMethodName.Read,
            protocol     : 'http://test-protocol.xyz',
            protocolPath : 'testRecord',
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        const subscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : bob,
          filter : {
            protocol     : 'http://test-protocol.xyz',
            protocolPath : 'testRecord',
            published    : false,
          },
          permissionGrantId: permissionGrant.recordsWrite.message.recordId,
        });

        const reply = await dwn.processMessage(alice.did, subscribe.message, { subscriptionHandler: () => {} });
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.map(entry => entry.recordId)).toEqual([unpublished.recordId]);
        await reply.subscription!.close();
      });

      it('should reject permissionGrantId subscribes with filters outside the grant scope', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface    : DwnInterfaceName.Records,
            method       : DwnMethodName.Read,
            protocol     : 'http://test-protocol.xyz',
            protocolPath : 'testRecord',
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        for (const filter of [
          { published: false },
          { protocol: 'http://other-protocol.xyz', protocolPath: 'testRecord', published: false },
        ]) {
          const subscribe = await TestDataGenerator.generateRecordsSubscribe({
            author            : bob,
            filter,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });

          const reply = await dwn.processMessage(alice.did, subscribe.message, { subscriptionHandler: () => {} });
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationQueryOrSubscribeProtocolScopeMismatch);
          expect(reply.subscription).toBeUndefined();
        }
      });

      it('should return 401 if signature check fails', async () => {
        const { author, message } = await TestDataGenerator.generateRecordsSubscribe();
        const tenant = author!.did;

        // setting up a stub did resolver & message store
        // intentionally not supplying the public key so a different public key is generated to simulate invalid signature
        const mismatchingPersona = await TestDataGenerator.generatePersona({ did: author!.did, keyId: author!.keyId });
        const didResolver = TestStubGenerator.createDidResolverStub(mismatchingPersona);
        const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
        const eventLogStub = sinon.createStubInstance(DurableEventLog);

        const recordsSubscribeHandler = new RecordsSubscribeHandler({
          didResolver, messageStore          : messageStoreStub, eventLog              : eventLogStub,
          validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub }),
        });
        const reply = await recordsSubscribeHandler.handle({ tenant, message, subscriptionHandler: () => {} });

        expect(reply.status.code).toBe(401);
      });

      it('should return 400 if fail parsing the message', async () => {
        const { author, message } = await TestDataGenerator.generateRecordsSubscribe();
        const tenant = author!.did;

        // setting up a stub method resolver & message store
        const didResolver = TestStubGenerator.createDidResolverStub(author!);
        const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
        const eventLogStub = sinon.createStubInstance(DurableEventLog);
        const recordsSubscribeHandler = new RecordsSubscribeHandler({
          didResolver, messageStore          : messageStoreStub, eventLog              : eventLogStub,
          validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub }),
        });

        // stub the `parse()` function to throw an error
        sinon.stub(RecordsSubscribe, 'parse').throws('anyError');
        const reply = await recordsSubscribeHandler.handle({ tenant, message, subscriptionHandler: () => {} });

        expect(reply.status.code).toBe(400);
      });

      describe('protocol based subscriptions', () => {
        it('does not try protocol authorization if protocolRole is not invoked', async () => {
          // scenario:
          //           Bob and Carol subscribe to a chat protocol without invoking a protocolRole,
          //           they should receive chat messages addressed to them, respectively.
          //           Alice creates a thread and writes some chat messages to Bob and Carol.
          //           Bob receives only the chat messages addressed to him, Carol receives only the chat messages addressed to her.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const carol = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          const bobMessages: string[] = [];
          const handleForBob = async (msg: SubscriptionMessage): Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            const messageCid = await Message.getCid(message);
            bobMessages.push(messageCid);
          };

          const bobSubscription = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              published : false,
              protocol  : protocolDefinition.protocol,
            }
          });
          const subscriptionReply = await dwn.processMessage(alice.did, bobSubscription.message, { subscriptionHandler: handleForBob });
          expect(subscriptionReply.status.code).toBe(200);
          expect(subscriptionReply.subscription).toBeDefined();

          const carolMessages: string[] = [];
          const handleForCarol = async (msg: SubscriptionMessage): Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            const messageCid = await Message.getCid(message);
            carolMessages.push(messageCid);
          };

          const carolSubscription = await TestDataGenerator.generateRecordsSubscribe({
            author : carol,
            filter : {
              published : false,
              protocol  : protocolDefinition.protocol,
            }
          });
          const carolSubscriptionReply = await dwn.processMessage(alice.did, carolSubscription.message, { subscriptionHandler: handleForCarol });
          expect(carolSubscriptionReply.status.code).toBe(200);
          expect(carolSubscriptionReply.subscription).toBeDefined();

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          // Alice writes one 'chat' record addressed to Bob
          const chatRecordForBob = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/chat',
            published       : false,
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
          });
          const chatRecordForBobReply = await dwn.processMessage(alice.did, chatRecordForBob.message, { dataStream: chatRecordForBob.dataStream });
          expect(chatRecordForBobReply.status.code).toBe(202);
          const chatRecordForBobCid = await Message.getCid(chatRecordForBob.message);

          // Alice writes two 'chat' records addressed to Carol
          const chatRecordForCarol1 = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : carol.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/chat',
            published       : false,
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob cannot read this'),
          });
          const chatRecordForCarol1Reply = await dwn.processMessage(
            alice.did,
            chatRecordForCarol1.message,
            { dataStream: chatRecordForCarol1.dataStream }
          );
          expect(chatRecordForCarol1Reply.status.code).toBe(202);
          const chatRecordForCarol1Cid = await Message.getCid(chatRecordForCarol1.message);

          const chatRecordForCarol2 = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : carol.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/chat',
            published       : false,
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob cannot read this either'),
          });
          const chatRecordForCarol2Reply = await dwn.processMessage(
            alice.did,
            chatRecordForCarol2.message,
            { dataStream: chatRecordForCarol2.dataStream }
          );
          expect(chatRecordForCarol2Reply.status.code).toBe(202);
          const chatRecordForCarol2Cid = await Message.getCid(chatRecordForCarol2.message);

          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(bobMessages).toHaveLength(1);
            expect(bobMessages).toEqual(expect.arrayContaining([ chatRecordForBobCid ]));
          });

          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(carolMessages).toHaveLength(2);
            expect(carolMessages).toEqual(expect.arrayContaining([ chatRecordForCarol1Cid, chatRecordForCarol2Cid ]));
          });
        });

        it('allows root-level role authorized subscriptions', async () => {
          // scenario: Alice creates a thread and writes some chat messages writes a chat message. Bob invokes his
          //           thread member role in order to subscribe to the chat messages.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const carol = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          const filter: RecordsFilter = {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'chat'
          };

          const noRoleRecords: Set<string> = new Set();
          const addNoRole = async (msg: SubscriptionMessage): Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            if (message.descriptor.method === DwnMethodName.Write) {
              noRoleRecords.add((message as RecordsWriteMessage).recordId);
            } else {
              noRoleRecords.delete((message as RecordsDeleteMessage).descriptor.recordId);
            }
          };

          // subscribe without role, expect no messages
          const noRoleSubscription = await TestDataGenerator.generateRecordsSubscribe({
            author: bob,
            filter
          });

          const subscriptionReply = await dwn.processMessage(alice.did, noRoleSubscription.message, { subscriptionHandler: addNoRole });
          expect(subscriptionReply.status.code).toBe(200);
          expect(subscriptionReply.subscription).toBeDefined();

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const friendRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'friend',
            data         : new TextEncoder().encode('Bob is my friend'),
          });
          const friendRoleReply = await dwn.processMessage(alice.did, friendRoleRecord.message, { dataStream: friendRoleRecord.dataStream });
          expect(friendRoleReply.status.code).toBe(202);

          const recordIds: Set<string> = new Set();
          const addRecord:SubscriptionListener = async (msg) => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            if (message.descriptor.method === DwnMethodName.Write) {
              recordIds.add((message as RecordsWriteMessage).recordId);
            } else {
              recordIds.delete((message as RecordsDeleteMessage).descriptor.recordId);
            }
          };

          // subscribe with friend role
          const bobSubscriptionWithRole = await TestDataGenerator.generateRecordsSubscribe({
            filter,
            author       : bob,
            protocolRole : 'friend',
          });

          const subscriptionWithRoleReply = await dwn.processMessage(alice.did, bobSubscriptionWithRole.message, { subscriptionHandler: addRecord });
          expect(subscriptionWithRoleReply.status.code).toBe(200);
          expect(subscriptionWithRoleReply.subscription).toBeDefined();

          // Create one chat message for Bob as a control to show up in the `noRoleRecords` array
          const chatRecordForBob = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'chat',
            published    : false,
            data         : new TextEncoder().encode('Bob can read this cuz he is my friend'),
          });
          const chatRecordForBobReply = await dwn.processMessage(alice.did, chatRecordForBob.message, { dataStream: chatRecordForBob.dataStream });
          expect(chatRecordForBobReply.status.code).toBe(202);

          // Alice writes three more 'chat' records for carol, Bob's friend role should allow him to see these messages.
          const chatRecordIds: string[] = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : carol.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              published    : false,
              data         : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // there should only be the control message for bob in the subscription without a friend role.
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(noRoleRecords.size).toBe(1);
            expect([ ...noRoleRecords ]).toEqual(expect.arrayContaining([chatRecordForBob.message.recordId]));
          });

          // All chats should be in the subscription with the friend role.
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(recordIds.size).toBe(4);
            expect([ ...recordIds ]).toEqual(expect.arrayContaining([ chatRecordForBob.message.recordId, ...chatRecordIds ]));
          });

          // TODO: https://github.com/enboxorg/enbox/issues/759
          //      When `RecordsSubscribeHandler` builds up the matchFilters there are no matching filters for a delete within a context
          //      so the delete event is not being captured by the subscription handler. This is likely due to some of the filters including
          //      `published: false` which is a mutable property and not included with the delete event
          //
          //      When the issue is resolved, uncomment the code below

          // Delete a chat message for Bob
          // const chatForBobDelete = await TestDataGenerator.generateRecordsDelete({
          //   author       : alice,
          //   recordId     : chatRecordForBob.message.recordId,
          // });
          // const chatForBobDeleteReply = await dwn.processMessage(alice.did, chatForBobDelete.message);
          // expect(chatForBobDeleteReply.status.code).toBe(202);

          // // Delete one of the other chat messages
          // const chatForCarolDelete = await TestDataGenerator.generateRecordsDelete({
          //   author       : alice,
          //   recordId     : chatRecordIds[0],
          // });
          // const chatForCarolDeleteReply = await dwn.processMessage(alice.did, chatForCarolDelete.message);
          // expect(chatForCarolDeleteReply.status.code).toBe(202);

          // await Poller.pollUntilSuccessOrTimeout(async () => {
          //   expect(noRoleRecords.size).toBe(0); // chat record was removed from the set
          //   expect(recordIds.size).toBe(2); // both chat records were removed from the set
          //   expect([ ...recordIds ]).toEqual(expect.arrayContaining([ ...chatRecordIds.slice(1) ])); // only the last two chat records remain
          // });
        });

        it('can authorize subscriptions using a context role', async () => {
          // scenario: Alice writes some chat messages.
          //           Bob, having a thread/participant record, can subscribe to the chat.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          const filter: RecordsFilter = {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread/chat',
            contextId    : threadRecord.message.contextId,
          };

          const noRoleRecords: string[] = [];
          const addNoRole = async (msg: SubscriptionMessage): Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            if ( message.descriptor.method === DwnMethodName.Write) {
              const recordsWriteMessage = message as RecordsWriteMessage;
              noRoleRecords.push(recordsWriteMessage.recordId);
            }
          };

          // subscribe without role, expect no messages
          const noRoleSubscription = await TestDataGenerator.generateRecordsSubscribe({
            author: bob,
            filter
          });

          const subscriptionReply = await dwn.processMessage(alice.did, noRoleSubscription.message, { subscriptionHandler: addNoRole });
          expect(subscriptionReply.status.code).toBe(200);
          expect(subscriptionReply.subscription).toBeDefined();

          // Alice writes a 'participant' role record with Bob as recipient
          const participantRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/participant',
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob is my friend'),
          });
          const participantRoleReply =
            await dwn.processMessage(alice.did, participantRoleRecord.message, { dataStream: participantRoleRecord.dataStream });
          expect(participantRoleReply.status.code).toBe(202);

          const recordIds: string[] = [];
          const addRecord:SubscriptionListener = async (msg) => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            if (message.descriptor.method === DwnMethodName.Write) {
              const recordsWriteMessage = message as RecordsWriteMessage;
              recordIds.push(recordsWriteMessage.recordId);
            }
          };

          // subscribe with the participant role
          const bobSubscriptionWithRole = await TestDataGenerator.generateRecordsSubscribe({
            filter,
            author       : bob,
            protocolRole : 'thread/participant',
          });

          const subscriptionWithRoleReply = await dwn.processMessage(alice.did, bobSubscriptionWithRole.message, { subscriptionHandler: addRecord });
          expect(subscriptionWithRoleReply.status.code).toBe(200);
          expect(subscriptionWithRoleReply.subscription).toBeDefined();

          // Alice writes three 'chat' records
          const chatRecordIds: string[] = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              published       : false,
              parentContextId : threadRecord.message.contextId,
              data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          await Poller.pollUntilSuccessOrTimeout(async () => {
            // should have all chat messages.
            expect(recordIds).toEqual(expect.arrayContaining(chatRecordIds));

            // there should not be any messages in the subscription without a participant role.
            expect(noRoleRecords).toHaveLength(0);
          });
        });

        it('does not execute protocol subscriptions where protocolPath is missing from the filter', async () => {
          // scenario: Alice assigns Bob a friend role and writes some chat messages. Bob invokes his role to subscribe those messages,
          //           but his subscription filter does not include protocolPath.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const friendRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'friend',
            data         : new TextEncoder().encode('Bob is my friend'),
          });
          const friendRoleReply = await dwn.processMessage(alice.did, friendRoleRecord.message, { dataStream: friendRoleRecord.dataStream });
          expect(friendRoleReply.status.code).toBe(202);

          // Bob invokes his friendRole to subscribe but does not have `protocolPath` in the filter
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol: protocolDefinition.protocol,
              // protocolPath deliberately omitted
            },
            protocolRole: 'friend',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).toBe(400);
          expect(chatSubscribeReply.status.detail).toContain(DwnErrorCode.RecordsSubscribeFilterMissingRequiredProperties);
          expect(chatSubscribeReply.subscription).toBeUndefined();
        });

        it('does not execute context role authorized subscriptions where contextId is missing from the filter', async () => {
          // scenario: Alice gives Bob a role allowing him to access a particular chat thread.
          //           But Bob's filter does not contain a contextId so the subscription fails.
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const participantRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/participant',
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob is my friend'),
          });
          const participantRoleReply =
            await dwn.processMessage(alice.did, participantRoleRecord.message, { dataStream: participantRoleRecord.dataStream });
          expect(participantRoleReply.status.code).toBe(202);

          // Bob invokes his thread participant role to subscribe but omits the contextId
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/chat',
              // contextId deliberately omitted
            },
            protocolRole: 'thread/participant',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).toBe(400);
          expect(chatSubscribeReply.status.detail).toContain(DwnErrorCode.RecordsSubscribeNestedProtocolPathContextIdInvalid);
          expect(chatSubscribeReply.subscription).toBeUndefined();
        });

        it('rejects root-filter subscriptions that invoke a nested role without a contextId', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          const threadSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread',
            },
            protocolRole: 'thread/participant',
          });

          const threadSubscribeReply = await dwn.processMessage(alice.did, threadSubscribe.message);
          expect(threadSubscribeReply.status.code).toBe(401);
          expect(threadSubscribeReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMissingContextId);
          expect(threadSubscribeReply.subscription).toBeUndefined();
        });

        it('rejects role authorized subscriptions if the request author does not have a matching root-level role', async () => {
          // scenario: Alice installs a chat protocol.
          // Bob invokes a root-level role within that protocol to subscribe but fails because he does not actually have a role.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Bob invokes a friendRole he does not have to subscribe to the records
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
            },
            protocolRole: 'friend',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).toBe(401);
          expect(chatSubscribeReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
          expect(chatSubscribeReply.subscription).toBeUndefined();
        });

        it('rejects role authorized subscriptions where the subscription author does not have a matching context role', async () => {

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          // Bob invokes his a `thread/participant` role which he does not have to subscribe to the records
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/chat',
              contextId    : threadRecord.message.contextId,
            },
            protocolRole: 'thread/participant',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).toBe(401);
          expect(chatSubscribeReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
          expect(chatSubscribeReply.subscription).toBeUndefined();
        });

        describe('who-based query/subscribe action rules', () => {
          const whoSubscribeProtocol: ProtocolDefinition = {
            published : true,
            protocol  : 'http://who-subscribe-test.xyz',
            types     : {
              message: {
                dataFormats: ['text/plain'],
              },
            },
            structure: {
              message: {
                $actions: [
                  { who: 'anyone', can: ['create'] },
                  { who: 'author', of: 'message', can: ['read'] },
                  { who: 'recipient', of: 'message', can: ['read'] },
                ],
              },
            },
          };

          it('recipient receives only events for records addressed to them', async () => {
            // scenario: Bob and Carol each subscribe to Alice's DWN. Alice writes messages
            //           to Bob and Carol. Each subscriber only receives their own messages.
            //           Dave subscribes and receives nothing.
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const carol = await TestDataGenerator.generateDidKeyPersona();
            const dave = await TestDataGenerator.generateDidKeyPersona();

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : whoSubscribeProtocol,
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Bob subscribes — no role
            const bobRecordIds: Set<string> = new Set();
            const bobHandler: SubscriptionListener = async (msg): Promise<void> => {
              if (msg.type !== 'event') { return; }
              const { message } = msg.event;
              if (message.descriptor.method === DwnMethodName.Write) {
                bobRecordIds.add((message as RecordsWriteMessage).recordId);
              }
            };

            const bobSub = await TestDataGenerator.generateRecordsSubscribe({
              author : bob,
              filter : {
                published : false,
                protocol  : whoSubscribeProtocol.protocol,
              },
            });
            const bobSubReply = await dwn.processMessage(alice.did, bobSub.message, { subscriptionHandler: bobHandler });
            expect(bobSubReply.status.code).toBe(200);

            // Carol subscribes — no role
            const carolRecordIds: Set<string> = new Set();
            const carolHandler: SubscriptionListener = async (msg): Promise<void> => {
              if (msg.type !== 'event') { return; }
              const { message } = msg.event;
              if (message.descriptor.method === DwnMethodName.Write) {
                carolRecordIds.add((message as RecordsWriteMessage).recordId);
              }
            };

            const carolSub = await TestDataGenerator.generateRecordsSubscribe({
              author : carol,
              filter : {
                published : false,
                protocol  : whoSubscribeProtocol.protocol,
              },
            });
            const carolSubReply = await dwn.processMessage(alice.did, carolSub.message, { subscriptionHandler: carolHandler });
            expect(carolSubReply.status.code).toBe(200);

            // Dave subscribes — no role, not a participant at all
            const daveRecordIds: Set<string> = new Set();
            const daveHandler: SubscriptionListener = async (msg): Promise<void> => {
              if (msg.type !== 'event') { return; }
              const { message } = msg.event;
              if (message.descriptor.method === DwnMethodName.Write) {
                daveRecordIds.add((message as RecordsWriteMessage).recordId);
              }
            };

            const daveSub = await TestDataGenerator.generateRecordsSubscribe({
              author : dave,
              filter : {
                published : false,
                protocol  : whoSubscribeProtocol.protocol,
              },
            });
            const daveSubReply = await dwn.processMessage(alice.did, daveSub.message, { subscriptionHandler: daveHandler });
            expect(daveSubReply.status.code).toBe(200);

            // Alice writes 2 messages for Bob
            const expectedBobIds: string[] = [];
            for (let i = 0; i < 2; i++) {
              const msg = await TestDataGenerator.generateRecordsWrite({
                author       : alice,
                recipient    : bob.did,
                protocol     : whoSubscribeProtocol.protocol,
                protocolPath : 'message',
                published    : false,
                dataFormat   : 'text/plain',
                data         : new TextEncoder().encode(`for bob ${i}`),
              });
              const reply = await dwn.processMessage(alice.did, msg.message, { dataStream: msg.dataStream });
              expect(reply.status.code).toBe(202);
              expectedBobIds.push(msg.message.recordId);
            }

            // Alice writes 1 message for Carol
            const carolMsg = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : carol.did,
              protocol     : whoSubscribeProtocol.protocol,
              protocolPath : 'message',
              published    : false,
              dataFormat   : 'text/plain',
              data         : new TextEncoder().encode('for carol'),
            });
            const carolWriteReply = await dwn.processMessage(alice.did, carolMsg.message, { dataStream: carolMsg.dataStream });
            expect(carolWriteReply.status.code).toBe(202);

            // Alice writes 1 message addressed to herself (nobody else should see it)
            const aliceMsg = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : whoSubscribeProtocol.protocol,
              protocolPath : 'message',
              published    : false,
              dataFormat   : 'text/plain',
              data         : new TextEncoder().encode('private'),
            });
            const aliceWriteReply = await dwn.processMessage(alice.did, aliceMsg.message, { dataStream: aliceMsg.dataStream });
            expect(aliceWriteReply.status.code).toBe(202);

            // Bob should receive exactly 2 events
            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(bobRecordIds.size).toBe(2);
              expect([...bobRecordIds]).toEqual(expect.arrayContaining(expectedBobIds));
            });

            // Carol should receive exactly 1 event
            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(carolRecordIds.size).toBe(1);
              expect([...carolRecordIds]).toEqual(expect.arrayContaining([carolMsg.message.recordId]));
            });

            // Dave should receive zero events
            // Give a small window for any stray events to arrive, then assert empty
            await sleep(200);
            expect(daveRecordIds.size).toBe(0);
          });

          it('who-based subscribe rules do not grant role-like broad access', async () => {
            // scenario: Dave tries to invoke a protocolRole on a protocol with who-based
            //           subscribe rules. Should be rejected because he has no role record.
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const dave = await TestDataGenerator.generateDidKeyPersona();

            const mixedProtocol: ProtocolDefinition = {
              published : true,
              protocol  : 'http://mixed-sub-test.xyz',
              types     : {
                thread      : {},
                participant : {},
                chat        : { dataFormats: ['text/plain'] },
              },
              structure: {
                thread: {
                  participant: {
                    $role: true,
                  },
                  chat: {
                    $actions: [
                      { who: 'anyone', can: ['create'] },
                      { who: 'recipient', of: 'thread/chat', can: ['read'] },
                      { role: 'thread/participant', can: ['read'] },
                    ],
                  },
                },
              },
            };

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : mixedProtocol,
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice creates a thread
            const threadRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : mixedProtocol.protocol,
              protocolPath : 'thread',
            });
            const threadReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
            expect(threadReply.status.code).toBe(202);

            // Dave tries to subscribe with a role he doesn't have — should be rejected
            const daveRoleSub = await TestDataGenerator.generateRecordsSubscribe({
              author : dave,
              filter : {
                protocol     : mixedProtocol.protocol,
                protocolPath : 'thread/chat',
                contextId    : threadRecord.message.contextId,
              },
              protocolRole: 'thread/participant',
            });
            const daveRoleSubReply = await dwn.processMessage(alice.did, daveRoleSub.message);
            expect(daveRoleSubReply.status.code).toBe(401);
            expect(daveRoleSubReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
            expect(daveRoleSubReply.subscription).toBeUndefined();
          });
        });
      });
    });
  });
}
