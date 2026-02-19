import type { DidResolver } from '@enbox/dids';
import type { DataStore, MessageStore, ProtocolDefinition, ResumableTaskStore, StateIndex } from '../../src/index.js';
import type { EventStream, MessageEvent } from '../../src/types/subscriptions.js';

import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { MessagesSubscribe } from '../../src/interfaces/messages-subscribe.js';
import { MessagesSubscribeHandler } from '../../src/handlers/messages-subscribe.js';
import { Poller } from '../utils/poller.js';
import sinon from 'sinon';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventStream } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from '../../src/index.js';

export function testMessagesSubscribeHandler(): void {
  describe('MessagesSubscribe.handle()', () => {

    describe('EventStream disabled',() => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let dataStore: DataStore;
      let resumableTaskStore: ResumableTaskStore;
      let stateIndex: StateIndex;
      let dwn: Dwn;

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      beforeAll(async () => {
        didResolver = new UniversalResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        resumableTaskStore = stores.resumableTaskStore;
        stateIndex = stores.stateIndex;

        dwn = await Dwn.create({
          didResolver,
          messageStore,
          dataStore,
          resumableTaskStore,
          stateIndex,
        });

      });


      beforeEach(async () => {
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
        await stateIndex.clear();
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('should respond with a 501 if subscriptions are not supported', async () => {
        await dwn.close(); // close the original dwn instance
        dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, resumableTaskStore }); // leave out eventStream

        const alice = await TestDataGenerator.generateDidKeyPersona();
        // attempt to subscribe
        const { message } = await MessagesSubscribe.create({ signer: Jws.createSigner(alice) });
        const subscriptionMessageReply = await dwn.processMessage(alice.did, message, { subscriptionHandler: (_) => {} });
        expect(subscriptionMessageReply.status.code).toBe(501);
        expect(subscriptionMessageReply.status.detail).toContain(DwnErrorCode.MessagesSubscribeEventStreamUnimplemented);
      });
    });

    describe('EventStream enabled', () => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let dataStore: DataStore;
      let resumableTaskStore: ResumableTaskStore;
      let stateIndex: StateIndex;
      let eventStream: EventStream;
      let dwn: Dwn;

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      beforeAll(async () => {
        didResolver = new UniversalResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        resumableTaskStore = stores.resumableTaskStore;
        stateIndex = stores.stateIndex;
        eventStream = TestEventStream.get();

        dwn = await Dwn.create({
          didResolver,
          messageStore,
          dataStore,
          resumableTaskStore,
          stateIndex,
          eventStream,
        });

      });

      beforeEach(async () => {
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
        await stateIndex.clear();
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('returns a 400 if message is invalid', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateMessagesSubscribe({ author: alice });

        // add an invalid property to the descriptor
        (message['descriptor'] as any)['invalid'] = 'invalid';

        const messagesSubscribeHandler = new MessagesSubscribeHandler(didResolver, messageStore, eventStream);

        const reply = await messagesSubscribeHandler.handle({ tenant: alice.did, message, subscriptionHandler: (_) => {} });
        expect(reply.status.code).toBe(400);
      });


      it('should allow tenant to subscribe their own event stream', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // set up a promise to read later that captures the emitted messageCid
        let handler;
        const messageSubscriptionPromise: Promise<string> = new Promise((resolve) => {
          handler = async (event: MessageEvent):Promise<void> => {
            const { message } = event;
            const messageCid = await Message.getCid(message);
            resolve(messageCid);
          };
        });

        // testing MessagesSubscribe
        const messagesSubscribe = await MessagesSubscribe.create({
          signer: Jws.createSigner(alice),
        });
        const subscriptionReply = await dwn.processMessage(alice.did, messagesSubscribe.message, { subscriptionHandler: handler });
        expect(subscriptionReply.status.code).toBe(200);
        expect(subscriptionReply.subscription).toBeDefined();

        const messageWrite = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, messageWrite.message, { dataStream: messageWrite.dataStream });
        expect(writeReply.status.code).toBe(202);
        const messageCid = await Message.getCid(messageWrite.message);

        // control: ensure that the event exists
        const events = await stateIndex.getLeaves(alice.did, []);
        expect(events.length).toBe(1);
        expect(events[0]).toBe(messageCid);

        // await the event
        const resolvedCid = await messageSubscriptionPromise;
        expect(resolvedCid).toBe(messageCid);
      });

      it('should not allow non-tenant to subscribe to an event stream they are not authorized for', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // test anonymous request
        const anonymousSubscription = await TestDataGenerator.generateMessagesSubscribe();
        delete (anonymousSubscription.message as any).authorization;

        const anonymousReply = await dwn.processMessage(alice.did, anonymousSubscription.message);
        expect(anonymousReply.status.code).toBe(400);
        expect(anonymousReply.status.detail).toContain(`MessagesSubscribe: must have required property 'authorization'`);
        expect(anonymousReply.subscription).toBeUndefined();

        // testing MessagesSubscribe
        const messagesSubscribe = await MessagesSubscribe.create({
          signer: Jws.createSigner(bob),
        });

        const subscriptionReply = await dwn.processMessage(alice.did, messagesSubscribe.message);
        expect(subscriptionReply.status.code).toBe(401);
        expect(subscriptionReply.subscription).toBeUndefined();
      });

      describe('grant based subscribes', () => {
        it('allows subscribe of messages with matching interface and method grant scope', async () => {
          // scenario: Alice gives Bob permission to subscribe for all of her messages
          // Alice writes various messages
          // When Bob subscribes for messages, he should receive updates to all of Alice's messages

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // create grant that is scoped to `MessagesSubscribe` for bob
          const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Subscribe
            }
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          // create a handler to capture the emitted messageCids
          const messageCids: string[] = [];
          const handler = async (event: MessageEvent):Promise<void> => {
            const { message } = event;
            const messageCid = await Message.getCid(message);
            messageCids.push(messageCid);
          };

          // subscribe to messages
          const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({
            author            : bob,
            permissionGrantId : grantMessage.recordId,
          });

          const subscribeReply = await dwn.processMessage(alice.did, subscribeMessage, { subscriptionHandler: handler });
          expect(subscribeReply.status.code).toBe(200);

          // configure the freeForAll protocol
          const { message: freeForAllConfigure } = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : freeForAll,
          });
          const { status: freeForAllReplyStatus } = await dwn.processMessage(alice.did, freeForAllConfigure);
          expect(freeForAllReplyStatus.code).toBe(202);

          // configure a random protocol configuration
          const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
          });
          const { status: configureStatus } = await dwn.processMessage(alice.did, protocolMessage);
          expect(configureStatus.code).toBe(202);

          // write a message to the Records free for all interface
          const { message: recordMessage, dataStream: recordDataStream } = await TestDataGenerator.generateRecordsWrite({
            protocol     : freeForAll.protocol,
            protocolPath : 'post',
            schema       : freeForAll.types.post.schema,
            author       : alice
          });

          const recordReply = await dwn.processMessage(alice.did, recordMessage, { dataStream: recordDataStream });
          expect(recordReply.status.code).toBe(202);

          // write a random message
          const { message: randomMessage, dataStream: randomDataStream } = await TestDataGenerator.generateRecordsWrite({
            author: alice
          });
          const randomReply = await dwn.processMessage(alice.did, randomMessage, { dataStream: randomDataStream });
          expect(randomReply.status.code).toBe(202);

          // ensure that all messages have been received
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(messageCids.length).toBe(4);
            const expectedCids = [
              await Message.getCid(freeForAllConfigure),
              await Message.getCid(protocolMessage),
              await Message.getCid(recordMessage),
              await Message.getCid(randomMessage),
            ];
            expect(messageCids.sort()).toEqual(expectedCids.sort());
          });
        });

        it('rejects subscribe of messages with mismatching interface grant scope', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // create grant that is scoped to `RecordsWrite` for bob scoped to the `freeForAll` protocol
          const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              protocol  : freeForAll.protocol
            }
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          // bob attempts to use the `RecordsWrite` grant on an `MessagesSubscribe` message
          const { message: bobSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
            author            : bob,
            permissionGrantId : grantMessage.recordId
          });
          const bobReply = await dwn.processMessage(alice.did, bobSubscribe);
          expect(bobReply.status.code).toBe(401);
          expect(bobReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationInterfaceMismatch);
        });

        it('rejects subscribe of messages with mismatching method grant scopes', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // create grant that is scoped to `MessagesSync` for bob
          const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Sync,
            }
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          // bob attempts to use the `MessagesSync` grant on an `MessagesSubscribe` message
          const { message: bobSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
            author            : bob,
            permissionGrantId : grantMessage.recordId
          });
          const bobReply = await dwn.processMessage(alice.did, bobSubscribe);
          expect(bobReply.status.code).toBe(401);
          expect(bobReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationMethodMismatch);
        });

        describe('protocol filtered messages', () => {
          it('allows subscribe of protocol filtered messages with matching protocol grant scopes', async () => {

            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();

            // install protocol 1
            const protocol1: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://protcol1' };
            const { message: protocol1Configure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : protocol1,
            });
            const { status: protocol1ConfigureStatus } = await dwn.processMessage(alice.did, protocol1Configure);
            expect(protocol1ConfigureStatus.code).toBe(202);

            // install protocol 2
            const protocol2: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://protcol2' };
            const { message: protocol2Configure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : protocol2,
            });
            const { status: protocol2ConfigureStatus } = await dwn.processMessage(alice.did, protocol2Configure);
            expect(protocol2ConfigureStatus.code).toBe(202);

            // grant bob permission to subscribe for protocol 1
            const { message: grant1Message, dataStream: grant1DataStream } = await TestDataGenerator.generateGrantCreate({
              author    : alice,
              grantedTo : bob,
              scope     : {
                interface : DwnInterfaceName.Messages,
                method    : DwnMethodName.Subscribe,
                protocol  : protocol1.protocol
              }
            });

            const grant1Reply = await dwn.processMessage(alice.did, grant1Message, { dataStream: grant1DataStream });
            expect(grant1Reply.status.code).toBe(202);

            // bob uses the grant to subscribe to protocol 1 messages
            const proto1MessageCids: string[] = [];
            const proto1Handler = async (event: MessageEvent):Promise<void> => {
              const { message } = event;
              const messageCid = await Message.getCid(message);
              proto1MessageCids.push(messageCid);
            };

            const { message: bobSubscribe1 } = await TestDataGenerator.generateMessagesSubscribe({
              author            : bob,
              filters           : [{ protocol: protocol1.protocol }],
              permissionGrantId : grant1Message.recordId
            });
            const bobReply1 = await dwn.processMessage(alice.did, bobSubscribe1, { subscriptionHandler: proto1Handler });
            expect(bobReply1.status.code).toBe(200);

            const allMessages: string[] = [];
            const allHandler = async (event: MessageEvent):Promise<void> => {
              const { message } = event;
              const messageCid = await Message.getCid(message);
              allMessages.push(messageCid);
            };

            const { message: allSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
              author: alice,
            });
            const allReply = await dwn.processMessage(alice.did, allSubscribe, { subscriptionHandler: allHandler });
            expect(allReply.status.code).toBe(200);

            // alice writes a message to protocol 1
            const { message: proto1Message, dataStream: proto1DataStream } = await TestDataGenerator.generateRecordsWrite({
              protocol     : protocol1.protocol,
              protocolPath : 'post',
              schema       : protocol1.types.post.schema,
              author       : alice
            });
            const proto1Reply = await dwn.processMessage(alice.did, proto1Message, { dataStream: proto1DataStream });
            expect(proto1Reply.status.code).toBe(202);

            // alice writes a message to protocol 2
            const { message: proto2Message, dataStream: proto2DataStream } = await TestDataGenerator.generateRecordsWrite({
              protocol     : protocol2.protocol,
              protocolPath : 'post',
              schema       : protocol2.types.post.schema,
              author       : alice
            });
            const proto2Reply = await dwn.processMessage(alice.did, proto2Message, { dataStream: proto2DataStream });
            expect(proto2Reply.status.code).toBe(202);

            // ensure that all messages have been received as a control
            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(allMessages.length).toBe(2);
              const expectedAllCids = [
                await Message.getCid(proto1Message),
                await Message.getCid(proto2Message)
              ];
              expect(allMessages.sort()).toEqual(expectedAllCids.sort());

              // proto 1 messages should only have one message
              expect(proto1MessageCids.length).toBe(1);
              const expectedProto1Cids = [await Message.getCid(proto1Message)];
              expect(proto1MessageCids.sort()).toEqual(expectedProto1Cids.sort());
            });

          });

          it('rejects subscribe of protocol filtered messages with mismatching protocol grant scopes', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();

            // install protocol 1
            const protocol1: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://protcol1' };
            const { message: protocol1Configure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : protocol1,
            });
            const { status: protocol1ConfigureStatus } = await dwn.processMessage(alice.did, protocol1Configure);
            expect(protocol1ConfigureStatus.code).toBe(202);

            // install protocol 2
            const protocol2: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://protcol2' };
            const { message: protocol2Configure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : protocol2,
            });
            const { status: protocol2ConfigureStatus } = await dwn.processMessage(alice.did, protocol2Configure);
            expect(protocol2ConfigureStatus.code).toBe(202);

            // grant bob permission to subscribe for protocol 1
            const { message: grant1Message, dataStream: grant1DataStream } = await TestDataGenerator.generateGrantCreate({
              author    : alice,
              grantedTo : bob,
              scope     : {
                interface : DwnInterfaceName.Messages,
                method    : DwnMethodName.Subscribe,
                protocol  : protocol1.protocol
              }
            });

            const grant1Reply = await dwn.processMessage(alice.did, grant1Message, { dataStream: grant1DataStream });
            expect(grant1Reply.status.code).toBe(202);

            // bob uses the grant for protocol 1 to subscribe for protocol 2 messages
            const { message: bobSubscribe1 } = await TestDataGenerator.generateMessagesSubscribe({
              author            : bob,
              filters           : [{ protocol: protocol2.protocol }],
              permissionGrantId : grant1Message.recordId
            });
            const bobReply1 = await dwn.processMessage(alice.did, bobSubscribe1);
            expect(bobReply1.status.code).toBe(401);
            expect(bobReply1.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationMismatchedProtocol);
            expect(bobReply1.subscription).toBeUndefined();

            // bob attempts to use the grant for protocol 1 to subscribe to messages in protocol 1 OR protocol 2 given two filters
            // this should fail because the grant is scoped to protocol 1 only
            const { message: bobSubscribe2 } = await TestDataGenerator.generateMessagesSubscribe({
              author            : bob,
              filters           : [{ protocol: protocol1.protocol }, { protocol: protocol2.protocol }],
              permissionGrantId : grant1Message.recordId
            });
            const bobReply2 = await dwn.processMessage(alice.did, bobSubscribe2);
            expect(bobReply2.status.code).toBe(401);
            expect(bobReply2.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationMismatchedProtocol);
            expect(bobReply2.subscription).toBeUndefined();
          });
        });
      });
    });
  });
}
