import type { DidResolver } from '@enbox/dids';
import type { DataStore, MessageStore, ProtocolDefinition, ResumableTaskStore, StateIndex } from '../../src/index.js';
import type { EventLog, SubscriptionMessage } from '../../src/types/subscriptions.js';
import type { GenerateGrantCreateOutput, GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import sinon from 'sinon';

import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { MessagesGrantAuthorization } from '../../src/core/messages-grant-authorization.js';
import { MessagesSubscribe } from '../../src/interfaces/messages-subscribe.js';
import { MessagesSubscribeHandler } from '../../src/handlers/messages-subscribe.js';
import { Poller } from '../utils/poller.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { DataStream, DwnInterfaceName, DwnMethodName, PermissionGrant, PermissionsProtocol, Time } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testMessagesSubscribeHandler(): void {
  describe('MessagesSubscribe.handle()', () => {

    describe('EventLog disabled',() => {
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
        dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, resumableTaskStore }); // leave out eventLog

        const alice = await TestDataGenerator.generateDidKeyPersona();
        // attempt to subscribe
        const { message } = await MessagesSubscribe.create({ signer: Jws.createSigner(alice) });
        const subscriptionMessageReply = await dwn.processMessage(alice.did, message, { subscriptionHandler: (_) => {} });
        expect(subscriptionMessageReply.status.code).toBe(501);
        expect(subscriptionMessageReply.status.detail).toContain(DwnErrorCode.MessagesSubscribeEventLogUnimplemented);
      });
    });

    describe('EventLog enabled', () => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let dataStore: DataStore;
      let resumableTaskStore: ResumableTaskStore;
      let stateIndex: StateIndex;
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
        stateIndex = stores.stateIndex;
        eventLog = TestEventLog.get();
        eventLog = TestEventLog.get();

        dwn = await Dwn.create({
          didResolver,
          messageStore,
          dataStore,
          resumableTaskStore,
          stateIndex,
          eventLog,
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

        const messagesSubscribeHandler = new MessagesSubscribeHandler({
          didResolver, messageStore, eventLog,
        });

        const reply = await messagesSubscribeHandler.handle({ tenant: alice.did, message, subscriptionHandler: (_) => {} });
        expect(reply.status.code).toBe(400);
      });


      it('should allow tenant to subscribe their own event stream', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // set up a promise to read later that captures the emitted messageCid
        let handler;
        const messageSubscriptionPromise: Promise<string> = new Promise((resolve) => {
          handler = async (msg: SubscriptionMessage):Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
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
        expect(events.length).toBe(2);
        expect(events).toContain(messageCid);

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

      describe('cursor-based subscriptions', () => {
        it('should deliver catch-up events through the handler when cursor is provided', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // Read the EventLog to get a cursor before writing.
          const { cursor: cursorBefore } = await eventLog.read(alice.did);

          // Write a record before subscribing.
          const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice });
          const write1Reply = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
          expect(write1Reply.status.code).toBe(202);
          const write1Cid = await Message.getCid(write1.message);

          // Subscribe with cursor from before the write to catch up.
          const messageCids: string[] = [];
          const handler = async (msg: SubscriptionMessage): Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            const cid = await Message.getCid(message);
            messageCids.push(cid);
          };

          const { message: subMessage } = await TestDataGenerator.generateMessagesSubscribe({
            author : alice,
            cursor : cursorBefore,
          });
          const subReply = await dwn.processMessage(alice.did, subMessage, { subscriptionHandler: handler });
          expect(subReply.status.code).toBe(200);
          expect(subReply.subscription).toBeDefined();

          // Wait for the catch-up events.
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(messageCids.length).toBeGreaterThanOrEqual(1);
            expect(messageCids).toContain(write1Cid);
          });
        });

        it('should receive live events after cursor catch-up completes', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // Write before subscribing.
          const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice });
          await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });

          // Read to get cursor after write1.
          const { cursor: cursorAfterWrite1 } = await eventLog.read(alice.did);

          // Write another record that we'll catch up on.
          const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice });
          await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
          const write2Cid = await Message.getCid(write2.message);

          const messageCids: string[] = [];
          const handler = async (msg: SubscriptionMessage): Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            const cid = await Message.getCid(message);
            messageCids.push(cid);
          };

          const { message: subMessage } = await TestDataGenerator.generateMessagesSubscribe({
            author : alice,
            cursor : cursorAfterWrite1,
          });
          const subReply = await dwn.processMessage(alice.did, subMessage, { subscriptionHandler: handler });
          expect(subReply.status.code).toBe(200);

          // Wait for catch-up (write2).
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(messageCids).toContain(write2Cid);
          });

          // Write a live record.
          const write3 = await TestDataGenerator.generateRecordsWrite({ author: alice });
          await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
          const write3Cid = await Message.getCid(write3.message);

          // Wait for the live event.
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(messageCids).toContain(write3Cid);
          });
        });
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
              method    : DwnMethodName.Read
            }
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          // install the default test protocol used by generateRecordsWrite
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // create a handler to capture the emitted messageCids
          const messageCids: string[] = [];
          const handler = async (msg: SubscriptionMessage):Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            const messageCid = await Message.getCid(message);
            messageCids.push(messageCid);
          };

          // subscribe to messages
          const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({
            author             : bob,
            permissionGrantIds : [grantMessage.recordId],
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

        it('allows subscribe of messages with a unified MessagesRead grant scope', async () => {
          // scenario: A Messages.Read grant should also authorize MessagesSubscribe operations
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // create grant that is scoped to `MessagesRead` (unified) for bob
          const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
            }
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          // install the default test protocol used by generateRecordsWrite
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // create a handler to capture the emitted messageCids
          const messageCids: string[] = [];
          const handler = async (msg: SubscriptionMessage):Promise<void> => {
            if (msg.type !== 'event') { return; }
            const { message } = msg.event;
            const messageCid = await Message.getCid(message);
            messageCids.push(messageCid);
          };

          // bob subscribes to messages using the Messages.Read grant
          const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({
            author             : bob,
            permissionGrantIds : [grantMessage.recordId],
          });

          const subscribeReply = await dwn.processMessage(alice.did, subscribeMessage, { subscriptionHandler: handler });
          expect(subscribeReply.status.code).toBe(200);

          // install the freeForAll protocol and write a record to trigger events
          const { message: freeForAllConfigure } = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : freeForAll,
          });
          const { status: freeForAllReplyStatus } = await dwn.processMessage(alice.did, freeForAllConfigure);
          expect(freeForAllReplyStatus.code).toBe(202);

          const { message: recordMessage, dataStream: recordDataStream } = await TestDataGenerator.generateRecordsWrite({
            protocol     : freeForAll.protocol,
            protocolPath : 'post',
            schema       : freeForAll.types.post.schema,
            author       : alice
          });
          const recordReply = await dwn.processMessage(alice.did, recordMessage, { dataStream: recordDataStream });
          expect(recordReply.status.code).toBe(202);

          // ensure that at least one event was received
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(messageCids.length).toBeGreaterThanOrEqual(1);
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
            author             : bob,
            permissionGrantIds : [grantMessage.recordId]
          });
          const bobReply = await dwn.processMessage(alice.did, bobSubscribe);
          expect(bobReply.status.code).toBe(401);
          expect(bobReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationInterfaceMismatch);
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
                method    : DwnMethodName.Read,
                protocol  : protocol1.protocol
              }
            });

            const grant1Reply = await dwn.processMessage(alice.did, grant1Message, { dataStream: grant1DataStream });
            expect(grant1Reply.status.code).toBe(202);

            // bob uses the grant to subscribe to protocol 1 messages
            const proto1MessageCids: string[] = [];
            const proto1Handler = async (msg: SubscriptionMessage):Promise<void> => {
              if (msg.type !== 'event') { return; }
              const { message } = msg.event;
              const messageCid = await Message.getCid(message);
              proto1MessageCids.push(messageCid);
            };

            const { message: bobSubscribe1 } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocol1.protocol }],
              permissionGrantIds : [grant1Message.recordId]
            });
            const bobReply1 = await dwn.processMessage(alice.did, bobSubscribe1, { subscriptionHandler: proto1Handler });
            expect(bobReply1.status.code).toBe(200);

            const allMessages: string[] = [];
            const allHandler = async (msg: SubscriptionMessage):Promise<void> => {
              if (msg.type !== 'event') { return; }
              const { message } = msg.event;
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

          it('allows subscribe filters covered by a plural protocol grant set', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();

            const protocol1: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://plural-grant-subscribe-1' };
            const protocol2: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://plural-grant-subscribe-2' };

            for (const protocolDefinition of [protocol1, protocol2]) {
              const { message: protocolConfigure } = await TestDataGenerator.generateProtocolsConfigure({
                author: alice,
                protocolDefinition,
              });
              const protocolReply = await dwn.processMessage(alice.did, protocolConfigure);
              expect(protocolReply.status.code).toBe(202);
            }

            const permissionGrantIds: string[] = [];
            for (const protocolDefinition of [protocol1, protocol2]) {
              const { message: grantMessage, dataStream: grantDataStream } = await TestDataGenerator.generateGrantCreate({
                author    : alice,
                grantedTo : bob,
                scope     : {
                  interface : DwnInterfaceName.Messages,
                  method    : DwnMethodName.Read,
                  protocol  : protocolDefinition.protocol,
                }
              });
              const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream });
              expect(grantReply.status.code).toBe(202);
              permissionGrantIds.push(grantMessage.recordId);
            }

            const receivedMessageCids: string[] = [];
            const handler = async (msg: SubscriptionMessage):Promise<void> => {
              if (msg.type !== 'event') { return; }
              receivedMessageCids.push(await Message.getCid(msg.event.message));
            };

            const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocol1.protocol }, { protocol: protocol2.protocol }],
              permissionGrantIds : permissionGrantIds.reverse(),
            });
            const subscribeReply = await dwn.processMessage(alice.did, subscribeMessage, { subscriptionHandler: handler });
            expect(subscribeReply.status.code).toBe(200);

            const { message: protocol1Record, dataStream: protocol1DataStream } = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocol1.protocol,
              protocolPath : 'post',
              schema       : protocol1.types.post.schema,
            });
            await dwn.processMessage(alice.did, protocol1Record, { dataStream: protocol1DataStream });

            const { message: protocol2Record, dataStream: protocol2DataStream } = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocol2.protocol,
              protocolPath : 'post',
              schema       : protocol2.types.post.schema,
            });
            await dwn.processMessage(alice.did, protocol2Record, { dataStream: protocol2DataStream });

            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(receivedMessageCids.sort()).toEqual([
                await Message.getCid(protocol1Record),
                await Message.getCid(protocol2Record),
              ].sort());
            });

            expect(subscribeMessage.descriptor.permissionGrantIds).toEqual([...permissionGrantIds].sort());
          });

          it('rejects subscribe when any grant in a plural grant set is not granted to the author', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const carol = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://plural-grant-subscribe-wrong-grantee' };
            const { message: protocolConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition,
            });
            const protocolReply = await dwn.processMessage(alice.did, protocolConfigure);
            expect(protocolReply.status.code).toBe(202);

            const grantIds: string[] = [];
            for (const grantedTo of [bob, carol]) {
              const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
                author : alice,
                grantedTo,
                scope  : {
                  interface : DwnInterfaceName.Messages,
                  method    : DwnMethodName.Read,
                  protocol  : protocolDefinition.protocol,
                }
              });
              const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
              expect(grantReply.status.code).toBe(202);
              grantIds.push(grantMessage.recordId);
            }

            const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocolDefinition.protocol }],
              permissionGrantIds : grantIds,
            });

            const reply = await dwn.processMessage(alice.did, subscribeMessage);
            expect(reply.status.code).toBe(401);
            expect(reply.status.detail).toContain(DwnErrorCode.GrantAuthorizationNotGrantedToAuthor);
            expect(reply.subscription).toBeUndefined();
          });

          const createDelegatedProtocolSubscribe = async (
            protocol: string,
            options?: { dateExpires?: string },
          ): Promise<{
            alice: Persona;
            protocolDefinition: ProtocolDefinition;
            grant: GenerateGrantCreateOutput;
            received: SubscriptionMessage[];
          }> => {
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: true, protocol };

            const { message: protocolConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition,
            });
            expect((await dwn.processMessage(alice.did, protocolConfigure)).status.code).toBe(202);

            const grant = await TestDataGenerator.generateGrantCreate({
              author      : alice,
              grantedTo   : bob,
              dateExpires : options?.dateExpires,
              scope       : {
                interface : DwnInterfaceName.Messages,
                method    : DwnMethodName.Read,
                protocol  : protocolDefinition.protocol,
              },
            });
            expect((await dwn.processMessage(alice.did, grant.message, { dataStream: grant.dataStream })).status.code).toBe(202);

            const received: SubscriptionMessage[] = [];
            const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocolDefinition.protocol }],
              permissionGrantIds : [grant.message.recordId],
            });
            const subscribeReply = await dwn.processMessage(alice.did, subscribeMessage, {
              subscriptionHandler: (msg): void => { received.push(msg); },
            });
            expect(subscribeReply.status.code).toBe(200);

            return { alice, protocolDefinition, grant, received };
          };

          const writeProtocolPost = async (
            author: Persona,
            protocolDefinition: ProtocolDefinition,
          ): Promise<GenerateRecordsWriteOutput> => {
            const record = await TestDataGenerator.generateRecordsWrite({
              author,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'post',
              schema       : protocolDefinition.types.post.schema,
            });
            expect((await dwn.processMessage(author.did, record.message, { dataStream: record.dataStream })).status.code).toBe(202);
            return record;
          };

          it('stops delegated delivery when an invoked grant is revoked after subscribe opens', async () => {
            const { alice, protocolDefinition, grant, received } = await createDelegatedProtocolSubscribe('http://delegated-subscribe-revoked-delivery');
            await writeProtocolPost(alice, protocolDefinition);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(received.filter(msg => msg.type === 'event').length).toBe(1);
            });

            await Time.minimalSleep();
            const revocation = await PermissionsProtocol.createRevocation({
              signer : Jws.createSigner(alice),
              grant  : PermissionGrant.parse(grant.dataEncodedMessage),
            });
            expect((await dwn.processMessage(
              alice.did,
              revocation.recordsWrite.message,
              { dataStream: DataStream.fromBytes(revocation.permissionRevocationBytes) }
            )).status.code).toBe(202);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              const errorMessage = received.find(msg => msg.type === 'error');
              expect(errorMessage?.error.code).toBe(DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed);
              expect(received.filter(msg => msg.type === 'event').length).toBe(1);
            });
          });

          it('stops delegated delivery when an invoked grant expires after subscribe opens', async () => {
            const dateExpires = Time.createOffsetTimestamp({ seconds: 60 });
            const { alice, protocolDefinition, received } = await createDelegatedProtocolSubscribe(
              'http://delegated-subscribe-expired-delivery',
              { dateExpires }
            );

            await writeProtocolPost(alice, protocolDefinition);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(received.filter(msg => msg.type === 'event').length).toBe(1);
            });

            const secondRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'post',
              schema       : protocolDefinition.types.post.schema,
            });
            sinon.stub(Time, 'getCurrentTimestamp').returns(Time.createOffsetTimestamp({ seconds: 1 }, dateExpires));
            expect((await dwn.processMessage(alice.did, secondRecord.message, { dataStream: secondRecord.dataStream })).status.code).toBe(202);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              const errorMessage = received.find(msg => msg.type === 'error');
              expect(errorMessage?.error.code).toBe(DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed);
              expect(received.filter(msg => msg.type === 'event').length).toBe(1);
            });
          });

          it('delivers delegated events in cursor order when delivery authorization resolves out of order', async () => {
            const { alice, protocolDefinition, received } = await createDelegatedProtocolSubscribe('http://delegated-subscribe-ordered-delivery');

            let firstAuthorizationStarted!: () => void;
            let releaseFirstAuthorization!: () => void;
            const firstAuthorizationStartedPromise = new Promise<void>((resolve) => {
              firstAuthorizationStarted = resolve;
            });
            const releaseFirstAuthorizationPromise = new Promise<void>((resolve) => {
              releaseFirstAuthorization = resolve;
            });
            const deliveryAuthorizationStub = sinon.stub(MessagesGrantAuthorization, 'authorizeSubscribeDelivery');
            deliveryAuthorizationStub.onFirstCall().callsFake(async () => {
              firstAuthorizationStarted();
              await releaseFirstAuthorizationPromise;
            });
            deliveryAuthorizationStub.onSecondCall().resolves();

            await writeProtocolPost(alice, protocolDefinition);
            await firstAuthorizationStartedPromise;

            await writeProtocolPost(alice, protocolDefinition);

            await Time.minimalSleep();
            expect(received.filter(msg => msg.type === 'event').length).toBe(0);

            releaseFirstAuthorization();
            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(received.filter(msg => msg.type === 'event').length).toBe(2);
            });

            const eventPositions = received
              .filter((msg): msg is Extract<SubscriptionMessage, { type: 'event' }> => msg.type === 'event')
              .map(msg => BigInt(msg.cursor.position));
            expect(eventPositions[0] < eventPositions[1]).toBe(true);
          });

          it('emits one terminal error when multiple delegated deliveries fail concurrently', async () => {
            const { alice, protocolDefinition, received } = await createDelegatedProtocolSubscribe('http://delegated-subscribe-single-terminal-error');

            let releaseAuthorizationFailures!: () => void;
            const releaseAuthorizationFailuresPromise = new Promise<void>((resolve) => {
              releaseAuthorizationFailures = resolve;
            });
            sinon.stub(MessagesGrantAuthorization, 'authorizeSubscribeDelivery').callsFake(async () => {
              await releaseAuthorizationFailuresPromise;
              throw new Error('delivery authorization failed');
            });

            await writeProtocolPost(alice, protocolDefinition);
            await writeProtocolPost(alice, protocolDefinition);

            releaseAuthorizationFailures();
            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(received.filter(msg => msg.type === 'error').length).toBe(1);
            });
            await Time.minimalSleep();
            expect(received.filter(msg => msg.type === 'error').length).toBe(1);
            expect(received.filter(msg => msg.type === 'event').length).toBe(0);
          });

          it('does not run delivery grant checks for owner subscriptions', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://owner-subscribe-pass-through-delivery' };

            const { message: protocolConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition,
            });
            expect((await dwn.processMessage(alice.did, protocolConfigure)).status.code).toBe(202);

            const received: SubscriptionMessage[] = [];
            const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({
              author  : alice,
              filters : [{ protocol: protocolDefinition.protocol }],
            });
            const deliveryAuthorizationStub = sinon.stub(MessagesGrantAuthorization, 'authorizeSubscribeDelivery').rejects(new Error('owner path should not check grants'));
            const subscribeReply = await dwn.processMessage(alice.did, subscribeMessage, {
              subscriptionHandler: (msg): void => { received.push(msg); },
            });
            expect(subscribeReply.status.code).toBe(200);

            const record = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'post',
              schema       : protocolDefinition.types.post.schema,
            });
            expect((await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream })).status.code).toBe(202);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(received.filter(msg => msg.type === 'event').length).toBe(1);
            });
            expect(deliveryAuthorizationStub.callCount).toBe(0);
          });

          it('allows subscribe of protocolPathPrefix filtered messages including protocol metadata', async () => {
            // scenario: Alice installs a protocol with two paths (post, post/attachment).
            // She subscribes with a protocolPathPrefix filter for 'post'.
            // Expected behavior:
            //   - Both 'post' and 'post/attachment' records are received (prefix semantics)
            //   - The ProtocolsConfigure event IS also received (shadow filter for metadata)
            //   - Records from an unrelated protocol are NOT received

            const alice = await TestDataGenerator.generateDidKeyPersona();

            // subscribe with protocolPathPrefix filter for 'post' BEFORE installing
            // the protocol, so we can verify the ProtocolsConfigure event is received.
            const prefixMessageCids: string[] = [];
            const prefixHandler = async (msg: SubscriptionMessage):Promise<void> => {
              if (msg.type !== 'event') { return; }
              const { message } = msg.event;
              const messageCid = await Message.getCid(message);
              prefixMessageCids.push(messageCid);
            };

            const { message: prefixSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
              author  : alice,
              filters : [{ protocol: freeForAll.protocol, protocolPathPrefix: 'post' }],
            });
            const prefixReply = await dwn.processMessage(alice.did, prefixSubscribe, { subscriptionHandler: prefixHandler });
            expect(prefixReply.status.code).toBe(200);

            // install the freeForAll protocol — this ProtocolsConfigure event should
            // be received by the prefix subscription via the shadow metadata filter.
            const { message: freeForAllConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : freeForAll,
            });
            const { status: freeForAllReplyStatus } = await dwn.processMessage(alice.did, freeForAllConfigure);
            expect(freeForAllReplyStatus.code).toBe(202);

            // install a second unrelated protocol — its ProtocolsConfigure should NOT
            // be received by the prefix subscription.
            const unrelatedProtocol: ProtocolDefinition = { ...freeForAll, protocol: 'http://unrelated-protocol' };
            const { message: unrelatedConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : unrelatedProtocol,
            });
            const { status: unrelatedReplyStatus } = await dwn.processMessage(alice.did, unrelatedConfigure);
            expect(unrelatedReplyStatus.code).toBe(202);

            // write a record at 'post' path
            const { message: postMessage, dataStream: postDataStream } = await TestDataGenerator.generateRecordsWrite({
              protocol     : freeForAll.protocol,
              protocolPath : 'post',
              schema       : freeForAll.types.post.schema,
              author       : alice,
            });
            const postWriteReply = await dwn.processMessage(alice.did, postMessage, { dataStream: postDataStream });
            expect(postWriteReply.status.code).toBe(202);

            // write a record at 'post/attachment' path (child of a post)
            const { message: attachmentMessage, dataStream: attachmentDataStream } = await TestDataGenerator.generateRecordsWrite({
              protocol        : freeForAll.protocol,
              protocolPath    : 'post/attachment',
              parentContextId : postMessage.recordId,
              author          : alice,
            });
            const attachmentWriteReply = await dwn.processMessage(alice.did, attachmentMessage, { dataStream: attachmentDataStream });
            expect(attachmentWriteReply.status.code).toBe(202);

            // write a record to the unrelated protocol — should NOT be received
            const { message: unrelatedMessage, dataStream: unrelatedDataStream } = await TestDataGenerator.generateRecordsWrite({
              protocol     : unrelatedProtocol.protocol,
              protocolPath : 'post',
              schema       : unrelatedProtocol.types.post.schema,
              author       : alice,
            });
            const unrelatedWriteReply = await dwn.processMessage(alice.did, unrelatedMessage, { dataStream: unrelatedDataStream });
            expect(unrelatedWriteReply.status.code).toBe(202);

            // verify: prefix subscription received the ProtocolsConfigure + both records
            // but NOT the unrelated protocol's ProtocolsConfigure or record.
            await Poller.pollUntilSuccessOrTimeout(async () => {
              expect(prefixMessageCids.length).toBe(3); // ProtocolsConfigure + post + post/attachment
              const expectedCids = [
                await Message.getCid(freeForAllConfigure),
                await Message.getCid(postMessage),
                await Message.getCid(attachmentMessage),
              ];
              expect(prefixMessageCids.sort()).toEqual(expectedCids.sort());
            });
          });

          it('protocolPathPrefix excludes sibling paths that share a string prefix but not a path prefix', async () => {
            // Verifies that 'post' prefix does NOT match 'poster' — the range
            // filter gte:'post', lt:'post/\uffff' correctly uses '/' as the
            // boundary character, not naive string prefix matching.

            const alice = await TestDataGenerator.generateDidKeyPersona();

            // Define a protocol with paths 'post', 'post/attachment', and 'poster'
            const siblingProtocol: ProtocolDefinition = {
              protocol  : 'http://sibling-path-test',
              published : true,
              types     : {
                post       : { schema: 'post', dataFormats: ['application/json'] },
                attachment : {},
                poster     : { schema: 'poster', dataFormats: ['application/json'] },
              },
              structure: {
                post: {
                  $actions   : [{ who: 'anyone', can: ['create', 'read'] }],
                  attachment : {
                    $actions: [{ who: 'anyone', can: ['create', 'read'] }],
                  },
                },
                poster: {
                  $actions: [{ who: 'anyone', can: ['create', 'read'] }],
                },
              },
            };

            const { message: siblingConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : siblingProtocol,
            });
            const { status: siblingConfigureStatus } = await dwn.processMessage(alice.did, siblingConfigure);
            expect(siblingConfigureStatus.code).toBe(202);

            // subscribe with protocolPathPrefix 'post' — should get 'post' and
            // 'post/attachment' but NOT 'poster'
            const prefixCids: string[] = [];
            const prefixHandler = async (msg: SubscriptionMessage):Promise<void> => {
              if (msg.type !== 'event') { return; }
              prefixCids.push(await Message.getCid(msg.event.message));
            };

            const { message: prefixSub } = await TestDataGenerator.generateMessagesSubscribe({
              author  : alice,
              filters : [{ protocol: siblingProtocol.protocol, protocolPathPrefix: 'post' }],
            });
            const prefixReply = await dwn.processMessage(alice.did, prefixSub, { subscriptionHandler: prefixHandler });
            expect(prefixReply.status.code).toBe(200);

            // write to 'post'
            const { message: postMsg, dataStream: postDs } = await TestDataGenerator.generateRecordsWrite({
              protocol     : siblingProtocol.protocol,
              protocolPath : 'post',
              schema       : 'post',
              author       : alice,
            });
            expect((await dwn.processMessage(alice.did, postMsg, { dataStream: postDs })).status.code).toBe(202);

            // write to 'post/attachment'
            const { message: attachMsg, dataStream: attachDs } = await TestDataGenerator.generateRecordsWrite({
              protocol        : siblingProtocol.protocol,
              protocolPath    : 'post/attachment',
              parentContextId : postMsg.recordId,
              author          : alice,
            });
            expect((await dwn.processMessage(alice.did, attachMsg, { dataStream: attachDs })).status.code).toBe(202);

            // write to 'poster' — this should NOT match the 'post' prefix
            const { message: posterMsg, dataStream: posterDs } = await TestDataGenerator.generateRecordsWrite({
              protocol     : siblingProtocol.protocol,
              protocolPath : 'poster',
              schema       : 'poster',
              author       : alice,
            });
            expect((await dwn.processMessage(alice.did, posterMsg, { dataStream: posterDs })).status.code).toBe(202);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              // prefix subscription should receive 'post' and 'post/attachment' but NOT 'poster'
              expect(prefixCids.length).toBe(2);
              const expectedCids = [
                await Message.getCid(postMsg),
                await Message.getCid(attachMsg),
              ];
              expect(prefixCids.sort()).toEqual(expectedCids.sort());
            });
          });

          it('protocolPathPrefix for a child path does not include parent records', async () => {
            // Subscribing with protocolPathPrefix 'post/attachment' should receive
            // only 'post/attachment' records, NOT 'post' records.

            const alice = await TestDataGenerator.generateDidKeyPersona();

            const { message: freeForAllConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : freeForAll,
            });
            expect((await dwn.processMessage(alice.did, freeForAllConfigure)).status.code).toBe(202);

            const childCids: string[] = [];
            const childHandler = async (msg: SubscriptionMessage):Promise<void> => {
              if (msg.type !== 'event') { return; }
              childCids.push(await Message.getCid(msg.event.message));
            };

            const { message: childSub } = await TestDataGenerator.generateMessagesSubscribe({
              author  : alice,
              filters : [{ protocol: freeForAll.protocol, protocolPathPrefix: 'post/attachment' }],
            });
            expect((await dwn.processMessage(alice.did, childSub, { subscriptionHandler: childHandler })).status.code).toBe(200);

            // write a 'post' record — should NOT match 'post/attachment' prefix
            const { message: postMsg, dataStream: postDs } = await TestDataGenerator.generateRecordsWrite({
              protocol     : freeForAll.protocol,
              protocolPath : 'post',
              schema       : freeForAll.types.post.schema,
              author       : alice,
            });
            expect((await dwn.processMessage(alice.did, postMsg, { dataStream: postDs })).status.code).toBe(202);

            // write a 'post/attachment' record — should match
            const { message: attachMsg, dataStream: attachDs } = await TestDataGenerator.generateRecordsWrite({
              protocol        : freeForAll.protocol,
              protocolPath    : 'post/attachment',
              parentContextId : postMsg.recordId,
              author          : alice,
            });
            expect((await dwn.processMessage(alice.did, attachMsg, { dataStream: attachDs })).status.code).toBe(202);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              // only the attachment record should be received (ProtocolsConfigure
              // was installed before the subscription was opened, so it's not
              // delivered as a live event)
              expect(childCids.length).toBe(1);
              expect(childCids[0]).toBe(await Message.getCid(attachMsg));
            });
          });

          it('allows subscribe of contextIdPrefix filtered messages with real context inclusion and exclusion', async () => {
            // scenario: Alice installs a protocol, writes two root posts (each in its own context),
            // then writes a child attachment under one post. She subscribes with a contextIdPrefix
            // matching the first post's contextId. Expected:
            //   - ProtocolsConfigure received (shadow filter)
            //   - Post A and its attachment received (contextId matches prefix)
            //   - Post B NOT received (different context)

            const alice = await TestDataGenerator.generateDidKeyPersona();

            // install the protocol first so we can write records
            const { message: freeForAllConfigure } = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : freeForAll,
            });
            expect((await dwn.processMessage(alice.did, freeForAllConfigure)).status.code).toBe(202);

            // write post A — its contextId will be its own recordId
            const { message: postA, dataStream: dsA } = await TestDataGenerator.generateRecordsWrite({
              protocol     : freeForAll.protocol,
              protocolPath : 'post',
              schema       : freeForAll.types.post.schema,
              author       : alice,
            });
            expect((await dwn.processMessage(alice.did, postA, { dataStream: dsA })).status.code).toBe(202);
            const postAContextId = postA.contextId ?? postA.recordId;

            // write an attachment under post A — contextId = postA.recordId/attachment.recordId
            const { message: attachA, dataStream: dsAttachA } = await TestDataGenerator.generateRecordsWrite({
              protocol        : freeForAll.protocol,
              protocolPath    : 'post/attachment',
              parentContextId : postA.recordId,
              author          : alice,
            });
            expect((await dwn.processMessage(alice.did, attachA, { dataStream: dsAttachA })).status.code).toBe(202);

            // write post B — different context
            const { message: postB, dataStream: dsB } = await TestDataGenerator.generateRecordsWrite({
              protocol     : freeForAll.protocol,
              protocolPath : 'post',
              schema       : freeForAll.types.post.schema,
              author       : alice,
            });
            expect((await dwn.processMessage(alice.did, postB, { dataStream: dsB })).status.code).toBe(202);

            // now subscribe with contextIdPrefix = postA's contextId
            // This should match postA (exact) and attachA (child), but NOT postB
            const ctxCids: string[] = [];
            const ctxHandler = async (msg: SubscriptionMessage):Promise<void> => {
              if (msg.type !== 'event') { return; }
              ctxCids.push(await Message.getCid(msg.event.message));
            };

            const { message: ctxSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
              author  : alice,
              filters : [{ protocol: freeForAll.protocol, contextIdPrefix: postAContextId }],
            });
            const ctxReply = await dwn.processMessage(alice.did, ctxSubscribe, { subscriptionHandler: ctxHandler });
            expect(ctxReply.status.code).toBe(200);

            // write another record AFTER subscribing to test live delivery
            const { message: postC, dataStream: dsC } = await TestDataGenerator.generateRecordsWrite({
              protocol     : freeForAll.protocol,
              protocolPath : 'post',
              schema       : freeForAll.types.post.schema,
              author       : alice,
            });
            expect((await dwn.processMessage(alice.did, postC, { dataStream: dsC })).status.code).toBe(202);

            // write another attachment under post A — should match the contextId prefix
            const { message: attachA2, dataStream: dsAttachA2 } = await TestDataGenerator.generateRecordsWrite({
              protocol        : freeForAll.protocol,
              protocolPath    : 'post/attachment',
              parentContextId : postA.recordId,
              author          : alice,
            });
            expect((await dwn.processMessage(alice.did, attachA2, { dataStream: dsAttachA2 })).status.code).toBe(202);

            await Poller.pollUntilSuccessOrTimeout(async () => {
              // Should receive: attachA2 (live, context matches) but NOT postC (different context)
              // Also may receive ProtocolsConfigure via shadow filter (it was installed before subscribe,
              // so it won't appear in live events, but the shadow filter ensures it COULD if timing differed)
              const attachA2Cid = await Message.getCid(attachA2);
              expect(ctxCids).toContain(attachA2Cid);

              // postC should NOT be in the list (different context)
              const postCCid = await Message.getCid(postC);
              expect(ctxCids).not.toContain(postCCid);
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
                method    : DwnMethodName.Read,
                protocol  : protocol1.protocol
              }
            });

            const grant1Reply = await dwn.processMessage(alice.did, grant1Message, { dataStream: grant1DataStream });
            expect(grant1Reply.status.code).toBe(202);

            // bob cannot use a protocol-scoped grant for an unfiltered all-message subscription
            const { message: unfilteredSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [],
              permissionGrantIds : [grant1Message.recordId]
            });
            const unfilteredReply = await dwn.processMessage(alice.did, unfilteredSubscribe);
            expect(unfilteredReply.status.code).toBe(401);
            expect(unfilteredReply.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationUnfilteredSubscribeProtocolScope);
            expect(unfilteredReply.subscription).toBeUndefined();

            // bob uses the grant for protocol 1 to subscribe for protocol 2 messages
            const { message: bobSubscribe1 } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocol2.protocol }],
              permissionGrantIds : [grant1Message.recordId]
            });
            const bobReply1 = await dwn.processMessage(alice.did, bobSubscribe1);
            expect(bobReply1.status.code).toBe(401);
            expect(bobReply1.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch);
            expect(bobReply1.subscription).toBeUndefined();

            // bob attempts to use the grant for protocol 1 to subscribe to messages in protocol 1 OR protocol 2 given two filters
            // this should fail because the grant is scoped to protocol 1 only
            const { message: bobSubscribe2 } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocol1.protocol }, { protocol: protocol2.protocol }],
              permissionGrantIds : [grant1Message.recordId]
            });
            const bobReply2 = await dwn.processMessage(alice.did, bobSubscribe2);
            expect(bobReply2.status.code).toBe(401);
            expect(bobReply2.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch);
            expect(bobReply2.subscription).toBeUndefined();

            // A protocolPath-scoped grant cannot authorize a protocolPathPrefix
            // filter because the prefix includes child paths and is broader than
            // an exact protocolPath grant.
            const { message: pathGrantMessage, dataStream: pathGrantDataStream } = await TestDataGenerator.generateGrantCreate({
              author    : alice,
              grantedTo : bob,
              scope     : {
                interface    : DwnInterfaceName.Messages,
                method       : DwnMethodName.Read,
                protocol     : protocol1.protocol,
                protocolPath : 'post'
              }
            });

            const pathGrantReply = await dwn.processMessage(alice.did, pathGrantMessage, { dataStream: pathGrantDataStream });
            expect(pathGrantReply.status.code).toBe(202);

            const { message: pathScopedSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocol1.protocol, protocolPathPrefix: 'post' }],
              permissionGrantIds : [pathGrantMessage.recordId]
            });
            const pathScopedReply = await dwn.processMessage(alice.did, pathScopedSubscribe);
            expect(pathScopedReply.status.code).toBe(401);
            expect(pathScopedReply.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch);
            expect(pathScopedReply.subscription).toBeUndefined();

            const { message: contextGrantMessage, dataStream: contextGrantDataStream } = await TestDataGenerator.generateGrantCreate({
              author    : alice,
              grantedTo : bob,
              scope     : {
                interface : DwnInterfaceName.Messages,
                method    : DwnMethodName.Read,
                protocol  : protocol1.protocol,
                contextId : 'root'
              }
            });

            const contextGrantReply = await dwn.processMessage(alice.did, contextGrantMessage, { dataStream: contextGrantDataStream });
            expect(contextGrantReply.status.code).toBe(202);

            const { message: contextScopedSubscribe } = await TestDataGenerator.generateMessagesSubscribe({
              author             : bob,
              filters            : [{ protocol: protocol1.protocol, contextIdPrefix: 'root' }],
              permissionGrantIds : [contextGrantMessage.recordId]
            });
            const contextScopedReply = await dwn.processMessage(alice.did, contextScopedSubscribe);
            expect(contextScopedReply.status.code).toBe(401);
            expect(contextScopedReply.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch);
            expect(contextScopedReply.subscription).toBeUndefined();
          });
        });
      });
    });
  });
}
