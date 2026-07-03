import type { DidResolver } from '@enbox/dids';
import type { RecordEvent } from '../../src/types/records-types.js';
import { ResumableTaskManager } from '../../src/core/resumable-task-manager.js';
import type {
  DataStore,
  MessageStore,
  ProtocolDefinition,
  ProtocolRuleSet,
  RecordsDeleteMessage,
  RecordsWriteMessage,
  ResumableTaskStore,
} from '../../src/index.js';
import type { EventLog, SubscriptionListener } from '../../src/types/subscriptions.js';

import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import anyoneCollaborateProtocolDefinition from '../vectors/protocol-definitions/anyone-collaborate.json' with { type: 'json' };
import authorCanProtocolDefinition from '../vectors/protocol-definitions/author-can.json' with { type: 'json' };
import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import recipientCanProtocolDefinition from '../vectors/protocol-definitions/recipient-can.json' with { type: 'json' };
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };

import { ArrayUtility } from '../../src/utils/array.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH } from '../../src/core/constants.js';
import { Message } from '../../src/core/message.js';
import { MessageStoreLevel } from '../../src/store/level.js';
import { normalizeSchemaUrl } from '../../src/utils/url.js';
import { Poller } from '../utils/poller.js';
import { RecordsDeleteHandler } from '../../src/handlers/records-delete.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { Time } from '../../src/utils/time.js';
import { DataStream, Dwn, Encoder, Jws, PermissionsProtocol, Protocols, RecordsDelete, RecordsRead, RecordsWrite } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';
import { Encryption, KeyAgreementAlgorithm } from '../../src/utils/encryption.js';

import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';

export function testRecordsDeleteHandler(): void {
  describe('RecordsDeleteHandler.handle()', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    beforeEach(() => {
      sinon.restore();
    });

    afterAll(() => {
      sinon.restore();
    });

    describe('functional tests', () => {

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
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('should handle RecordsDelete successfully and accept a newer tombstone over a deleted record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert data
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // ensure data is inserted
        const queryData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: message.recordId }
        });

        const reply = await dwn.processMessage(alice.did, queryData.message);
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(1);

        // testing delete
        const recordsDelete = await RecordsDelete.create({
          recordId : message.recordId,
          signer   : Jws.createSigner(alice)
        });

        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // ensure a query will no longer find the deleted record
        const reply2 = await dwn.processMessage(alice.did, queryData.message);
        expect(reply2.status.code).toBe(200);
        expect(reply2.entries?.length).toBe(0);

        // a newer tombstone displaces the older one — one canonical winner per record
        const recordsDelete2 = await RecordsDelete.create({
          recordId : message.recordId,
          signer   : Jws.createSigner(alice)
        });

        const recordsDelete2Reply = await dwn.processMessage(alice.did, recordsDelete2.message);
        expect(recordsDelete2Reply.status.code).toBe(202);
      });

      it('should not affect other records or tenants with the same data', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        await TestDataGenerator.installDefaultTestProtocol(dwn, bob);
        const data = Encoder.stringToBytes('test');

        // alice writes a records with data
        const aliceWriteData = await TestDataGenerator.generateRecordsWrite({ author: alice, data });
        const aliceWriteReply = await dwn.processMessage(alice.did, aliceWriteData.message, { dataStream: aliceWriteData.dataStream });
        expect(aliceWriteReply.status.code).toBe(202);

        // alice writes another record with the same data
        const aliceWrite2Data = await TestDataGenerator.generateRecordsWrite({ author: alice, data });
        const aliceWrite2Reply = await dwn.processMessage(alice.did, aliceWrite2Data.message, { dataStream: aliceWrite2Data.dataStream });
        expect(aliceWrite2Reply.status.code).toBe(202);

        // bob writes a records with same data
        const bobWriteData = await TestDataGenerator.generateRecordsWrite({ author: bob, data });
        const bobWriteReply = await dwn.processMessage(bob.did, bobWriteData.message, { dataStream: bobWriteData.dataStream });
        expect(bobWriteReply.status.code).toBe(202);

        // bob writes another record with the same data
        const bobWrite2Data = await TestDataGenerator.generateRecordsWrite({ author: bob, data });
        const bobWrite2Reply = await dwn.processMessage(bob.did, bobWrite2Data.message, { dataStream: bobWrite2Data.dataStream });
        expect(bobWrite2Reply.status.code).toBe(202);

        // alice deletes one of the two records
        const aliceDeleteWriteData = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : aliceWriteData.message.recordId
        });
        const aliceDeleteWriteReply = await dwn.processMessage(alice.did, aliceDeleteWriteData.message);
        expect(aliceDeleteWriteReply.status.code).toBe(202);

        // verify the other record with the same data is unaffected
        const aliceRead1 = await RecordsRead.create({
          filter: {
            recordId: aliceWrite2Data.message.recordId,
          },
          signer: Jws.createSigner(alice)
        });

        const aliceRead1Reply = await dwn.processMessage(alice.did, aliceRead1.message);
        expect(aliceRead1Reply.status.code).toBe(200);

        const aliceDataFetched = await DataStream.toBytes(aliceRead1Reply.entry!.data!);
        expect(ArrayUtility.byteArraysEqual(aliceDataFetched, data)).toBe(true);

        // alice deletes the other record
        const aliceDeleteWrite2Data = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : aliceWrite2Data.message.recordId
        });
        const aliceDeleteWrite2Reply = await dwn.processMessage(alice.did, aliceDeleteWrite2Data.message);
        expect(aliceDeleteWrite2Reply.status.code).toBe(202);

        // verify that alice can no longer fetch the 2nd record
        const aliceRead2Reply = await dwn.processMessage(alice.did, aliceRead1.message);
        expect(aliceRead2Reply.status.code).toBe(404);

        // verify that bob can still fetch record with the same data
        const bobRead1 = await RecordsRead.create({
          filter: {
            recordId: bobWriteData.message.recordId,
          },
          signer: Jws.createSigner(bob)
        });

        const bobRead1Reply = await dwn.processMessage(bob.did, bobRead1.message);
        expect(bobRead1Reply.status.code).toBe(200);

        const bobDataFetched = await DataStream.toBytes(bobRead1Reply.entry!.data!);
        expect(ArrayUtility.byteArraysEqual(bobDataFetched, data)).toBe(true);
      });

      it('should return 404 if deleting a non-existent record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // testing deleting a non-existent record
        const recordsDelete = await RecordsDelete.create({
          recordId : 'nonExistentRecordId',
          signer   : Jws.createSigner(alice)
        });

        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(404);
      });

      it('should reject deleting encryption control records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-delete-rejected.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedProtocolDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
          protocolDefinition, alice.keyId, alice.encryptionKeyPair.privateJwk
        );
        const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : encryptedProtocolDefinition,
        });
        expect((await dwn.processMessage(alice.did, protocolConfig.message)).status.code).toBe(202);

        const roleRuleSet = encryptedProtocolDefinition.structure.member as ProtocolRuleSet;
        const audienceKeyId = await Encryption.getKeyId(alice.encryptionKeyPair.publicJwk);
        const sealKeyId = await Encryption.getKeyId(roleRuleSet.$keyAgreement!.publicKeyJwk);
        const audienceData = Encoder.objectToBytes({
          protocol         : protocolDefinition.protocol,
          rolePath         : 'member',
          contextId        : '',
          keyId            : audienceKeyId,
          publicKeyJwk     : alice.encryptionKeyPair.publicJwk,
          sealedPrivateKey : {
            algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            derivationScheme   : 'seal',
            keyId              : sealKeyId,
            ephemeralPublicKey : alice.encryptionKeyPair.publicJwk,
            encryptedKey       : Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(32)),
          },
        });
        const audience = await RecordsWrite.create({
          data         : audienceData,
          dataFormat   : 'application/json',
          protocol     : protocolDefinition.protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          schema       : 'https://identity.foundation/dwn/json-schemas/encryption/audience.json',
          signer       : Jws.createSigner(alice),
          tags         : {
            protocol  : protocolDefinition.protocol,
            rolePath  : 'member',
            contextId : '',
            keyId     : audienceKeyId,
          },
        });
        const writeReply = await dwn.processMessage(alice.did, audience.message, { dataStream: DataStream.fromBytes(audienceData) });
        expect(writeReply.status.code).toBe(202);

        const recordsDelete = await RecordsDelete.create({
          recordId : audience.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(400);
        expect(deleteReply.status.detail).toContain(DwnErrorCode.EncryptionControlValidateUnexpectedRecord);

        const queryData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: audience.message.recordId },
        });
        const queryReply = await dwn.processMessage(alice.did, queryData.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(1);
      });

      it('should apply a tombstone over a newer RecordsWrite (delete-wins)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // initial write
        const initialWriteData = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const initialWriteReply = await dwn.processMessage(alice.did, initialWriteData.message, { dataStream: initialWriteData.dataStream });
        expect(initialWriteReply.status.code).toBe(202);

        // generate subsequent write and delete with the delete having an earlier timestamp
        // NOTE: creating RecordsDelete first ensures it has an earlier `messageTimestamp` time
        const recordsDelete = await RecordsDelete.create({
          recordId : initialWriteData.message.recordId,
          signer   : Jws.createSigner(alice)
        });
        await Time.minimalSleep();
        const subsequentWriteData = await TestDataGenerator.generateFromRecordsWrite({
          existingWrite : initialWriteData.recordsWrite,
          author        : alice
        });

        // subsequent write
        const subsequentWriteReply = await dwn.processMessage(alice.did, subsequentWriteData.message, { dataStream: subsequentWriteData.dataStream });
        expect(subsequentWriteReply.status.code).toBe(202);

        // the tombstone displaces the newer write regardless of timestamp (delete-wins) so
        // that replicas converge on the same terminal state no matter the arrival order
        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // the record reads as deleted and the displaced write is gone
        const queryData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: initialWriteData.message.recordId }
        });
        const reply = await dwn.processMessage(alice.did, queryData.message);
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(0);
      });

      it('should apply a stale prune over the record\'s newest plain tombstone (prune dominates)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const initialWriteData = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const initialWriteReply = await dwn.processMessage(alice.did, initialWriteData.message, { dataStream: initialWriteData.dataStream });
        expect(initialWriteReply.status.code).toBe(202);

        // generate the prune first so its timestamp is older than the tombstone admitted below
        const stalePrune = await RecordsDelete.create({
          recordId : initialWriteData.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(alice)
        });
        await Time.minimalSleep();
        const recordsDelete = await RecordsDelete.create({
          recordId : initialWriteData.message.recordId,
          signer   : Jws.createSigner(alice)
        });
        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // prune dominates plain regardless of timestamp — the cascade must run on every replica
        const stalePruneReply = await dwn.processMessage(alice.did, stalePrune.message);
        expect(stalePruneReply.status.code).toBe(202);
      });

      it('should return 409 for a plain delete beaten by the record\'s newest tombstone', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const initialWriteData = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const initialWriteReply = await dwn.processMessage(alice.did, initialWriteData.message, { dataStream: initialWriteData.dataStream });
        expect(initialWriteReply.status.code).toBe(202);

        // generate the losing delete first so its timestamp is older than the winner's
        const staleDelete = await RecordsDelete.create({
          recordId : initialWriteData.message.recordId,
          signer   : Jws.createSigner(alice)
        });
        await Time.minimalSleep();
        const recordsDelete = await RecordsDelete.create({
          recordId : initialWriteData.message.recordId,
          signer   : Jws.createSigner(alice)
        });
        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // same class, older timestamp: Conflict no-op, the canonical winner stands
        const staleDeleteReply = await dwn.processMessage(alice.did, staleDelete.message);
        expect(staleDeleteReply.status.code).toBe(409);
      });

      it('should be able to delete then rewrite the same data', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const data = Encoder.stringToBytes('test');
        const encodedData = Encoder.bytesToBase64Url(data);

        // alice writes a record
        const aliceWriteData = await TestDataGenerator.generateRecordsWrite({
          author: alice,
          data
        });
        const aliceWriteReply = await dwn.processMessage(alice.did, aliceWriteData.message, { dataStream: aliceWriteData.dataStream });
        expect(aliceWriteReply.status.code).toBe(202);

        const aliceQueryWriteAfterAliceWriteData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: aliceWriteData.message.recordId }
        });
        const aliceQueryWriteAfterAliceWriteReply = await dwn.processMessage(alice.did, aliceQueryWriteAfterAliceWriteData.message);
        expect(aliceQueryWriteAfterAliceWriteReply.status.code).toBe(200);
        expect(aliceQueryWriteAfterAliceWriteReply.entries?.length).toBe(1);
        expect(aliceQueryWriteAfterAliceWriteReply.entries![0].encodedData).toBe(encodedData);

        // alice deleting the record
        const aliceDeleteWriteData = await TestDataGenerator.generateRecordsDelete({
          author   : alice,
          recordId : aliceWriteData.message.recordId
        });
        const aliceDeleteWriteReply = await dwn.processMessage(alice.did, aliceDeleteWriteData.message);
        expect(aliceDeleteWriteReply.status.code).toBe(202);

        const aliceQueryWriteAfterAliceDeleteData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: aliceWriteData.message.recordId }
        });
        const aliceQueryWriteAfterAliceDeleteReply = await dwn.processMessage(alice.did, aliceQueryWriteAfterAliceDeleteData.message);
        expect(aliceQueryWriteAfterAliceDeleteReply.status.code).toBe(200);
        expect(aliceQueryWriteAfterAliceDeleteReply.entries?.length).toBe(0);

        // alice writes a new record with the same data
        const aliceRewriteData = await TestDataGenerator.generateRecordsWrite({
          author: alice,
          data
        });
        const aliceRewriteReply = await dwn.processMessage(alice.did, aliceRewriteData.message, { dataStream: aliceRewriteData.dataStream });
        expect(aliceRewriteReply.status.code).toBe(202);

        const aliceQueryWriteAfterAliceRewriteData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: aliceRewriteData.message.recordId }
        });
        const aliceQueryWriteAfterAliceRewriteReply = await dwn.processMessage(alice.did, aliceQueryWriteAfterAliceRewriteData.message);
        expect(aliceQueryWriteAfterAliceRewriteReply.status.code).toBe(200);
        expect(aliceQueryWriteAfterAliceRewriteReply.entries?.length).toBe(1);
        expect(aliceQueryWriteAfterAliceRewriteReply.entries![0].encodedData).toBe(encodedData);
      });

      describe('protocol based deletes', () => {
        it('should allow delete with allow-anyone rule', async () => {
          // scenario: Alice creates a record in her DWN. Bob (anyone) is able to delete the record.

          const protocolDefinition = anyoneCollaborateProtocolDefinition as ProtocolDefinition;
          const alice = await TestDataGenerator.generatePersona();
          const bob = await TestDataGenerator.generatePersona();

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });

          // setting up a stub DID resolver
          TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a record
          const recordsWrite = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'doc',
          });
          const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream: recordsWrite.dataStream });
          expect(recordsWriteReply.status.code).toBe(202);

          // Bob (anyone) is able to delete the record
          const recordsDelete = await TestDataGenerator.generateRecordsDelete({
            author   : bob,
            recordId : recordsWrite.message.recordId,
          });
          const recordsDeleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(recordsDeleteReply.status.code).toBe(202);
        });

        describe('recipient rules', () => {
          it('should allow delete with ancestor recipient rule', async () => {
            // scenario: Alice creates a 'post' with Bob as recipient and a 'post/tag'. Bob is able to delete
            //           the 'chat/tag' because he was recipient of the 'chat'. Carol is not able to delete.

            const protocolDefinition = recipientCanProtocolDefinition as ProtocolDefinition;
            const alice = await TestDataGenerator.generatePersona();
            const bob = await TestDataGenerator.generatePersona();
            const carol = await TestDataGenerator.generatePersona();

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });

            // setting up a stub DID resolver
            TestStubGenerator.stubDidResolver(didResolver, [alice, bob, carol]);

            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice writes a chat
            const chatRecordsWrite = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : bob.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'post',
            });
            const chatRecordsWriteReply = await dwn.processMessage(alice.did, chatRecordsWrite.message, { dataStream: chatRecordsWrite.dataStream });
            expect(chatRecordsWriteReply.status.code).toBe(202);

            // Alice writes a 'chat/tag'
            const tagRecordsWrite = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'post/tag',
              parentContextId : chatRecordsWrite.message.contextId,
            });
            const tagRecordsWriteReply = await dwn.processMessage(alice.did, tagRecordsWrite.message, { dataStream: tagRecordsWrite.dataStream });
            expect(tagRecordsWriteReply.status.code).toBe(202);

            // Carol is unable to delete the 'chat/tag'
            const recordsDeleteCarol = await TestDataGenerator.generateRecordsDelete({
              author   : carol,
              recordId : tagRecordsWrite.message.recordId,
            });
            const recordsDeleteCarolReply = await dwn.processMessage(alice.did, recordsDeleteCarol.message);
            expect(recordsDeleteCarolReply.status.code).toBe(401);
            expect(recordsDeleteCarolReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

            // Bob is able to delete the 'chat/tag'
            const recordsDelete = await TestDataGenerator.generateRecordsDelete({
              author   : bob,
              recordId : tagRecordsWrite.message.recordId,
            });
            const recordsDeleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
            expect(recordsDeleteReply.status.code).toBe(202);
          });

          it('should allow delete with direct recipient rule', async () => {
            // scenario: Alice creates a 'post' with Bob as recipient. Bob is able to delete
            //           the 'post' because he was recipient of it. Carol is not able to delete.

            const protocolDefinition = recipientCanProtocolDefinition as ProtocolDefinition;
            const alice = await TestDataGenerator.generatePersona();
            const bob = await TestDataGenerator.generatePersona();
            const carol = await TestDataGenerator.generatePersona();

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });

            // setting up a stub DID resolver
            TestStubGenerator.stubDidResolver(didResolver, [alice, bob, carol]);

            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice creates a 'post' with Bob as recipient
            const recordsWrite = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : bob.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'post',
            });
            const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream: recordsWrite.dataStream });
            expect(recordsWriteReply.status.code).toBe(202);

            // Carol is unable to delete the 'post'
            const carolRecordsDelete = await TestDataGenerator.generateRecordsDelete({
              author   : carol,
              recordId : recordsWrite.message.recordId,
            });
            const carolRecordsDeleteReply = await dwn.processMessage(alice.did, carolRecordsDelete.message);
            expect(carolRecordsDeleteReply.status.code).toBe(401);
            expect(carolRecordsDeleteReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

            // Bob is able to delete the post
            const bobRecordsDelete = await TestDataGenerator.generateRecordsDelete({
              author   : bob,
              recordId : recordsWrite.message.recordId,
            });
            const bobRecordsDeleteReply = await dwn.processMessage(alice.did, bobRecordsDelete.message);
            expect(bobRecordsDeleteReply.status.code).toBe(202);
          });
        });

        describe('author action rules', () => {
          it('allow author to delete with ancestor author rule', async () => {
            // scenario: Bob writes a 'post' and Alice writes a 'post/comment' to her DWN. Bob deletes the comment
            //           because author of post can delete. Carol is unable to delete the comment.

            const protocolDefinition = authorCanProtocolDefinition as ProtocolDefinition;
            const alice = await TestDataGenerator.generatePersona();
            const bob = await TestDataGenerator.generatePersona();
            const carol = await TestDataGenerator.generatePersona();

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });

            // setting up a stub DID resolver
            TestStubGenerator.stubDidResolver(didResolver, [alice, bob, carol]);

            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Bob writes a post
            const postRecordsWrite = await TestDataGenerator.generateRecordsWrite({
              author       : bob,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'post',
            });
            const postRecordsWriteReply = await dwn.processMessage(alice.did, postRecordsWrite.message, { dataStream: postRecordsWrite.dataStream });
            expect(postRecordsWriteReply.status.code).toBe(202);

            // Alice writes a 'post/comment'
            const commentRecordsWrite = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'post/comment',
              parentContextId : postRecordsWrite.message.contextId,
            });
            const commentRecordsWriteReply =
              await dwn.processMessage(alice.did, commentRecordsWrite.message, { dataStream: commentRecordsWrite.dataStream });
            expect(commentRecordsWriteReply.status.code).toBe(202);

            // Carol is unable to delete Alice's 'post/comment'
            const recordsDeleteCarol = await TestDataGenerator.generateRecordsDelete({
              author   : carol,
              recordId : commentRecordsWrite.message.recordId,
            });
            const recordsDeleteCarolReply = await dwn.processMessage(alice.did, recordsDeleteCarol.message);
            expect(recordsDeleteCarolReply.status.code).toBe(401);
            expect(recordsDeleteCarolReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

            // Bob is able to delete the Alice's 'post/comment'
            const recordsDelete = await TestDataGenerator.generateRecordsDelete({
              author   : bob,
              recordId : commentRecordsWrite.message.recordId,
            });
            const recordsDeleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
            expect(recordsDeleteReply.status.code).toBe(202);
          });
        });

        describe('role based deletes', () => {
          it('should allow co-delete by invoking a context role', async () => {
            // scenario: Alice adds Bob as a 'thread/admin' role. She writes a 'thread/chat'.
            //           Bob invokes his admin role to delete the 'thread/chat'. Carol is unable to delete
            //           the 'thread/chat'.

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

            // Alice creates a thread
            const threadRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : bob.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread'
            });
            const threadRecordReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
            expect(threadRecordReply.status.code).toBe(202);

            // Alice adds Bob as a 'thread/admin' in that thread
            const participantRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : bob.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/admin',
              parentContextId : threadRecord.message.contextId,
            });
            const participantRecordReply =
              await dwn.processMessage(alice.did, participantRecord.message, { dataStream: participantRecord.dataStream });
            expect(participantRecordReply.status.code).toBe(202);

            // Alice writes a chat message in that thread
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              parentContextId : threadRecord.message.contextId,
            });
            const chatRecordReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatRecordReply.status.code).toBe(202);

            // Verifies that Carol cannot delete without appropriate role
            const chatDeleteCarol = await TestDataGenerator.generateRecordsDelete({
              author   : carol,
              recordId : chatRecord.message.recordId,
            });
            const chatDeleteReplyCarol = await dwn.processMessage(alice.did, chatDeleteCarol.message);
            expect(chatDeleteReplyCarol.status.code).toBe(401);
            expect(chatDeleteReplyCarol.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

            // Bob invokes the role to delete the chat message
            const chatDelete = await TestDataGenerator.generateRecordsDelete({
              author       : bob,
              recordId     : chatRecord.message.recordId,
              protocolRole : 'thread/admin',
            });
            const chatDeleteReply = await dwn.processMessage(alice.did, chatDelete.message);
            expect(chatDeleteReply.status.code).toBe(202);
          });

          it('should allow co-delete invoking a root-level role', async () => {
            // scenario: Alice adds Bob as a root-level 'admin' role. She writes a 'chat'.
            //           Bob invokes his admin role to delete the 'chat'.

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

            // Alice adds Bob as a 'thread/admin' in that thread
            const participantRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : bob.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'admin',
            });
            const participantRecordReply =
              await dwn.processMessage(alice.did, participantRecord.message, { dataStream: participantRecord.dataStream });
            expect(participantRecordReply.status.code).toBe(202);

            // Alice writes a chat message in that thread
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
            });
            const chatRecordReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatRecordReply.status.code).toBe(202);

            // Carol is unable to delete the chat message
            const chatDeleteCarol = await TestDataGenerator.generateRecordsDelete({
              author   : carol,
              recordId : chatRecord.message.recordId,
            });
            const chatDeleteCarolReply = await dwn.processMessage(alice.did, chatDeleteCarol.message);
            expect(chatDeleteCarolReply.status.code).toBe(401);
            expect(chatDeleteCarolReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);

            // Bob invokes the role to delete the chat message
            const chatDelete = await TestDataGenerator.generateRecordsDelete({
              author       : bob,
              recordId     : chatRecord.message.recordId,
              protocolRole : 'admin',
            });
            const chatDeleteReply = await dwn.processMessage(alice.did, chatDelete.message);
            expect(chatDeleteReply.status.code).toBe(202);
          });
        });
      });

      it('should return 401 if message is not authorized', async () => {
        // scenario: Alice creates a record and Bob is unable to delete it.

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const recordsWrite = await TestDataGenerator.generateRecordsWrite({
          author: alice,
        });
        const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream: recordsWrite.dataStream });
        expect(recordsWriteReply.status.code).toBe(202);

        const recordsDelete = await TestDataGenerator.generateRecordsDelete({
          author   : bob,
          recordId : recordsWrite.message.recordId,
        });
        const recordsDeleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(recordsDeleteReply.status.code).toBe(401);
      });

      describe('grant based deletes', () => {
        it('should allow delete with a matching protocol grant scope', async () => {
          // scenario: Alice writes a protocol record, grants Bob delete permission, Bob deletes it.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition: ProtocolDefinition = {
            protocol  : 'http://grant-delete-test.xyz',
            published : false,
            types     : { foo: {} },
            structure : { foo: {} }
          };

          // Alice installs the protocol
          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a record
          const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'foo',
          });
          const writeReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
          expect(writeReply.status.code).toBe(202);

          // Alice grants Bob delete permission scoped to the protocol
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Delete,
              protocol  : protocolDefinition.protocol,
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const grantWriteReply = await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: grantDataStream }
          );
          expect(grantWriteReply.status.code).toBe(202);

          // Bob deletes the record using the grant
          const recordsDelete = await RecordsDelete.create({
            recordId          : recordsWrite.message.recordId,
            signer            : Jws.createSigner(bob),
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(deleteReply.status.code).toBe(202);
        });

        it('should reject delete when grant has mismatching protocol scope', async () => {
          // scenario: Alice grants Bob delete permission for protocol A,
          //           Bob tries to delete a record in protocol B.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolA: ProtocolDefinition = {
            protocol  : 'http://protocol-a.xyz',
            published : false,
            types     : { foo: {} },
            structure : { foo: {} }
          };
          const protocolB: ProtocolDefinition = {
            protocol  : 'http://protocol-b.xyz',
            published : false,
            types     : { foo: {} },
            structure : { foo: {} }
          };

          // Alice installs both protocols
          const configA = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: protocolA });
          expect((await dwn.processMessage(alice.did, configA.message)).status.code).toBe(202);
          const configB = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: protocolB });
          expect((await dwn.processMessage(alice.did, configB.message)).status.code).toBe(202);

          // Alice writes a record in protocol B
          const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolB.protocol,
            protocolPath : 'foo',
          });
          const writeReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
          expect(writeReply.status.code).toBe(202);

          // Alice grants Bob delete permission scoped to protocol A (not B)
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Delete,
              protocol  : protocolA.protocol,
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          expect((await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream: grantDataStream })).status.code).toBe(202);

          // Bob tries to delete the protocol B record with the protocol A grant — should fail
          const recordsDelete = await RecordsDelete.create({
            recordId          : recordsWrite.message.recordId,
            signer            : Jws.createSigner(bob),
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(deleteReply.status.code).toBe(401);
          expect(deleteReply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationDeleteProtocolScopeMismatch);
        });

      });

      it('should index additional properties from the RecordsWrite being deleted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // initial write
        const initialWriteData = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'testSchema' });
        const initialWriteReply = await dwn.processMessage(alice.did, initialWriteData.message, { dataStream: initialWriteData.dataStream });
        expect(initialWriteReply.status.code).toBe(202);

        // generate subsequent write and delete with the delete having an earlier timestamp
        // NOTE: creating RecordsDelete first ensures it has an earlier `messageTimestamp` time
        const recordsDelete = await RecordsDelete.create({
          recordId : initialWriteData.message.recordId,
          signer   : Jws.createSigner(alice)
        });
        const deleteMessageCid = await Message.getCid(recordsDelete.message);

        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // message store
        const { messages } = await messageStore.query(alice.did, [{ schema: normalizeSchemaUrl('testSchema'), method: DwnMethodName.Delete }]);
        expect(messages.length).toBe(1);
        expect(await Message.getCid(messages[0])).toBe(deleteMessageCid);

      });

      describe('tombstone visibility facts', () => {
        it('should construct a tombstone matching the permission shadow filter when a tagged permission record is deleted', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // alice creates a permission grant scoped to a protocol — the grant record carries `tags: { protocol }`
          const scopedProtocol = 'https://example.com/protocol/shadow-filter-test';
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              protocol  : scopedProtocol,
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const grantWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream: grantDataStream });
          expect(grantWriteReply.status.code).toBe(202);

          // the permission shadow filter shape matches the live grant record
          const shadowFilter = { 'protocol': PermissionsProtocol.uri, 'tag.protocol': scopedProtocol };
          const { messages: liveMatches } = await messageStore.query(alice.did, [shadowFilter]);
          expect(liveMatches.length).toBe(1);

          // alice deletes the grant record
          const recordsDelete = await RecordsDelete.create({
            recordId : permissionGrant.recordsWrite.message.recordId,
            signer   : Jws.createSigner(alice)
          });
          const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(deleteReply.status.code).toBe(202);

          // the tombstone is now the only message matching the shadow filter:
          // the retained initial write no longer indexes tags once displaced from the latest base state
          const { messages: matchesAfterDelete } = await messageStore.query(alice.did, [shadowFilter]);
          expect(matchesAfterDelete.length).toBe(1);
          expect(await Message.getCid(matchesAfterDelete[0])).toBe(await Message.getCid(recordsDelete.message));
          expect(matchesAfterDelete[0].descriptor.method).toBe(DwnMethodName.Delete);
        });

        it('should carry `published` and `datePublished` onto the tombstone so it matches published queries and subscriptions', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const datePublished = '2025-01-01T00:00:00.000000Z';
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // subscribe to date-published records of the test schema before any writes
          const receivedEvents: RecordEvent[] = [];
          const subscriptionHandler: SubscriptionListener = (message): void => {
            if (message.type === 'event') {
              receivedEvents.push(message.event as RecordEvent);
            }
          };
          const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : alice,
            filter : { schema: 'http://published-tombstone', datePublished: { from: datePublished } },
          });
          const subscribeReply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler });
          expect(subscribeReply.status.code).toBe(200);

          // a published and an unpublished record
          const publishedWrite = await TestDataGenerator.generateRecordsWrite({
            author    : alice,
            schema    : 'http://published-tombstone',
            published : true,
            datePublished,
          });
          const publishedWriteReply = await dwn.processMessage(alice.did, publishedWrite.message, { dataStream: publishedWrite.dataStream });
          expect(publishedWriteReply.status.code).toBe(202);

          const unpublishedWrite = await TestDataGenerator.generateRecordsWrite({
            author : alice,
            schema : 'http://published-tombstone',
          });
          const unpublishedWriteReply = await dwn.processMessage(alice.did, unpublishedWrite.message, { dataStream: unpublishedWrite.dataStream });
          expect(unpublishedWriteReply.status.code).toBe(202);

          // delete both records
          const publishedDelete = await RecordsDelete.create({
            recordId : publishedWrite.message.recordId,
            signer   : Jws.createSigner(alice)
          });
          const publishedDeleteReply = await dwn.processMessage(alice.did, publishedDelete.message);
          expect(publishedDeleteReply.status.code).toBe(202);

          const unpublishedDelete = await RecordsDelete.create({
            recordId : unpublishedWrite.message.recordId,
            signer   : Jws.createSigner(alice)
          });
          const unpublishedDeleteReply = await dwn.processMessage(alice.did, unpublishedDelete.message);
          expect(unpublishedDeleteReply.status.code).toBe(202);

          // the published record's tombstone matches a `published: true` message store filter; the unpublished one's does not
          const publishedTombstoneFilter = {
            method    : DwnMethodName.Delete,
            published : true,
            datePublished,
            schema    : normalizeSchemaUrl('http://published-tombstone'),
          };
          const { messages: publishedTombstones } = await messageStore.query(alice.did, [publishedTombstoneFilter]);
          expect(publishedTombstones.length).toBe(1);
          expect(await Message.getCid(publishedTombstones[0])).toBe(await Message.getCid(publishedDelete.message));

          // the subscription receives the published record's write and delete events only
          await Poller.pollUntilSuccessOrTimeout(async () => {
            expect(receivedEvents.length).toBe(2);
          });
          const writeEvents = receivedEvents.filter((event) => event.message.descriptor.method === DwnMethodName.Write);
          const deleteEvents = receivedEvents.filter((event) => event.message.descriptor.method === DwnMethodName.Delete);
          expect(writeEvents.length).toBe(1);
          expect((writeEvents[0].message as RecordsWriteMessage).recordId).toBe(publishedWrite.message.recordId);
          expect(deleteEvents.length).toBe(1);
          expect((deleteEvents[0].message as RecordsDeleteMessage).descriptor.recordId).toBe(publishedWrite.message.recordId);

          await subscribeReply.subscription!.close();
        });

        it('should take mutable visibility facts from the latest pre-delete write and immutable facts from the initial write', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const datePublished = '2025-01-02T00:00:00.000000Z';
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // initial write: unpublished, tagged red
          const initialWriteData = await TestDataGenerator.generateRecordsWrite({
            author : alice,
            schema : 'http://visibility-facts',
            tags   : { team: 'red' },
          });
          const initialWriteReply = await dwn.processMessage(alice.did, initialWriteData.message, { dataStream: initialWriteData.dataStream });
          expect(initialWriteReply.status.code).toBe(202);

          // update: published, tagged blue
          const updateWrite = await RecordsWrite.createFrom({
            recordsWriteMessage : initialWriteData.message,
            published           : true,
            datePublished,
            tags                : { team: 'blue' },
            signer              : Jws.createSigner(alice),
          });
          const updateReply = await dwn.processMessage(alice.did, updateWrite.message);
          expect(updateReply.status.code).toBe(202);

          const recordsDelete = await RecordsDelete.create({
            recordId : initialWriteData.message.recordId,
            signer   : Jws.createSigner(alice)
          });
          const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(deleteReply.status.code).toBe(202);

          const deleteMessageCid = await Message.getCid(recordsDelete.message);

          // mutable facts come from the update that was the latest write immediately before deletion
          const { messages: blueMatches } = await messageStore.query(alice.did, [{ 'method': DwnMethodName.Delete, 'tag.team': 'blue' }]);
          expect(blueMatches.length).toBe(1);
          expect(await Message.getCid(blueMatches[0])).toBe(deleteMessageCid);

          const { messages: redMatches } = await messageStore.query(alice.did, [{ 'method': DwnMethodName.Delete, 'tag.team': 'red' }]);
          expect(redMatches.length).toBe(0);

          // immutable facts still come from the initial write
          const { messages: immutableMatches } = await messageStore.query(alice.did, [{
            method      : DwnMethodName.Delete,
            schema      : normalizeSchemaUrl('http://visibility-facts'),
            dateCreated : initialWriteData.message.descriptor.dateCreated,
            published   : true,
            datePublished,
          }]);
          expect(immutableMatches.length).toBe(1);
          expect(await Message.getCid(immutableMatches[0])).toBe(deleteMessageCid);
        });

        it('should carry the existing tombstone visibility facts forward when pruning an already-deleted record', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const datePublished = '2025-01-03T00:00:00.000000Z';
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // initial write: unpublished, tagged red
          const initialWriteData = await TestDataGenerator.generateRecordsWrite({
            author : alice,
            tags   : { team: 'red' },
          });
          const initialWriteReply = await dwn.processMessage(alice.did, initialWriteData.message, { dataStream: initialWriteData.dataStream });
          expect(initialWriteReply.status.code).toBe(202);

          // update: published, tagged blue
          const updateWrite = await RecordsWrite.createFrom({
            recordsWriteMessage : initialWriteData.message,
            published           : true,
            datePublished,
            tags                : { team: 'blue' },
            signer              : Jws.createSigner(alice),
          });
          const updateReply = await dwn.processMessage(alice.did, updateWrite.message);
          expect(updateReply.status.code).toBe(202);

          // plain delete: the tombstone carries the record's visibility facts
          const plainDelete = await RecordsDelete.create({
            recordId : initialWriteData.message.recordId,
            signer   : Jws.createSigner(alice)
          });
          const plainDeleteReply = await dwn.processMessage(alice.did, plainDelete.message);
          expect(plainDeleteReply.status.code).toBe(202);

          await Time.minimalSleep();

          // prune of the already-deleted record: displaces the plain tombstone (prune beats plain)
          const pruneDelete = await RecordsDelete.create({
            recordId : initialWriteData.message.recordId,
            prune    : true,
            signer   : Jws.createSigner(alice)
          });
          const pruneDeleteReply = await dwn.processMessage(alice.did, pruneDelete.message);
          expect(pruneDeleteReply.status.code).toBe(202);

          // exactly one tombstone matches the visibility facts and it is the prune
          const { messages: tombstones } = await messageStore.query(alice.did, [{
            'method'        : DwnMethodName.Delete,
            'tag.team'      : 'blue',
            'published'     : true,
            'datePublished' : datePublished
          }]);
          expect(tombstones.length).toBe(1);
          expect(await Message.getCid(tombstones[0])).toBe(await Message.getCid(pruneDelete.message));
          expect((tombstones[0] as RecordsDeleteMessage).descriptor.prune).toBe(true);

          const { messages: redMatches } = await messageStore.query(alice.did, [{ 'method': DwnMethodName.Delete, 'tag.team': 'red' }]);
          expect(redMatches.length).toBe(0);
        });

        it('should carry the displaced newer write tags and published state when a tombstone applies over it (delete-wins)', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const datePublished = '2025-01-04T00:00:00.000000Z';
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // initial write: unpublished, tagged red
          const initialWriteData = await TestDataGenerator.generateRecordsWrite({
            author : alice,
            tags   : { team: 'red' },
          });
          const initialWriteReply = await dwn.processMessage(alice.did, initialWriteData.message, { dataStream: initialWriteData.dataStream });
          expect(initialWriteReply.status.code).toBe(202);

          // create the tombstone BEFORE the update so its `messageTimestamp` is older than the update's
          const recordsDelete = await RecordsDelete.create({
            recordId : initialWriteData.message.recordId,
            signer   : Jws.createSigner(alice)
          });
          await Time.minimalSleep();

          // newer update: published, tagged blue
          const updateWrite = await RecordsWrite.createFrom({
            recordsWriteMessage : initialWriteData.message,
            published           : true,
            datePublished,
            tags                : { team: 'blue' },
            signer              : Jws.createSigner(alice),
          });
          const updateReply = await dwn.processMessage(alice.did, updateWrite.message);
          expect(updateReply.status.code).toBe(202);

          // the older tombstone still applies over the newer write (delete-wins)
          const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(deleteReply.status.code).toBe(202);

          // tombstone visibility facts reflect the displaced newer write
          const { messages: blueMatches } = await messageStore.query(alice.did, [{
            'method'        : DwnMethodName.Delete,
            'tag.team'      : 'blue',
            'published'     : true,
            'datePublished' : datePublished
          }]);
          expect(blueMatches.length).toBe(1);
          expect(await Message.getCid(blueMatches[0])).toBe(await Message.getCid(recordsDelete.message));

          const { messages: redMatches } = await messageStore.query(alice.did, [{ 'method': DwnMethodName.Delete, 'tag.team': 'red' }]);
          expect(redMatches.length).toBe(0);
        });
      });

      describe('state index', () => {
        it('should include RecordsDelete event and keep initial RecordsWrite event', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);

          const recordsDelete = await RecordsDelete.create({
            recordId : message.recordId,
            signer   : Jws.createSigner(alice)
          });

          const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(deleteReply.status.code).toBe(202);

          const writeMessageCid = await Message.getCid(message);
          const deleteMessageCid = await Message.getCid(recordsDelete.message);
          const expectedMessageCids = new Set([writeMessageCid, deleteMessageCid]);
          const { messages } = await messageStore.query(alice.did, [{ recordId: message.recordId }]);

          for (const storedMessage of messages) {
            const messageCid = await Message.getCid(storedMessage);
            expectedMessageCids.delete(messageCid);
          }

          expect(expectedMessageCids.size).toBe(0);
        });

        it('should keep first write, latest pre-delete write, and delete when subsequent writes happen', async () => {
          const author = await TestDataGenerator.generatePersona();
          TestStubGenerator.stubDidResolver(didResolver, [author]);
          await TestDataGenerator.installDefaultTestProtocol(dwn, author);

          const { message, dataStream, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author });

          const reply = await dwn.processMessage(author.did, message, { dataStream });
          expect(reply.status.code).toBe(202);

          const newWrite = await RecordsWrite.createFrom({
            recordsWriteMessage : recordsWrite.message,
            published           : true,
            signer              : Jws.createSigner(author)
          });

          const newWriteReply = await dwn.processMessage(author.did, newWrite.message);
          expect(newWriteReply.status.code).toBe(202);

          const recordsDelete = await RecordsDelete.create({
            recordId : message.recordId,
            signer   : Jws.createSigner(author)
          });

          const deleteReply = await dwn.processMessage(author.did, recordsDelete.message);
          expect(deleteReply.status.code).toBe(202);

          const { messages } = await messageStore.query(author.did, [{ recordId: message.recordId }]);
          expect(messages.length).toBe(3); // first write + latest pre-delete write + delete
          const retainedWriteCid = await Message.getCid(newWrite.message);
          const retainedCids = await Promise.all(messages.map((storedMessage) => Message.getCid(storedMessage)));
          expect(retainedCids).toContain(retainedWriteCid);
        });
      });
    });

    it('should return 401 if signature check fails', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsDelete();
      const tenant = author.did;

      // setting up a stub did resolver & message store
      // intentionally not supplying the public key so a different public key is generated to simulate invalid signature
      const mismatchingPersona = await TestDataGenerator.generatePersona({ did: author.did, keyId: author.keyId });
      const didResolver = TestStubGenerator.createDidResolverStub(mismatchingPersona);

      // setting up a stub method resolver & message store
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const resumableTaskManagerStub = sinon.createStubInstance(ResumableTaskManager);

      const recordsDeleteHandler = new RecordsDeleteHandler({
        didResolver, messageStore          : messageStoreStub, resumableTaskManager  : resumableTaskManagerStub,
        validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub }),
      });
      const reply = await recordsDeleteHandler.handle({ tenant, message });
      expect(reply.status.code).toBe(401);
    });

    it('should return 400 if fail parsing the message', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsDelete();
      const tenant = author.did;

      // setting up a stub method resolver & message store
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const resumableTaskManagerStub = sinon.createStubInstance(ResumableTaskManager);

      const recordsDeleteHandler = new RecordsDeleteHandler({
        didResolver, messageStore          : messageStoreStub, resumableTaskManager  : resumableTaskManagerStub,
        validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub }),
      });

      // stub the `parse()` function to throw an error
      sinon.stub(RecordsDelete, 'parse').throws('anyError');
      const reply = await recordsDeleteHandler.handle({ tenant, message });

      expect(reply.status.code).toBe(400);
    });
  });
}
