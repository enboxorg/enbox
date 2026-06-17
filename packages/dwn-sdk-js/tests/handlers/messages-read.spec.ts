import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type {
  DataStore,
  MessagesReadReply,
  MessageStore,
  ResumableTaskStore,
} from '../../src/index.js';

import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import { GeneralJwsVerifier } from '../../src/jose/jws/general/verifier.js';
import { Message } from '../../src/core/message.js';
import minimalProtocolDefinition from '../vectors/protocol-definitions/minimal.json' with { type: 'json' };
import sinon from 'sinon';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Dwn, DwnConstant, DwnErrorCode, DwnInterfaceName, DwnMethodName, Jws, PermissionGrant, PermissionsProtocol, Time } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testMessagesReadHandler(): void {
  describe('MessagesReadHandler.handle()', () => {
    let dwn: Dwn;
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;

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
    // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();

      sinon.restore(); // wipe all previous stubs/spies/mocks/fakes
    });

    afterAll(async () => {
      sinon.restore();
      await dwn.close();
    });

    it('returns a 401 if authentication fails', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      sinon.stub(GeneralJwsVerifier, 'verifySignatures').throws(new Error('Invalid signature'));

      // alice creates a record
      const { message } = await TestDataGenerator.generateMessagesRead({
        author     : alice,
        messageCid : await TestDataGenerator.randomCborSha256Cid()
      });

      // alice is not the author of the message
      const reply = await dwn.processMessage(alice.did, message);
      expect(reply.status.code).toBe(401);
      expect(reply.status.detail).toContain('Invalid signature');
    });

    it('returns a 400 if message is invalid', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      const { message } = await TestDataGenerator.generateMessagesRead({
        author     : alice,
        messageCid : await Message.getCid(recordsWrite.message)
      });

      (message['descriptor'] as any)['troll'] = 'hehe';

      const reply = await dwn.processMessage(alice.did, message);

      expect(reply.status.code).toBe(400);
    });

    it('returns a 400 if message contains an invalid message cid', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      const { message } = await TestDataGenerator.generateMessagesRead({
        author     : alice,
        messageCid : await Message.getCid(recordsWrite.message)
      });

      message.descriptor.messageCid = 'hehetroll';

      const reply: MessagesReadReply = await dwn.processMessage(alice.did, message);

      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain('is not a valid CID');
      expect(reply.entry).toBeUndefined();
    });

    it('returns a 404 and the entry as undefined in reply entry when a messageCid is not found', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });
      const recordsWriteMessageCid = await Message.getCid(recordsWrite.message);

      const { message } = await TestDataGenerator.generateMessagesRead({
        author     : alice,
        messageCid : recordsWriteMessageCid
      });

      // returns a 404 because the RecordsWrite created above was never stored
      const reply: MessagesReadReply = await dwn.processMessage(alice.did, message);
      expect(reply.status.code).toBe(404);
      expect(reply.entry).toBeUndefined();
    });

    describe('without a grant', () =>{
      describe('records interface messages', () => {
        it('returns a 401 if the tenant is not the author', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          await TestDataGenerator.installDefaultTestProtocol(dwn, bob);

          // bob creates a record that alice will try and get
          const { message: recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: bob });
          const { status } = await dwn.processMessage(bob.did, recordsWrite, { dataStream });
          expect(status.code).toBe(202);

          // alice tries to read the message
          const { message } = await TestDataGenerator.generateMessagesRead({
            author     : alice,
            messageCid : await Message.getCid(recordsWrite)
          });
          const reply = await dwn.processMessage(bob.did, message);

          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.MessagesReadAuthorizationFailed);
        });

        describe('gets record data in the reply entry', () => {
          it('data is less than threshold', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

            const { message: recordsWrite, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
              author : alice,
              data   : TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded),
            });

            const reply = await dwn.processMessage(alice.did, recordsWrite, { dataStream });
            expect(reply.status.code).toBe(202);

            const recordsWriteMessageCid = await Message.getCid(recordsWrite);
            const { message } = await TestDataGenerator.generateMessagesRead({
              author     : alice,
              messageCid : recordsWriteMessageCid
            });

            const messagesReadReply: MessagesReadReply = await dwn.processMessage(alice.did, message);
            expect(messagesReadReply.status.code).toBe(200);
            expect(messagesReadReply.entry).toBeDefined();

            const messageReply = messagesReadReply.entry!;
            expect(messageReply.messageCid).toBeDefined();
            expect(messageReply.messageCid).toBe(recordsWriteMessageCid);

            expect(messageReply.message).toBeDefined();
            expect(messageReply.data).toBeDefined();
            const messageData = await DataStream.toBytes(messageReply.data!);
            expect(messageData).toEqual(dataBytes);
          });

          it('data is greater than threshold', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

            const { message: recordsWrite, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
              author : alice,
              data   : TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 10),
            });

            const reply = await dwn.processMessage(alice.did, recordsWrite, { dataStream });
            expect(reply.status.code).toBe(202);

            const recordsWriteMessageCid = await Message.getCid(recordsWrite);
            const { message } = await TestDataGenerator.generateMessagesRead({
              author     : alice,
              messageCid : recordsWriteMessageCid
            });

            const messagesReadReply: MessagesReadReply = await dwn.processMessage(alice.did, message);
            expect(messagesReadReply.status.code).toBe(200);
            expect(messagesReadReply.entry).toBeDefined();

            const messageReply = messagesReadReply.entry!;
            expect(messageReply.messageCid).toBeDefined();
            expect(messageReply.messageCid).toBe(recordsWriteMessageCid);

            expect(messageReply.message).toBeDefined();
            expect(messageReply.data).toBeDefined();
            const messageData = await DataStream.toBytes(messageReply.data!);
            expect(messageData).toEqual(dataBytes);
          });

          it('data is not available', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

            // initial write
            const { message: recordsWriteMessage, recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
              author : alice,
              data   : TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 10),
            });

            const initialMessageCid = await Message.getCid(recordsWriteMessage);

            let reply = await dwn.processMessage(alice.did, recordsWriteMessage, { dataStream });
            expect(reply.status.code).toBe(202);

            const { recordsWrite: updateMessage, dataStream: updateDataStream } = await TestDataGenerator.generateFromRecordsWrite({
              author        : alice,
              existingWrite : recordsWrite,
              data          : TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 10),
            });

            reply = await dwn.processMessage(alice.did, updateMessage.toJSON(), { dataStream: updateDataStream });
            expect(reply.status.code).toBe(202);

            const { message } = await TestDataGenerator.generateMessagesRead({
              author     : alice,
              messageCid : initialMessageCid
            });

            const messagesReadReply: MessagesReadReply = await dwn.processMessage(alice.did, message);
            expect(messagesReadReply.status.code).toBe(200);
            expect(messagesReadReply.entry).toBeDefined();

            const messageReply = messagesReadReply.entry!;
            expect(messageReply.messageCid).toBeDefined();
            expect(messageReply.messageCid).toBe(initialMessageCid);

            expect(messageReply.message).toBeDefined();
            expect(messageReply.data).toBeUndefined();
          });
        });
      });

      describe('Protocol interface messages', () => {
        it('returns a 401 if the tenant is not the author', async () => {
          // scenario:  Alice configures both a published and non-published protocol and writes it to her DWN.
          //            Bob is unable to read either of the ProtocolConfigure messages because he is not the author.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // unpublished protocol configuration
          const unpublishedProtocolDefinition = {
            ...minimalProtocolDefinition,
            protocol  : 'http://example.com/protocol/unpublished',
            published : false
          };
          const { message: unpublishedProtocolsConfigure } = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : unpublishedProtocolDefinition
          });
          const unpublishedProtocolsConfigureReply = await dwn.processMessage(alice.did, unpublishedProtocolsConfigure);
          expect(unpublishedProtocolsConfigureReply.status.code).toBe(202);

          // published protocol configuration
          const publishedProtocolDefinition = {
            ...minimalProtocolDefinition,
            protocol  : 'http://example.com/protocol/published',
            published : true
          };
          const { message: publishedProtocolsConfigure } = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : publishedProtocolDefinition
          });
          const publishedProtocolsConfigureReply = await dwn.processMessage(alice.did, publishedProtocolsConfigure);
          expect(publishedProtocolsConfigureReply.status.code).toBe(202);

          // get the message CIDs
          const unpublishedProtocolMessageCid = await Message.getCid(unpublishedProtocolsConfigure);
          const publishedProtocolMessageCid = await Message.getCid(publishedProtocolsConfigure);

          // bob attempts to read the unpublished protocol configuration
          const { message: getUnpublishedProtocolConfigure } = await TestDataGenerator.generateMessagesRead({
            author     : bob,
            messageCid : unpublishedProtocolMessageCid,
          });
          const getUnpublishedProtocolConfigureReply = await dwn.processMessage(alice.did, getUnpublishedProtocolConfigure);
          expect(getUnpublishedProtocolConfigureReply.status.code).toBe(401);
          expect(getUnpublishedProtocolConfigureReply.status.detail).toContain(DwnErrorCode.MessagesReadAuthorizationFailed);
          expect(getUnpublishedProtocolConfigureReply.entry).toBeUndefined();

          // bob attempts to read the published protocol configuration
          const { message: getPublishedProtocolConfigure } = await TestDataGenerator.generateMessagesRead({
            author     : bob,
            messageCid : publishedProtocolMessageCid,
          });
          const getPublishedProtocolConfigureReply = await dwn.processMessage(alice.did, getPublishedProtocolConfigure);
          expect(getPublishedProtocolConfigureReply.status.code).toBe(401);
          expect(getPublishedProtocolConfigureReply.status.detail).toContain(DwnErrorCode.MessagesReadAuthorizationFailed);
          expect(getPublishedProtocolConfigureReply.entry).toBeUndefined();

          // control: alice is able to read both the published and unpublished protocol configurations
          const { message: getUnpublishedProtocolConfigureAlice } = await TestDataGenerator.generateMessagesRead({
            author     : alice,
            messageCid : unpublishedProtocolMessageCid,
          });
          const getUnpublishedProtocolConfigureAliceReply = await dwn.processMessage(alice.did, getUnpublishedProtocolConfigureAlice);
          expect(getUnpublishedProtocolConfigureAliceReply.status.code).toBe(200);
          expect(getUnpublishedProtocolConfigureAliceReply.entry).toBeDefined();
          expect(getUnpublishedProtocolConfigureAliceReply.entry!.messageCid).toBe(unpublishedProtocolMessageCid);
          expect(getUnpublishedProtocolConfigureAliceReply.entry!.message).toEqual(unpublishedProtocolsConfigure);

          const { message: getPublishedProtocolConfigureAlice } = await TestDataGenerator.generateMessagesRead({
            author     : alice,
            messageCid : publishedProtocolMessageCid,
          });
          const getPublishedProtocolConfigureAliceReply = await dwn.processMessage(alice.did, getPublishedProtocolConfigureAlice);
          expect(getPublishedProtocolConfigureAliceReply.status.code).toBe(200);
          expect(getPublishedProtocolConfigureAliceReply.entry).toBeDefined();
          expect(getPublishedProtocolConfigureAliceReply.entry!.messageCid).toBe(publishedProtocolMessageCid);
          expect(getPublishedProtocolConfigureAliceReply.entry!.message).toEqual(publishedProtocolsConfigure);
        });
      });
    });

    describe('with a grant', () => {
      it('returns a 401 if grant has different DWN interface scope', async () => {
        // scenario: Alice grants Bob access to RecordsWrite, then Bob tries to invoke the grant with MessagesRead

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // alice installs a protocol
        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : minimalProtocolDefinition
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        // Alice writes a record which Bob will later try to read
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : minimalProtocolDefinition.protocol,
          protocolPath : 'foo',
        });
        const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(recordsWriteReply.status.code).toBe(202);

        // Alice gives Bob a permission grant scoped to a RecordsWrite and the protocol
        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            protocol  : minimalProtocolDefinition.protocol,
          }
        });
        const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
        const permissionGrantWriteReply = await dwn.processMessage(
          alice.did,
          permissionGrant.recordsWrite.message,
          { dataStream: grantDataStream }
        );
        expect(permissionGrantWriteReply.status.code).toBe(202);

        // Bob tries to MessagesRead using the RecordsWrite grant
        const messagesRead = await TestDataGenerator.generateMessagesRead({
          author             : bob,
          messageCid         : await Message.getCid(recordsWrite.message),
          permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
        });
        const messagesReadReply = await dwn.processMessage(alice.did, messagesRead.message);
        expect(messagesReadReply.status.code).toBe(401);
        expect(messagesReadReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationInterfaceMismatch);
      });

      it('allows external parties to read a message using a grant with unrestricted scope', async () => {
        // scenario: Alice gives Bob a grant allowing him to read any message in her DWN.
        //           Bob invokes that grant to read a message.

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // Alice writes a record to her DWN
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
        });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);
        const messageCid = await Message.getCid(message);

        // Alice issues a permission grant allowing Bob to read any record in her DWN
        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
          }
        });
        const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream: grantDataStream });
        expect(grantReply.status.code).toBe(202);

        // Bob invokes that grant to read a record from Alice's DWN
        const messagesRead = await TestDataGenerator.generateMessagesRead({
          author             : bob,
          permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          messageCid,
        });
        const readReply = await dwn.processMessage(alice.did, messagesRead.message);
        expect(readReply.status.code).toBe(200);
        expect(readReply.entry).toBeDefined();
        expect(readReply.entry!.messageCid).toBe(messageCid);
      });

      it('allows reads when one grant in a plural grant set covers the message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocol1 = { ...minimalProtocolDefinition, protocol: 'http://plural-grant-read-1' };
        const protocol2 = { ...minimalProtocolDefinition, protocol: 'http://plural-grant-read-2' };

        for (const protocolDefinition of [protocol1, protocol2]) {
          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition,
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);
        }

        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : protocol2.protocol,
          protocolPath : 'foo',
        });
        const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(recordsWriteReply.status.code).toBe(202);

        const permissionGrantIds: string[] = [];
        for (const protocolDefinition of [protocol1, protocol2]) {
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : protocolDefinition.protocol,
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream: grantDataStream });
          expect(grantReply.status.code).toBe(202);
          permissionGrantIds.push(permissionGrant.recordsWrite.message.recordId);
        }

        const messageCid = await Message.getCid(recordsWrite.message);
        const messagesRead = await TestDataGenerator.generateMessagesRead({
          author             : bob,
          messageCid,
          permissionGrantIds : permissionGrantIds.reverse(),
        });

        const readReply = await dwn.processMessage(alice.did, messagesRead.message);
        expect(readReply.status.code).toBe(200);
        expect(readReply.entry?.messageCid).toBe(messageCid);
        expect(messagesRead.message.descriptor.permissionGrantIds).toEqual([...permissionGrantIds].sort());
      });

      it('rejects reads if any grant in a plural grant set cannot be resolved', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const protocolDefinition = { ...minimalProtocolDefinition, protocol: 'http://plural-grant-read-unresolved' };

        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'foo',
        });
        const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(recordsWriteReply.status.code).toBe(202);

        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            protocol  : protocolDefinition.protocol,
          }
        });
        const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream: grantDataStream });
        expect(grantReply.status.code).toBe(202);

        const messagesRead = await TestDataGenerator.generateMessagesRead({
          author             : bob,
          messageCid         : await Message.getCid(recordsWrite.message),
          permissionGrantIds : [
            permissionGrant.recordsWrite.message.recordId,
            await TestDataGenerator.randomCborSha256Cid(),
          ],
        });

        const readReply = await dwn.processMessage(alice.did, messagesRead.message);
        expect(readReply.status.code).toBe(401);
        expect(readReply.entry).toBeUndefined();
      });

      describe('protocol scoped messages', () => {
        it('allows reads of protocol messages with a protocol restricted grant scope', async () => {
          // This test will verify that a grant scoped to a specific protocol will allow a user to read messages associated with that protocol.
          // These messages include the ProtocolConfiguration itself, even if not published,
          // any RecordsWrite or RecordsDelete messages associated with the protocol,
          // and any PermissionProtocol RecordsWrite messages associated with the protocol.

          // scenario: Alice configures a protocol that is unpublished and writes it to her DWN.
          //           Alice then gives Bob a grant to read messages from that protocol.
          //           Carol requests a grant to RecordsWrite to the protocol, and Alice grants it.
          //           Alice and Carol write records associated with the protocol.
          //           Alice also deletes a record associated with the protocol.
          //           Alice revokes the grant to Carol.
          //           Bob invokes his grant to read the various messages.
          //           As a control, Alice writes a record not associated with the protocol and Bob tries to unsuccessfully read it.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const carol = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = { ...minimalProtocolDefinition, published: false };

          // Alice installs the unpublished protocol
          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);
          const protocolConfigureMessageCid = await Message.getCid(protocolsConfig.message);

          // Carol requests a grant to write records to the protocol
          const permissionRequestCarol = await PermissionsProtocol.createRequest({
            signer    : Jws.createSigner(alice),
            delegated : false,
            scope     : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              protocol  : protocolDefinition.protocol,
            }
          });
          const requestDataStreamCarol = DataStream.fromBytes(permissionRequestCarol.permissionRequestBytes);
          const permissionRequestWriteReplyCarol = await dwn.processMessage(
            alice.did,
            permissionRequestCarol.recordsWrite.message,
            { dataStream: requestDataStreamCarol }
          );
          expect(permissionRequestWriteReplyCarol.status.code).toBe(202);

          // Alice gives Carol a grant to write records to the protocol
          const permissionGrantCarol = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : carol.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            delegated   : permissionRequestCarol.permissionRequestData.delegated,
            scope       : permissionRequestCarol.permissionRequestData.scope,
          });

          const grantDataStreamCarol = DataStream.fromBytes(permissionGrantCarol.permissionGrantBytes);
          const permissionGrantWriteReplyCarol = await dwn.processMessage(
            alice.did,
            permissionGrantCarol.recordsWrite.message,
            { dataStream: grantDataStreamCarol }
          );
          expect(permissionGrantWriteReplyCarol.status.code).toBe(202);
          const carolGrantMessageCiD = await Message.getCid(permissionGrantCarol.recordsWrite.message);

          // Alice writes a record associated with the protocol
          const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'foo',
          });
          const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
          expect(recordsWriteReply.status.code).toBe(202);
          const aliceRecordMessageCid = await Message.getCid(recordsWrite.message);

          // Alice deletes a record associated with the protocol
          const recordsDelete = await TestDataGenerator.generateRecordsDelete({
            author   : alice,
            recordId : recordsWrite.message.recordId,
          });
          const recordsDeleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(recordsDeleteReply.status.code).toBe(202);

          // Carol writes a record associated with the protocol
          const { recordsWrite: recordsWriteCarol, dataStream: dataStreamCarol } = await TestDataGenerator.generateRecordsWrite({
            author            : carol,
            protocol          : protocolDefinition.protocol,
            protocolPath      : 'foo',
            permissionGrantId : permissionGrantCarol.recordsWrite.message.recordId,
          });
          const recordsWriteReplyCarol = await dwn.processMessage(alice.did, recordsWriteCarol.message, { dataStream: dataStreamCarol });
          expect(recordsWriteReplyCarol.status.code).toBe(202);
          const carolRecordMessageCid = await Message.getCid(recordsWriteCarol.message);

          // Alice revokes Carol's grant
          const permissionRevocationCarol = await PermissionsProtocol.createRevocation({
            signer : Jws.createSigner(alice),
            grant  : PermissionGrant.parse(permissionGrantCarol.dataEncodedMessage),
          });
          const permissionRevocationCarolDataStream = DataStream.fromBytes(permissionRevocationCarol.permissionRevocationBytes);
          const permissionRevocationCarolReply = await dwn.processMessage(
            alice.did,
            permissionRevocationCarol.recordsWrite.message,
            { dataStream: permissionRevocationCarolDataStream }
          );
          expect(permissionRevocationCarolReply.status.code).toBe(202);

          // Alice gives Bob a permission grant with scope MessagesRead
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : protocolDefinition.protocol,
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const permissionGrantWriteReply = await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: grantDataStream }
          );
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Bob is unable to read the message without using the permission grant
          const messagesReadWithoutGrant = await TestDataGenerator.generateMessagesRead({
            author     : bob,
            messageCid : aliceRecordMessageCid,
          });
          const messagesReadWithoutGrantReply = await dwn.processMessage(alice.did, messagesReadWithoutGrant.message);
          expect(messagesReadWithoutGrantReply.status.code).toBe(401);
          expect(messagesReadWithoutGrantReply.status.detail).toContain(DwnErrorCode.MessagesReadAuthorizationFailed);

          // Bob is able to read all the associated messages when using the permission grant
          // Expected Messages:
          // - Protocol Configuration
          // - Alice's RecordsWrite
          // - Alice's RecordsDelete
          // - Carol's Permission Request
          // - Alice's Permission Grant to Carol
          // - Carol's RecordsWrite
          // - Alice's Revocation of Carol's Grant

          // Protocol configuration
          const messagesReadProtocolConfigure = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : protocolConfigureMessageCid,
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadProtocolConfigureReply = await dwn.processMessage(alice.did, messagesReadProtocolConfigure.message);
          expect(messagesReadProtocolConfigureReply.status.code).toBe(200);
          expect(messagesReadProtocolConfigureReply.entry).toBeDefined();
          expect(messagesReadProtocolConfigureReply.entry!.message).toEqual(protocolsConfig.message);

          // alice RecordsWrite
          const messagesReadWithGrant = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : aliceRecordMessageCid,
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadWithGrantReply = await dwn.processMessage(alice.did, messagesReadWithGrant.message);
          expect(messagesReadWithGrantReply.status.code).toBe(200);
          expect(messagesReadWithGrantReply.entry).toBeDefined();
          expect(messagesReadWithGrantReply.entry!.message).toEqual(recordsWrite.message);

          // alice RecordsDelete
          const messagesReadDelete = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(recordsDelete.message),
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadDeleteReply = await dwn.processMessage(alice.did, messagesReadDelete.message);
          expect(messagesReadDeleteReply.status.code).toBe(200);
          expect(messagesReadDeleteReply.entry).toBeDefined();
          expect(messagesReadDeleteReply.entry!.message).toEqual(recordsDelete.message);

          // carol's Permission Request
          const messagesReadCarolRequest = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(permissionRequestCarol.recordsWrite.message),
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadCarolRequestReply = await dwn.processMessage(alice.did, messagesReadCarolRequest.message);
          expect(messagesReadCarolRequestReply.status.code).toBe(200);
          expect(messagesReadCarolRequestReply.entry).toBeDefined();
          expect(messagesReadCarolRequestReply.entry!.message).toEqual(permissionRequestCarol.recordsWrite.message);

          // carol's Permission Grant
          const messagesReadCarolGrant = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : carolGrantMessageCiD,
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadCarolGrantReply = await dwn.processMessage(alice.did, messagesReadCarolGrant.message);
          expect(messagesReadCarolGrantReply.status.code).toBe(200);
          expect(messagesReadCarolGrantReply.entry).toBeDefined();
          expect(messagesReadCarolGrantReply.entry!.message).toEqual(permissionGrantCarol.recordsWrite.message);

          // carol's RecordsWrite
          const messagesReadCarolRecord = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : carolRecordMessageCid,
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadCarolRecordReply = await dwn.processMessage(alice.did, messagesReadCarolRecord.message);
          expect(messagesReadCarolRecordReply.status.code).toBe(200);
          expect(messagesReadCarolRecordReply.entry).toBeDefined();
          expect(messagesReadCarolRecordReply.entry!.message).toEqual(recordsWriteCarol.message);

          // carol's Grant Revocation
          const messagesReadCarolGrantRevocation = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(permissionRevocationCarol.recordsWrite.message),
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadCarolGrantRevocationReply = await dwn.processMessage(alice.did, messagesReadCarolGrantRevocation.message);
          expect(messagesReadCarolGrantRevocationReply.status.code).toBe(200);
          expect(messagesReadCarolGrantRevocationReply.entry).toBeDefined();
          expect(messagesReadCarolGrantRevocationReply.entry!.message).toEqual(permissionRevocationCarol.recordsWrite.message);

          // CONTROL: Alice writes a record not associated with the protocol
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
          const { recordsWrite: recordsWriteControl, dataStream: dataStreamControl } = await TestDataGenerator.generateRecordsWrite({
            author: alice,
          });
          const recordsWriteControlReply = await dwn.processMessage(alice.did, recordsWriteControl.message, { dataStream: dataStreamControl });
          expect(recordsWriteControlReply.status.code).toBe(202);

          // Bob is unable to read the control message
          const messagesReadControl = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(recordsWriteControl.message),
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadControlReply = await dwn.processMessage(alice.did, messagesReadControl.message);
          expect(messagesReadControlReply.status.code).toBe(401);
        });

        it('rejects message read of protocol messages with mismatching protocol grant scopes', async () => {
          // scenario: Alice writes a protocol record. Alice gives Bob a grant to read messages from a different protocol
          //           Bob invokes that grant to read the protocol message, but fails.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = minimalProtocolDefinition;

          // Alice installs the protocol
          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a record which Bob will later try to read
          const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'foo',
          });
          const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
          expect(recordsWriteReply.status.code).toBe(202);

          // Alice gives Bob a permission grant with scope MessagesRead
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : 'a-different-protocol'
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const permissionGrantWriteReply = await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: grantDataStream }
          );
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Bob is unable to read the record using the mismatched permission grant
          const messagesReadWithoutGrant = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(recordsWrite.message),
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadWithoutGrantReply = await dwn.processMessage(alice.did, messagesReadWithoutGrant.message);
          expect(messagesReadWithoutGrantReply.status.code).toBe(401);
          expect(messagesReadWithoutGrantReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);
        });

        it('rejects reading arbitrary permission records with a grant scoped to the Permissions protocol', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const appProtocolGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : minimalProtocolDefinition.protocol,
            }
          });
          expect((await dwn.processMessage(
            alice.did,
            appProtocolGrant.recordsWrite.message,
            { dataStream: DataStream.fromBytes(appProtocolGrant.permissionGrantBytes) }
          )).status.code).toBe(202);

          const permissionsProtocolGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : PermissionsProtocol.uri,
            }
          });
          expect((await dwn.processMessage(
            alice.did,
            permissionsProtocolGrant.recordsWrite.message,
            { dataStream: DataStream.fromBytes(permissionsProtocolGrant.permissionGrantBytes) }
          )).status.code).toBe(202);

          const messagesRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(appProtocolGrant.recordsWrite.message),
            permissionGrantIds : [permissionsProtocolGrant.recordsWrite.message.recordId],
          });
          const messagesReadReply = await dwn.processMessage(alice.did, messagesRead.message);
          expect(messagesReadReply.status.code).toBe(401);
          expect(messagesReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);
        });

        it('authorizes Records messages with exact protocolPath Messages.Read grants', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocolDefinition = { ...freeForAll, protocol: 'http://messages-read-path-scope' };
          const otherProtocolDefinition = { ...freeForAll, protocol: 'http://messages-read-path-scope-other' };

          const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          expect((await dwn.processMessage(alice.did, protocolMessage)).status.code).toBe(202);
          const { message: otherProtocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : otherProtocolDefinition
          });
          expect((await dwn.processMessage(alice.did, otherProtocolMessage)).status.code).toBe(202);

          const { recordsWrite: post, dataStream: postData } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'post',
            schema       : protocolDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, post.message, { dataStream: postData })).status.code).toBe(202);

          const postContextId = post.message.contextId ?? post.message.recordId;
          const { recordsWrite: attachment, dataStream: attachmentData } = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'post/attachment',
            parentContextId : postContextId,
          });
          expect((await dwn.processMessage(alice.did, attachment.message, { dataStream: attachmentData })).status.code).toBe(202);

          const { recordsWrite: otherProtocolPost, dataStream: otherProtocolPostData } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : otherProtocolDefinition.protocol,
            protocolPath : 'post',
            schema       : otherProtocolDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, otherProtocolPost.message, { dataStream: otherProtocolPostData })).status.code).toBe(202);

          const { recordsDelete } = await TestDataGenerator.generateRecordsDelete({
            author   : alice,
            recordId : post.message.recordId,
          });
          expect((await dwn.processMessage(alice.did, recordsDelete.message)).status.code).toBe(202);

          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface    : DwnInterfaceName.Messages,
              method       : DwnMethodName.Read,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'post',
            }
          });
          expect((await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes) }
          )).status.code).toBe(202);

          const grantId = permissionGrant.recordsWrite.message.recordId;

          const postRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(post.message),
            permissionGrantIds : [grantId],
          });
          expect((await dwn.processMessage(alice.did, postRead.message)).status.code).toBe(200);

          const deleteRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(recordsDelete.message),
            permissionGrantIds : [grantId],
          });
          expect((await dwn.processMessage(alice.did, deleteRead.message)).status.code).toBe(200);

          const attachmentRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(attachment.message),
            permissionGrantIds : [grantId],
          });
          expect((await dwn.processMessage(alice.did, attachmentRead.message)).status.code).toBe(401);

          const otherProtocolRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(otherProtocolPost.message),
            permissionGrantIds : [grantId],
          });
          const otherProtocolReadReply = await dwn.processMessage(alice.did, otherProtocolRead.message);
          expect(otherProtocolReadReply.status.code).toBe(401);
          expect(otherProtocolReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const protocolRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(protocolMessage),
            permissionGrantIds : [grantId],
          });
          const protocolReadReply = await dwn.processMessage(alice.did, protocolRead.message);
          expect(protocolReadReply.status.code).toBe(200);
          expect(protocolReadReply.entry!.message).toEqual(protocolMessage);

          const otherProtocolConfigRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(otherProtocolMessage),
            permissionGrantIds : [grantId],
          });
          const otherProtocolConfigReadReply = await dwn.processMessage(alice.did, otherProtocolConfigRead.message);
          expect(otherProtocolConfigReadReply.status.code).toBe(401);
          expect(otherProtocolConfigReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const grantRecordRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(permissionGrant.recordsWrite.message),
            permissionGrantIds : [grantId],
          });
          const grantRecordReadReply = await dwn.processMessage(alice.did, grantRecordRead.message);
          expect(grantRecordReadReply.status.code).toBe(401);
          expect(grantRecordReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const expectPermissionsSubtreeGrantReadRejected = async (scope: { protocolPath: string } | { contextId: string }): Promise<void> => {
            const grant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
              scope       : {
                interface : DwnInterfaceName.Messages,
                method    : DwnMethodName.Read,
                protocol  : PermissionsProtocol.uri,
                ...scope,
              }
            });
            expect((await dwn.processMessage(
              alice.did,
              grant.recordsWrite.message,
              { dataStream: DataStream.fromBytes(grant.permissionGrantBytes) }
            )).status.code).toBe(202);

            const messagesRead = await TestDataGenerator.generateMessagesRead({
              author             : bob,
              messageCid         : await Message.getCid(permissionGrant.recordsWrite.message),
              permissionGrantIds : [grant.recordsWrite.message.recordId],
            });
            const messagesReadReply = await dwn.processMessage(alice.did, messagesRead.message);
            expect(messagesReadReply.status.code).toBe(401);
            expect(messagesReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);
          };

          const permissionGrantContextId = permissionGrant.recordsWrite.message.contextId ?? permissionGrant.recordsWrite.message.recordId;
          await expectPermissionsSubtreeGrantReadRejected({ protocolPath: PermissionsProtocol.grantPath });
          await expectPermissionsSubtreeGrantReadRejected({ contextId: permissionGrantContextId });
        });

        it('authorizes Records messages with context subtree Messages.Read grants', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocolDefinition = { ...freeForAll, protocol: 'http://messages-read-context-scope' };

          const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          expect((await dwn.processMessage(alice.did, protocolMessage)).status.code).toBe(202);

          const { recordsWrite: post, dataStream: postData } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'post',
            schema       : protocolDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, post.message, { dataStream: postData })).status.code).toBe(202);

          const postContextId = post.message.contextId ?? post.message.recordId;
          const { recordsWrite: attachment, dataStream: attachmentData } = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'post/attachment',
            parentContextId : postContextId,
          });
          expect((await dwn.processMessage(alice.did, attachment.message, { dataStream: attachmentData })).status.code).toBe(202);

          const { recordsWrite: siblingPost, dataStream: siblingData } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'post',
            schema       : protocolDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, siblingPost.message, { dataStream: siblingData })).status.code).toBe(202);

          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : protocolDefinition.protocol,
              contextId : postContextId,
            }
          });
          expect((await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes) }
          )).status.code).toBe(202);

          const grantId = permissionGrant.recordsWrite.message.recordId;

          for (const message of [post.message, attachment.message]) {
            const messagesRead = await TestDataGenerator.generateMessagesRead({
              author             : bob,
              messageCid         : await Message.getCid(message),
              permissionGrantIds : [grantId],
            });
            expect((await dwn.processMessage(alice.did, messagesRead.message)).status.code).toBe(200);
          }

          const siblingRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(siblingPost.message),
            permissionGrantIds : [grantId],
          });
          const siblingReadReply = await dwn.processMessage(alice.did, siblingRead.message);
          expect(siblingReadReply.status.code).toBe(401);
          expect(siblingReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const protocolRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(protocolMessage),
            permissionGrantIds : [grantId],
          });
          const protocolReadReply = await dwn.processMessage(alice.did, protocolRead.message);
          expect(protocolReadReply.status.code).toBe(200);
          expect(protocolReadReply.entry!.message).toEqual(protocolMessage);

          const grantRecordRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(permissionGrant.recordsWrite.message),
            permissionGrantIds : [grantId],
          });
          const grantRecordReadReply = await dwn.processMessage(alice.did, grantRecordRead.message);
          expect(grantRecordReadReply.status.code).toBe(401);
          expect(grantRecordReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);
        });

        it('rejects message if the RecordsWrite message is not found for a RecordsDelete being retrieved', async () => {
          // NOTE: This is a corner case that is unlikely to happen in practice, but is tested for completeness

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = minimalProtocolDefinition;

          // Alice installs the protocol
          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition,
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice gives bob a grant to read messages in the protocol
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : protocolDefinition.protocol,
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const permissionGrantWriteReply = await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: grantDataStream }
          );
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Alice creates the records write and records delete messages
          const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'foo',
          });

          const { recordsDelete } = await TestDataGenerator.generateRecordsDelete({
            author   : alice,
            recordId : recordsWrite.message.recordId,
          });

          // Alice inserts the RecordsDelete message directly into the message store
          const recordsDeleteCid = await Message.getCid(recordsDelete.message);
          const indexes = recordsDelete.constructIndexes(recordsWrite.message, recordsWrite.message);
          await messageStore.put(alice.did, recordsDelete.message, indexes);

          // Bob tries to read the message
          const messagesRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : recordsDeleteCid,
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadReply = await dwn.processMessage(alice.did, messagesRead.message);
          expect(messagesReadReply.status.code).toBe(401);
          expect(messagesReadReply.status.detail).toContain(DwnErrorCode.RecordsWriteGetNewestWriteRecordNotFound);
        });
      });
    });
  });
}
