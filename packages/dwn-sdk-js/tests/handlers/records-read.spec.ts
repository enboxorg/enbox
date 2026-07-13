import type { DerivedPrivateJwk } from '../../src/utils/hd-key.js';
import type { DidResolver } from '@enbox/dids';
import type { EncryptionInput } from '../../src/interfaces/records-write.js';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage, ResumableTaskStore } from '../../src/index.js';

import emailProtocolDefinition from '../vectors/protocol-definitions/email.json' with { type: 'json' };
import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import minimalProtocolDefinition from '../vectors/protocol-definitions/minimal.json' with { type: 'json' };
import nestedProtocol from '../vectors/protocol-definitions/nested.json' with { type: 'json' };
import sinon from 'sinon';
import socialMediaProtocolDefinition from '../vectors/protocol-definitions/social-media.json' with { type: 'json' };
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };

import { ArrayUtility } from '../../src/utils/array.js';
import { authenticate } from '../../src/core/auth.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../../src/types/encryption-types.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { Message } from '../../src/core/message.js';
import { RecordsReadHandler } from '../../src/handlers/records-read.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, Encryption, KeyAgreementAlgorithm } from '../../src/utils/encryption.js';
import { createAudienceControlWrite, createDeliveryControlWrite, installEncryptedProtocol, processControlWrite } from '../utils/encryption-control-test-utils.js';
import { DataStoreLevel, MessageStoreLevel } from '../../src/store/level.js';
import { DataStream, DateSort, Dwn, Jws, Protocols, ProtocolsConfigure, ProtocolsQuery, Records, RecordsDelete, RecordsRead , RecordsWrite } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnConstant, PermissionsProtocol, Time } from '../../src/index.js';
import { DwnInterfaceName, DwnMethodName } from '../../src/index.js';

import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';

export function testRecordsReadHandler(): void {
  describe('RecordsReadHandler.handle()', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    beforeEach(() => {
      sinon.restore(); // wipe all previous stubs/spies/mocks/fakes
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

      it('should allow tenant to RecordsRead their own record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert data
        const { message, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // testing RecordsRead
        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(alice)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(200);
        expect(readReply.entry!.recordsWrite).toBeDefined();
        expect(readReply.entry!.recordsWrite?.authorization).toEqual(message.authorization);
        expect(readReply.entry!.recordsWrite?.descriptor).toEqual(message.descriptor);

        const dataFetched = await DataStream.toBytes(readReply.entry!.data!);
        expect(ArrayUtility.byteArraysEqual(dataFetched, dataBytes!)).toBe(true);
      });

      it('should not allow non-tenant to RecordsRead a record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert data
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // testing RecordsRead
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(bob)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(401);
      });

      it('should allow authenticated exact-record reads of audience control records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-read-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const audience = await createAudienceControlWrite({
          author      : alice,
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet : encryptedDefinition.structure.member as ProtocolRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const recordsRead = await RecordsRead.create({
          filter : { recordId: audience.recordsWrite.message.recordId },
          signer : Jws.createSigner(bob),
        });
        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(200);
        expect(readReply.entry?.recordsWrite?.recordId).toBe(audience.recordsWrite.message.recordId);

        const anonymousRead = await RecordsRead.create({
          filter: { recordId: audience.recordsWrite.message.recordId },
        });
        const anonymousReply = await dwn.processMessage(alice.did, anonymousRead.message);
        expect(anonymousReply.status.code).toBe(401);
      });

      it('should only allow delivery control reads by the recipient or writer', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();
        const bobDelegate = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-read-delivery.xyz',
          published : false,
          types     : {
            member  : { schema: 'http://member-schema', dataFormats: ['application/json'] },
            message : { schema: 'http://message-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member  : { $role: true },
            message : {
              $actions: [{ role: 'member', can: ['read'] }],
            },
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

        const bobRead = await RecordsRead.create({
          filter : { recordId: delivery.recordsWrite.message.recordId },
          signer : Jws.createSigner(bob),
        });
        const bobReply = await dwn.processMessage(alice.did, bobRead.message);
        expect(bobReply.status.code).toBe(200);
        expect(bobReply.entry?.recordsWrite?.recordId).toBe(delivery.recordsWrite.message.recordId);

        const carolRead = await RecordsRead.create({
          filter : { recordId: delivery.recordsWrite.message.recordId },
          signer : Jws.createSigner(carol),
        });
        const carolReply = await dwn.processMessage(alice.did, carolRead.message);
        expect(carolReply.status.code).toBe(401);

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

        const delegatedCarolRead = await RecordsRead.create({
          delegatedGrant : carolGrant.dataEncodedMessage,
          filter         : { recordId: delivery.recordsWrite.message.recordId },
          signer         : Jws.createSigner(carol),
        });
        const delegatedCarolReply = await dwn.processMessage(alice.did, delegatedCarolRead.message);
        expect(delegatedCarolReply.status.code).toBe(401);

        const bobDelegateGrant = await TestDataGenerator.generateGrantCreate({
          author    : bob,
          grantedTo : bobDelegate,
          delegated : true,
          scope     : {
            interface    : DwnInterfaceName.Records,
            method       : DwnMethodName.Read,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'message',
          },
        });
        const delegatedBobRead = await RecordsRead.create({
          delegatedGrant : bobDelegateGrant.dataEncodedMessage,
          filter         : { recordId: delivery.recordsWrite.message.recordId },
          signer         : Jws.createSigner(bobDelegate),
        });
        const delegatedBobReply = await dwn.processMessage(alice.did, delegatedBobRead.message);
        expect(delegatedBobReply.status.code).toBe(200);
        expect(delegatedBobReply.entry?.recordsWrite?.recordId).toBe(delivery.recordsWrite.message.recordId);
      });

      it('should allow reading of data that is published without `authorization`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert public data
        const { message, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({ author: alice, published: true });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // testing public RecordsRead
        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId
          }
        });
        expect(recordsRead.author).toBeUndefined(); // making sure no author/authorization is created

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(200);

        const dataFetched = await DataStream.toBytes(readReply.entry!.data!);
        expect(ArrayUtility.byteArraysEqual(dataFetched, dataBytes!)).toBe(true);
      });

      it('should allow an authenticated user to RecordRead data that is published', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert public data
        const { message, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({ author: alice, published: true });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // testing public RecordsRead
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(bob)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(200);

        const dataFetched = await DataStream.toBytes(readReply.entry!.data!);
        expect(ArrayUtility.byteArraysEqual(dataFetched, dataBytes!)).toBe(true);
      });

      it('should allow a non-tenant to read RecordsRead data they have received', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // Alice inserts data with Bob as recipient
        const { message, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
          author    : alice,
          recipient : bob.did,
        });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // Bob reads the data that Alice sent him
        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(bob)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(200);
        expect(readReply.entry!.recordsWrite).toBeDefined();
        expect(readReply.entry!.recordsWrite?.descriptor).toBeDefined();

        const dataFetched = await DataStream.toBytes(readReply.entry!.data!);
        expect(ArrayUtility.byteArraysEqual(dataFetched, dataBytes!)).toBe(true);
      });

      it('should return 400 when fetching initial write for a deleted record fails', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // Write a record
        const { message: writeMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, writeMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // Delete the record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : writeMessage.recordId
        });
        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // Stub the messageStore.query method to simulate failure in fetching initial write
        const queryStub = sinon.stub(dwn['messageStore'], 'query');
        queryStub.onFirstCall().resolves({ messages: [recordsDelete.message] });
        queryStub.onSecondCall().resolves({ messages: [] }); // Simulate no initial write found

        // Attempt to read the deleted record
        const recordsRead = await RecordsRead.create({
          filter : { recordId: writeMessage.recordId },
          signer : Jws.createSigner(alice)
        });
        const readReply = await dwn.processMessage(alice.did, recordsRead.message);

        // Verify the response
        expect(readReply.status.code).toBe(400);
        expect(readReply.status.detail).toContain(DwnErrorCode.RecordsReadInitialWriteNotFound);

        // Restore the original messageStore.query method
        queryStub.restore();
      });

      it('should return 401 when a non-author attempts to read the initial write of a deleted record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // Alice installs a protocol that allows anyone to write
        const protocolDefinition: ProtocolDefinition = {
          published : true,
          protocol  : 'https://example.com/foo',
          types     : {
            foo: {}
          },
          structure: {
            foo: {
              $actions: [{
                who : 'anyone',
                can : ['create', 'delete']
              }]
            }
          }
        };

        const configureProtocol = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : protocolDefinition,
        });
        const configureProtocolReply = await dwn.processMessage(alice.did, configureProtocol.message);
        expect(configureProtocolReply.status.code).toBe(202);

        // Bob writes a record to Alice's DWN
        const { message: writeMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'foo'
        });
        const writeReply = await dwn.processMessage(alice.did, writeMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // Bob deletes the record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(bob),
          recordId : writeMessage.recordId
        });
        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // Carol attempts to read the deleted record
        const recordsRead = await RecordsRead.create({
          filter : { recordId: writeMessage.recordId },
          signer : Jws.createSigner(carol)
        });
        const readReply = await dwn.processMessage(alice.did, recordsRead.message);

        // Verify the response
        expect(readReply.status.code).toBe(401);
        expect(readReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
      });

      it('should allow a non-tenant to read RecordsRead data they have authored', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // Alice installs a protocol that allows anyone to write foo record
        const protocolDefinition:ProtocolDefinition = {
          published : true,
          protocol  : 'https://example.com/foo',
          types     : {
            foo: {}
          },
          structure: {
            foo: {
              $actions: [{
                who : 'anyone',
                can : ['create']
              }]
            }
          }
        };

        const configureProtocol = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : protocolDefinition,
        });
        const configureProtocolReply = await dwn.processMessage(alice.did, configureProtocol.message);
        expect(configureProtocolReply.status.code).toBe(202);

        // Bob writes a foo record to Alice's DWN
        const { message, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'foo',
        });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // Bob reads the record he sent to Alice from Alice's DWN
        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(bob)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(200);
        expect(readReply.entry!.recordsWrite).toBeDefined();
        expect(readReply.entry!.recordsWrite?.descriptor).toBeDefined();

        const dataFetched = await DataStream.toBytes(readReply.entry!.data!);
        expect(ArrayUtility.byteArraysEqual(dataFetched, dataBytes!)).toBe(true);

        // carol attempts to read Bob's record
        const carolRecordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(carol)
        });

        const carolReadReply = await dwn.processMessage(alice.did, carolRecordsRead.message);
        expect(carolReadReply.status.code).toBe(401);
      });

      it('should include `initialWrite` property if RecordsWrite is not initial write', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write = await TestDataGenerator.generateRecordsWrite({ author: alice, published: false });

        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        // write an update to the record
        const write2 = await RecordsWrite.createFrom({ recordsWriteMessage: write.message, published: true, signer: Jws.createSigner(alice) });
        const write2Reply = await dwn.processMessage(alice.did, write2.message);
        expect(write2Reply.status.code).toBe(202);

        // make sure result returned now has `initialWrite` property
        const querySpy = sinon.spy(messageStore, 'query');
        const messageData = await RecordsRead.create({ filter: { recordId: write.message.recordId }, signer: Jws.createSigner(alice) });
        const reply = await dwn.processMessage(alice.did, messageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entry!.initialWrite).toBeDefined();
        expect(reply.entry!.initialWrite?.recordId).toBe(write.message.recordId);
        expect(querySpy.getCalls().some((call): boolean =>
          (call.args[1] as Array<{ entryId?: string }>).some((filter): boolean => filter.entryId === write.message.recordId)
        )).toBe(true);
      });

      it('should return a controlled error if an updated record has no initial write', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write = await TestDataGenerator.generateRecordsWrite({ author: alice, published: false });

        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        const update = await RecordsWrite.createFrom({
          recordsWriteMessage : write.message,
          published           : true,
          signer              : Jws.createSigner(alice),
        });
        const updateReply = await dwn.processMessage(alice.did, update.message);
        expect(updateReply.status.code).toBe(202);

        await messageStore.delete(alice.did, await Message.getCid(write.message));

        const read = await RecordsRead.create({
          filter : { recordId: write.message.recordId },
          signer : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, read.message);

        expect(reply.status.code).toBe(500);
        expect(reply.status.detail).toContain(DwnErrorCode.RecordsWriteGetInitialWriteNotFound);
      });

      describe('protocol based reads', () => {
        it('should allow read with allow-anyone rule', async () => {
        // scenario: Alice writes an image to her DWN, then Bob reads the image because he is "anyone".

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = socialMediaProtocolDefinition;

          // Install social-media protocol on Alice's DWN
          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes image to her DWN
          const encodedImage = new TextEncoder().encode('cafe-aesthetic.jpg');
          const imageRecordsWrite = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'image', // this comes from `types` in protocol definition
            schema       : protocolDefinition.types.image.schema,
            dataFormat   : 'image/jpeg',
            data         : encodedImage,
            recipient    : alice.did
          });
          const imageReply = await dwn.processMessage(alice.did, imageRecordsWrite.message, { dataStream: imageRecordsWrite.dataStream });
          expect(imageReply.status.code).toBe(202);

          // Bob (anyone) reads the image that Alice wrote
          const imageRecordsRead = await RecordsRead.create({
            filter: {
              recordId: imageRecordsWrite.message.recordId,
            },
            signer: Jws.createSigner(bob)
          });
          const imageReadReply = await dwn.processMessage(alice.did, imageRecordsRead.message);
          expect(imageReadReply.status.code).toBe(200);
        });

        it('should not allow anonymous reads when there is no allow-anyone rule', async () => {
          // scenario: Alice's writes a record to a protocol. An anonymous read his Alice's DWN and is rejected
          //           because there is not an allow-anyone rule.

          const alice = await TestDataGenerator.generatePersona();

          const protocolDefinition = emailProtocolDefinition as ProtocolDefinition;

          TestStubGenerator.stubDidResolver(didResolver, [alice]);

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a message to the minimal protocol
          const recordsWrite = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'email',
            schema       : protocolDefinition.types.email.schema,
            dataFormat   : protocolDefinition.types.email.dataFormats![0],
            data         : new TextEncoder().encode('foo')
          });
          const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream: recordsWrite.dataStream });
          expect(recordsWriteReply.status.code).toBe(202);

          // Anonymous tries and fails to read Alice's message
          const recordsRead = await RecordsRead.create({
            filter: {
              recordId: recordsWrite.message.recordId,
            }
          });
          const recordsReadReply = await dwn.processMessage(alice.did, recordsRead.message);
          expect(recordsReadReply.status.code).toBe(401);
          expect(recordsReadReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
        });

        describe('recipient rules', () => {
          it('should allow read with ancestor recipient rule', async () => {
            // scenario: Alice sends an email to Bob, then Bob reads the email.
            //           ImposterBob tries and fails to read the email.

            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const imposterBob = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = emailProtocolDefinition as ProtocolDefinition;

            // Install email protocol on Alice's DWN
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition,
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice writes an email with Bob as recipient
            const encodedEmail = new TextEncoder().encode('Dear Bob, hello!');
            const emailRecordsWrite = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'email', // this comes from `types` in protocol definition
              schema       : protocolDefinition.types.email.schema,
              dataFormat   : protocolDefinition.types.email.dataFormats![0],
              data         : encodedEmail,
              recipient    : bob.did
            });
            const imageReply = await dwn.processMessage(alice.did, emailRecordsWrite.message, { dataStream: emailRecordsWrite.dataStream });
            expect(imageReply.status.code).toBe(202);

            // Bob reads Alice's email
            const bobRecordsRead = await RecordsRead.create({
              filter: {
                recordId: emailRecordsWrite.message.recordId,
              },
              signer: Jws.createSigner(bob)
            });
            const bobReadReply = await dwn.processMessage(alice.did, bobRecordsRead.message);
            expect(bobReadReply.status.code).toBe(200);

            // ImposterBob is not able to read Alice's email
            const imposterRecordsRead = await RecordsRead.create({
              filter: {
                recordId: emailRecordsWrite.message.recordId,
              },
              signer: Jws.createSigner(imposterBob)
            });
            const imposterReadReply = await dwn.processMessage(alice.did, imposterRecordsRead.message);
            expect(imposterReadReply.status.code).toBe(401);
            expect(imposterReadReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
          });
        });

        describe('author action rules', () => {
          it('should allow read with ancestor author rule', async () => {
            // scenario: Bob sends an email to Alice, then Bob reads the email.
            //           ImposterBob tries and fails to read the email.
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const imposterBob = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = emailProtocolDefinition as ProtocolDefinition;

            // Install email protocol on Alice's DWN
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice writes an email with Bob as recipient
            const encodedEmail = new TextEncoder().encode('Dear Alice, hello!');
            const emailRecordsWrite = await TestDataGenerator.generateRecordsWrite({
              author       : bob,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'email', // this comes from `types` in protocol definition
              schema       : protocolDefinition.types.email.schema,
              dataFormat   : protocolDefinition.types.email.dataFormats![0],
              data         : encodedEmail,
              recipient    : alice.did
            });
            const imageReply = await dwn.processMessage(alice.did, emailRecordsWrite.message, { dataStream: emailRecordsWrite.dataStream });
            expect(imageReply.status.code).toBe(202);

            // Bob reads the email he just sent
            const bobRecordsRead = await RecordsRead.create({
              filter: {
                recordId: emailRecordsWrite.message.recordId,
              },
              signer: Jws.createSigner(bob)
            });
            const bobReadReply = await dwn.processMessage(alice.did, bobRecordsRead.message);
            expect(bobReadReply.status.code).toBe(200);

            // ImposterBob is not able to read the email
            const imposterRecordsRead = await RecordsRead.create({
              filter: {
                recordId: emailRecordsWrite.message.recordId,
              },
              signer: Jws.createSigner(imposterBob)
            });
            const imposterReadReply = await dwn.processMessage(alice.did, imposterRecordsRead.message);
            expect(imposterReadReply.status.code).toBe(401);
            expect(imposterReadReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
          });
        });

        describe('filter based reads', () => {
          it('should return a filter based read if there is only a single result', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = { ...nestedProtocol };
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolConfigReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolConfigReply.status.code).toBe(202);

            const foo1Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo'),
              recipient    : alice.did
            });
            const foo1WriteReply = await dwn.processMessage(alice.did, foo1Write.message, { dataStream: foo1Write.dataStream });
            expect(foo1WriteReply.status.code).toBe(202);

            const fooPathRead = await RecordsRead.create({
              filter: {
                protocol     : protocolDefinition.protocol,
                protocolPath : 'foo',
              },
              signer: Jws.createSigner(alice),
            });

            const fooPathReply = await dwn.processMessage(alice.did, fooPathRead.message);
            expect(fooPathReply.status.code).toBe(200);
            expect(fooPathReply.entry!.recordsWrite!.recordId).toBe(foo1Write.message.recordId);
          });

          it('should return the most recently updated record when filter matches multiple results', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = { ...nestedProtocol };
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolConfigReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolConfigReply.status.code).toBe(202);

            const foo1Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo1'),
              recipient    : alice.did
            });
            const foo1WriteReply = await dwn.processMessage(alice.did, foo1Write.message, { dataStream: foo1Write.dataStream });
            expect(foo1WriteReply.status.code).toBe(202);

            await Time.minimalSleep();

            const foo2Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo2'),
              recipient    : alice.did
            });
            const foo2WriteReply = await dwn.processMessage(alice.did, foo2Write.message, { dataStream: foo2Write.dataStream });
            expect(foo2WriteReply.status.code).toBe(202);

            // default sort is updatedDescending, so the most recently updated record should be returned
            const fooPathRead = await RecordsRead.create({
              filter: {
                protocol     : protocolDefinition.protocol,
                protocolPath : 'foo',
              },
              signer: Jws.createSigner(alice),
            });
            const fooPathReply = await dwn.processMessage(alice.did, fooPathRead.message);
            expect(fooPathReply.status.code).toBe(200);
            expect(fooPathReply.entry!.recordsWrite!.recordId).toBe(foo2Write.message.recordId);
          });

          it('should return the oldest record when `dateSort` is `CreatedAscending` and filter matches multiple results', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = { ...nestedProtocol };
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolConfigReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolConfigReply.status.code).toBe(202);

            const foo1Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo1'),
              recipient    : alice.did
            });
            const foo1WriteReply = await dwn.processMessage(alice.did, foo1Write.message, { dataStream: foo1Write.dataStream });
            expect(foo1WriteReply.status.code).toBe(202);

            await Time.minimalSleep();

            const foo2Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo2'),
              recipient    : alice.did
            });
            const foo2WriteReply = await dwn.processMessage(alice.did, foo2Write.message, { dataStream: foo2Write.dataStream });
            expect(foo2WriteReply.status.code).toBe(202);

            // with createdAscending sort, the oldest record should be returned
            const fooPathRead = await RecordsRead.create({
              filter: {
                protocol     : protocolDefinition.protocol,
                protocolPath : 'foo',
              },
              dateSort : DateSort.CreatedAscending,
              signer   : Jws.createSigner(alice),
            });
            const fooPathReply = await dwn.processMessage(alice.did, fooPathRead.message);
            expect(fooPathReply.status.code).toBe(200);
            expect(fooPathReply.entry!.recordsWrite!.recordId).toBe(foo1Write.message.recordId);
          });

          it('should return the newest record when `dateSort` is `CreatedDescending` and filter matches multiple results', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = { ...nestedProtocol };
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolConfigReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolConfigReply.status.code).toBe(202);

            const foo1Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo1'),
              recipient    : alice.did
            });
            const foo1WriteReply = await dwn.processMessage(alice.did, foo1Write.message, { dataStream: foo1Write.dataStream });
            expect(foo1WriteReply.status.code).toBe(202);

            await Time.minimalSleep();

            const foo2Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo2'),
              recipient    : alice.did
            });
            const foo2WriteReply = await dwn.processMessage(alice.did, foo2Write.message, { dataStream: foo2Write.dataStream });
            expect(foo2WriteReply.status.code).toBe(202);

            const fooPathRead = await RecordsRead.create({
              filter: {
                protocol     : protocolDefinition.protocol,
                protocolPath : 'foo',
              },
              dateSort : DateSort.CreatedDescending,
              signer   : Jws.createSigner(alice),
            });
            const fooPathReply = await dwn.processMessage(alice.did, fooPathRead.message);
            expect(fooPathReply.status.code).toBe(200);
            expect(fooPathReply.entry!.recordsWrite!.recordId).toBe(foo2Write.message.recordId);
          });

          it('should return the oldest updated record when `dateSort` is `UpdatedAscending`', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = { ...nestedProtocol };
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolConfigReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolConfigReply.status.code).toBe(202);

            const foo1Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo1'),
              recipient    : alice.did
            });
            const foo1WriteReply = await dwn.processMessage(alice.did, foo1Write.message, { dataStream: foo1Write.dataStream });
            expect(foo1WriteReply.status.code).toBe(202);

            await Time.minimalSleep();

            const foo2Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo2'),
              recipient    : alice.did
            });
            const foo2WriteReply = await dwn.processMessage(alice.did, foo2Write.message, { dataStream: foo2Write.dataStream });
            expect(foo2WriteReply.status.code).toBe(202);

            const fooPathRead = await RecordsRead.create({
              filter: {
                protocol     : protocolDefinition.protocol,
                protocolPath : 'foo',
              },
              dateSort : DateSort.UpdatedAscending,
              signer   : Jws.createSigner(alice),
            });
            const fooPathReply = await dwn.processMessage(alice.did, fooPathRead.message);
            expect(fooPathReply.status.code).toBe(200);
            expect(fooPathReply.entry!.recordsWrite!.recordId).toBe(foo1Write.message.recordId);
          });

          it('should return the most recently updated record when `dateSort` is `UpdatedDescending`', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = { ...nestedProtocol };
            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolConfigReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolConfigReply.status.code).toBe(202);

            const foo1Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo1'),
              recipient    : alice.did
            });
            const foo1WriteReply = await dwn.processMessage(alice.did, foo1Write.message, { dataStream: foo1Write.dataStream });
            expect(foo1WriteReply.status.code).toBe(202);

            await Time.minimalSleep();

            const foo2Write = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
              schema       : protocolDefinition.types.foo.schema,
              dataFormat   : protocolDefinition.types.foo.dataFormats![0],
              data         : new TextEncoder().encode('foo2'),
              recipient    : alice.did
            });
            const foo2WriteReply = await dwn.processMessage(alice.did, foo2Write.message, { dataStream: foo2Write.dataStream });
            expect(foo2WriteReply.status.code).toBe(202);

            const fooPathRead = await RecordsRead.create({
              filter: {
                protocol     : protocolDefinition.protocol,
                protocolPath : 'foo',
              },
              dateSort : DateSort.UpdatedDescending,
              signer   : Jws.createSigner(alice),
            });
            const fooPathReply = await dwn.processMessage(alice.did, fooPathRead.message);
            expect(fooPathReply.status.code).toBe(200);
            expect(fooPathReply.entry!.recordsWrite!.recordId).toBe(foo2Write.message.recordId);
          });

          it('should return the earliest published record when `dateSort` is `PublishedAscending`', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();
            await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
            const schema = 'aSchema';

            const write1 = await TestDataGenerator.generateRecordsWrite({
              author    : alice,
              schema,
              published : true,
            });
            const write1Reply = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
            expect(write1Reply.status.code).toBe(202);

            await Time.minimalSleep();

            const write2 = await TestDataGenerator.generateRecordsWrite({
              author    : alice,
              schema,
              published : true,
            });
            const write2Reply = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
            expect(write2Reply.status.code).toBe(202);

            const read = await RecordsRead.create({
              filter   : { schema },
              dateSort : DateSort.PublishedAscending,
              signer   : Jws.createSigner(alice),
            });
            const readReply = await dwn.processMessage(alice.did, read.message);
            expect(readReply.status.code).toBe(200);
            expect(readReply.entry!.recordsWrite!.recordId).toBe(write1.message.recordId);
          });

          it('should return the latest published record when `dateSort` is `PublishedDescending`', async () => {
            const alice = await TestDataGenerator.generateDidKeyPersona();
            await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
            const schema = 'aSchema';

            const write1 = await TestDataGenerator.generateRecordsWrite({
              author    : alice,
              schema,
              published : true,
            });
            const write1Reply = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
            expect(write1Reply.status.code).toBe(202);

            await Time.minimalSleep();

            const write2 = await TestDataGenerator.generateRecordsWrite({
              author    : alice,
              schema,
              published : true,
            });
            const write2Reply = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
            expect(write2Reply.status.code).toBe(202);

            const read = await RecordsRead.create({
              filter   : { schema },
              dateSort : DateSort.PublishedDescending,
              signer   : Jws.createSigner(alice),
            });
            const readReply = await dwn.processMessage(alice.did, read.message);
            expect(readReply.status.code).toBe(200);
            expect(readReply.entry!.recordsWrite!.recordId).toBe(write2.message.recordId);
          });
        });

        describe('protocolRole based reads', () => {
          it('uses a root-level role to authorize a read', async () => {
            // scenario: Alice writes a chat message writes a chat message. Bob invokes his
            //           friend role in order to read the chat message.

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

            // Alice writes a 'chat' record
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              data         : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);

            // Bob reads Alice's chat record
            const readChatRecord = await RecordsRead.create({
              signer : Jws.createSigner(bob),
              filter : {
                recordId: chatRecord.message.recordId,

              },
              protocolRole: 'friend'
            });
            const chatReadReply = await dwn.processMessage(alice.did, readChatRecord.message);
            expect(chatReadReply.status.code).toBe(200);
          });

          it('rejects root-level role authorized reads if the protocolRole is not a valid protocol path to an active role record', async () => {
            // scenario: Alice writes a chat message writes a chat message. Bob tries to invoke the 'chat' role,
            //           but 'chat' is not a role.

            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = friendRoleProtocolDefinition;

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice writes a 'chat' record
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              data         : new TextEncoder().encode('Blah blah blah'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);

            // Bob tries to invoke a 'chat' role but 'chat' is not a role
            const readChatRecord = await RecordsRead.create({
              signer : Jws.createSigner(bob),
              filter : {
                recordId: chatRecord.message.recordId,
              },
              protocolRole: 'chat'
            });
            const chatReadReply = await dwn.processMessage(alice.did, readChatRecord.message);
            expect(chatReadReply.status.code).toBe(401);
            expect(chatReadReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationNotARole);
          });

          it('rejects root-level role authorized reads if there is no active role for the recipient', async () => {
            // scenario: Alice writes a chat message writes a chat message. Bob tries to invoke a role,
            //           but he has not been given one.

            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = friendRoleProtocolDefinition;

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice writes a 'chat' record
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              data         : new TextEncoder().encode('Blah blah blah'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);

            // Bob tries to invoke a 'friend' role but he is not a 'friend'
            const readChatRecord = await RecordsRead.create({
              signer : Jws.createSigner(bob),
              filter : {
                recordId: chatRecord.message.recordId,
              },
              protocolRole: 'friend',
            });
            const chatReadReply = await dwn.processMessage(alice.did, readChatRecord.message);
            expect(chatReadReply.status.code).toBe(401);
            expect(chatReadReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
          });

          it('can authorize a read using a context role', async () => {
            // scenario: Alice creates a thread and adds Bob to the 'thread/participant' role. Alice writes a chat message.
            //           Bob invokes the record to read in the chat message.

            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();

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
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread'
            });
            const threadRecordReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
            expect(threadRecordReply.status.code).toBe(202);

            // Alice adds Bob as a 'thread/participant' in that thread
            const participantRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : bob.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/participant',
              parentContextId : threadRecord.message.contextId,
            });
            const participantRecordReply =
              await dwn.processMessage(alice.did, participantRecord.message, { dataStream: participantRecord.dataStream });
            expect(participantRecordReply.status.code).toBe(202);

            // Alice writes a chat message in the thread
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              parentContextId : threadRecord.message.contextId,
            });
            const chatRecordReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatRecordReply.status.code).toBe(202);

            // Bob is able to read his own 'participant' role
            // He doesn't need to invoke the role because recipients of a record are always authorized to read it
            const participantRead = await RecordsRead.create({
              signer : Jws.createSigner(bob),
              filter : {
                protocolPath : 'thread/participant',
                recipient    : bob.did,
                contextId    : threadRecord.message.contextId
              },
            });
            const participantReadReply = await dwn.processMessage(alice.did, participantRead.message);
            expect(participantReadReply.status.code).toBe(200);

            // Bob is able to read the thread root record
            const threadRead = await RecordsRead.create({
              signer : Jws.createSigner(bob),
              filter : {
                recordId: participantReadReply.entry!.recordsWrite!.descriptor.parentId,
              },
              protocolRole: 'thread/participant'
            });
            const threadReadReply = await dwn.processMessage(alice.did, threadRead.message);
            expect(threadReadReply.status.code).toBe(200);

            // Bob invokes his 'participant' role to read the chat message
            const chatRead = await RecordsRead.create({
              signer : Jws.createSigner(bob),
              filter : {
                recordId: chatRecord.message.recordId,
              },
              protocolRole: 'thread/participant'
            });
            const chatReadReply = await dwn.processMessage(alice.did, chatRead.message);
            expect(chatReadReply.status.code).toBe(200);
          });

          it('should not allow context role to be invoked against a wrong context', async () => {
            // scenario: Alice creates a thread and adds Bob as a participant. Alice creates another thread. Bob tries and fails to invoke his
            //           context role to write a chat in the second thread

            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();

            const protocolDefinition = threadRoleProtocolDefinition;

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice creates a thread
            const threadRecord1 = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : bob.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread'
            });
            const threadRecordReply1 = await dwn.processMessage(alice.did, threadRecord1.message, { dataStream: threadRecord1.dataStream });
            expect(threadRecordReply1.status.code).toBe(202);

            // Alice adds Bob as a 'thread/participant' in that thread
            const participantRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : bob.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/participant',
              parentContextId : threadRecord1.message.contextId,
            });
            const participantRecordReply =
              await dwn.processMessage(alice.did, participantRecord.message, { dataStream: participantRecord.dataStream });
            expect(participantRecordReply.status.code).toBe(202);

            // Alice creates a second thread
            const threadRecord2 = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : bob.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread'
            });
            const threadRecordReply2 = await dwn.processMessage(alice.did, threadRecord2.message, { dataStream: threadRecord2.dataStream });
            expect(threadRecordReply2.status.code).toBe(202);

            // Alice writes a chat message in the thread
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              parentContextId : threadRecord2.message.contextId,
            });
            const chatRecordReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatRecordReply.status.code).toBe(202);

            // Bob invokes his 'participant' role to read the chat message
            const chatRead = await RecordsRead.create({
              signer : Jws.createSigner(bob),
              filter : {
                recordId: chatRecord.message.recordId,
              },
              protocolRole: 'thread/participant'
            });
            const chatReadReply = await dwn.processMessage(alice.did, chatRead.message);
            expect(chatReadReply.status.code).toBe(401);
            expect(chatReadReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
          });
        });
      });

      describe('grant based reads', () => {
        it('rejects with 401 an external party attempts to RecordReads if grant has different DWN method scope', async () => {
          // scenario: Alice grants Bob access to RecordsWrite, then Bob tries to invoke the grant with RecordsRead

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // Alice writes a record which Bob will later try to read
          const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author: alice,
          });
          const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
          expect(recordsWriteReply.status.code).toBe(202);

          // Alice gives Bob a permission grant with scope RecordsRead
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              protocol  : 'http://example.com/protocol/test',
            }
          });
          const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const permissionGrantWriteReply = await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: grantDataStream }
          );
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Bob tries to RecordsRead
          const recordsRead = await RecordsRead.create({
            filter: {
              recordId: recordsWrite.message.recordId,
            },
            signer            : Jws.createSigner(bob),
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const recordsReadReply = await dwn.processMessage(alice.did, recordsRead.message);
          expect(recordsReadReply.status.code).toBe(401);
          expect(recordsReadReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationMethodMismatch);
        });

        describe('protocol records', () => {
          it('allows reads of protocol records with unrestricted grant scopes', async () => {
            // scenario: Alice writes a protocol record. Alice gives Bob a grant to read all records in her DWN
            //           Bob invokes that grant to read the protocol record.

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
            const { recordsWrite, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
            });
            const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
            expect(recordsWriteReply.status.code).toBe(202);

            // Alice gives Bob a permission grant with scope RecordsRead
            const permissionGrant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
              scope       : {
                interface : DwnInterfaceName.Records,
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

            // Bob is unable to read the record without using the permission grant
            const recordsReadWithoutGrant = await RecordsRead.create({
              filter: {

                recordId: recordsWrite.message.recordId,
              },
              signer: Jws.createSigner(bob),
            });
            const recordsReadWithoutGrantReply = await dwn.processMessage(alice.did, recordsReadWithoutGrant.message);
            expect(recordsReadWithoutGrantReply.status.code).toBe(401);
            expect(recordsReadWithoutGrantReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionRulesNotFound);

            // Bob is able to read the record when he uses the permission grant
            const recordsReadWithGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer            : Jws.createSigner(bob),
              permissionGrantId : permissionGrant.recordsWrite.message.recordId,
            });
            const recordsReadWithGrantReply = await dwn.processMessage(alice.did, recordsReadWithGrant.message);
            expect(recordsReadWithGrantReply.status.code).toBe(200);
            expect(recordsReadWithGrantReply.entry!.recordsWrite!.recordId).toBe(recordsWrite.message.recordId);
            const dataFetched = await DataStream.toBytes(recordsReadWithGrantReply.entry!.data!);
            expect(ArrayUtility.byteArraysEqual(dataFetched, dataBytes!)).toBe(true);
          });

          it('allows reads of protocol records with matching protocol grant scopes', async () => {
            // scenario: Alice writes a protocol record. Alice gives Bob a grant to read all records in the protocol
            //           Bob invokes that grant to read the protocol record.

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
            const { recordsWrite, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'foo',
            });
            const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
            expect(recordsWriteReply.status.code).toBe(202);

            // Alice gives Bob a permission grant with scope RecordsRead
            const permissionGrant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
              scope       : {
                interface : DwnInterfaceName.Records,
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

            // Bob is unable to read the record without using the permission grant
            const recordsReadWithoutGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer: Jws.createSigner(bob),
            });
            const recordsReadWithoutGrantReply = await dwn.processMessage(alice.did, recordsReadWithoutGrant.message);
            expect(recordsReadWithoutGrantReply.status.code).toBe(401);
            expect(recordsReadWithoutGrantReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionRulesNotFound);

            // Bob is able to read the record when he uses the permission grant
            const recordsReadWithGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer            : Jws.createSigner(bob),
              permissionGrantId : permissionGrant.recordsWrite.message.recordId,
            });
            const recordsReadWithGrantReply = await dwn.processMessage(alice.did, recordsReadWithGrant.message);
            expect(recordsReadWithGrantReply.status.code).toBe(200);
            expect(recordsReadWithGrantReply.entry!.recordsWrite!.recordId).toBe(recordsWrite.message.recordId);
            const dataFetched = await DataStream.toBytes(recordsReadWithGrantReply.entry!.data!);
            expect(ArrayUtility.byteArraysEqual(dataFetched, dataBytes!)).toBe(true);
          });

          it('rejects reads of protocol records with mismatching protocol grant scopes', async () => {
            // scenario: Alice writes a protocol record. Alice gives Bob a grant to read a different protocol
            //           Bob invokes that grant to read the protocol record, but fails.

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

            // Alice gives Bob a permission grant with scope RecordsRead
            const permissionGrant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
              scope       : {
                interface : DwnInterfaceName.Records,
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
            const recordsReadWithoutGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer            : Jws.createSigner(bob),
              permissionGrantId : permissionGrant.recordsWrite.message.recordId,
            });
            const recordsReadWithoutGrantReply = await dwn.processMessage(alice.did, recordsReadWithoutGrant.message);
            expect(recordsReadWithoutGrantReply.status.code).toBe(401);
            expect(recordsReadWithoutGrantReply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationScopeProtocolMismatch);
          });

          it('allows reads of records in the contextId specified in the grant', async () => {
            // scenario: Alice grants Bob access to RecordsRead records with a specific contextId.
            //           Bob uses it to read a record in that context.
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

            // Alice gives Bob a permission grant with scope RecordsRead
            const permissionGrant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
              scope       : {
                interface : DwnInterfaceName.Records,
                method    : DwnMethodName.Read,
                protocol  : protocolDefinition.protocol,
                contextId : recordsWrite.message.contextId,
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
            const recordsReadWithoutGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer            : Jws.createSigner(bob),
              permissionGrantId : permissionGrant.recordsWrite.message.recordId,
            });
            const recordsReadWithoutGrantReply = await dwn.processMessage(alice.did, recordsReadWithoutGrant.message);
            expect(recordsReadWithoutGrantReply.status.code).toBe(200);
          });

          it('rejects reads of records in a different contextId than is specified in the grant', async () => {
            // scenario: Alice grants Bob access to RecordsRead records with a specific contextId.
            //           Bob tries and fails to invoke the grant in order to read a record outside of the context.
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

            // Alice gives Bob a permission grant with scope RecordsRead
            const permissionGrant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
              scope       : {
                interface : DwnInterfaceName.Records,
                method    : DwnMethodName.Read,
                protocol  : protocolDefinition.protocol,
                contextId : await TestDataGenerator.randomCborSha256Cid(), // different contextId than what Bob will try to read
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
            const recordsReadWithoutGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer            : Jws.createSigner(bob),
              permissionGrantId : permissionGrant.recordsWrite.message.recordId,
            });
            const recordsReadWithoutGrantReply = await dwn.processMessage(alice.did, recordsReadWithoutGrant.message);
            expect(recordsReadWithoutGrantReply.status.code).toBe(401);
            expect(recordsReadWithoutGrantReply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationScopeContextIdMismatch);
          });

          it('allows reads of records in the protocolPath specified in the grant', async () => {
            // scenario: Alice grants Bob access to RecordsRead records with a specific protocolPath.
            //           Bob uses it to read a record in that protocolPath.
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

            // Alice gives Bob a permission grant with scope RecordsRead
            const permissionGrant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
              scope       : {
                interface    : DwnInterfaceName.Records,
                method       : DwnMethodName.Read,
                protocol     : protocolDefinition.protocol,
                protocolPath : recordsWrite.message.descriptor.protocolPath,
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
            const recordsReadWithoutGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer            : Jws.createSigner(bob),
              permissionGrantId : permissionGrant.recordsWrite.message.recordId,
            });
            const recordsReadWithoutGrantReply = await dwn.processMessage(alice.did, recordsReadWithoutGrant.message);
            expect(recordsReadWithoutGrantReply.status.code).toBe(200);
          });

          it('rejects reads of records in a different protocolPath than is specified in the grant', async () => {
            // scenario: Alice grants Bob access to RecordsRead records with a specific protocolPath.
            //           Bob tries and fails to invoke the grant in order to read a record outside of the protocolPath.
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

            // Alice gives Bob a permission grant with scope RecordsRead
            const permissionGrant = await PermissionsProtocol.createGrant({
              signer      : Jws.createSigner(alice),
              grantedTo   : bob.did,
              dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
              scope       : {
                interface    : DwnInterfaceName.Records,
                method       : DwnMethodName.Read,
                protocol     : protocolDefinition.protocol,
                protocolPath : 'different-protocol-path', // different protocol path than what Bob will try to read
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
            const recordsReadWithoutGrant = await RecordsRead.create({
              filter: {
                recordId: recordsWrite.message.recordId,
              },
              signer            : Jws.createSigner(bob),
              permissionGrantId : permissionGrant.recordsWrite.message.recordId,
            });
            const recordsReadWithoutGrantReply = await dwn.processMessage(alice.did, recordsReadWithoutGrant.message);
            expect(recordsReadWithoutGrantReply.status.code).toBe(401);
            expect(recordsReadWithoutGrantReply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationScopeProtocolPathMismatch);
          });
        });
      });

      it('should return 404 RecordRead if data does not exist', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: `non-existent-record-id`,
          },
          signer: Jws.createSigner(alice)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(404);
      });

      it('should return 404 RecordRead if data has been deleted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert public data
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice, published: true });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // ensure data is inserted
        const queryData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recordId: message.recordId }
        });

        const reply = await dwn.processMessage(alice.did, queryData.message);
        expect(reply.status.code).toBe(200);
        expect(reply.entries).toHaveLength(1);

        // RecordsDelete
        const recordsDelete = await RecordsDelete.create({
          recordId : message.recordId,
          signer   : Jws.createSigner(alice)
        });

        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // RecordsRead
        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(alice)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(404);
      });

      it('should return 410 with recordsWrite when data store cannot locate the data for large records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        sinon.stub(dataStore, 'get').resolves(undefined);

        // insert data larger than the allowed amount in encodedData
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author : alice,
          data   : TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded +1)
        });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // testing RecordsRead
        const recordsRead = await RecordsRead.create({
          filter: {
            recordId: message.recordId,
          },
          signer: Jws.createSigner(alice)
        });

        const readReply = await dwn.processMessage(alice.did, recordsRead.message);
        expect(readReply.status.code).toBe(410);
        expect(readReply.status.detail).toBe('Record data not available');
        // The reply should include the recordsWrite envelope so the client can try another endpoint
        expect((readReply as any).entry?.recordsWrite).toBeDefined();
        expect((readReply as any).entry?.recordsWrite.recordId).toBe(message.recordId);
      });

      describe('data from encodedData', () => {
        it('should not get data from DataStore if encodedData exists', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          //since the data is at the threshold it will be returned from the messageStore in the `encodedData` field.
          const { message, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
            author : alice,
            data   : TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded)
          });

          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);

          const recordRead = await RecordsRead.create({
            filter: {
              recordId: message.recordId,
            },
            signer: Jws.createSigner(alice)
          });

          const dataStoreGet = sinon.spy(dataStore, 'get');

          const recordsReadResponse = await dwn.processMessage(alice.did, recordRead.message);
          expect(recordsReadResponse.status.code).toBe(200);
          expect(recordsReadResponse.entry!.recordsWrite).toBeDefined();
          expect(recordsReadResponse.entry!.data!).toBeDefined();
          sinon.assert.notCalled(dataStoreGet);

          const readData = await DataStream.toBytes(recordsReadResponse.entry!.data!);
          expect(readData).toEqual(dataBytes);
        });

        it('should get data from DataStore if encodedData does not exist', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          //since the data is over the threshold it will not be returned from the messageStore in the `encodedData` field.
          const { message, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({
            author : alice,
            data   : TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded +1)
          });

          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);

          const recordRead = await RecordsRead.create({
            filter: {
              recordId: message.recordId,
            },
            signer: Jws.createSigner(alice)
          });

          const dataStoreGet = sinon.spy(dataStore, 'get');

          const recordsReadResponse = await dwn.processMessage(alice.did, recordRead.message);
          expect(recordsReadResponse.status.code).toBe(200);
          expect(recordsReadResponse.entry!.recordsWrite).toBeDefined();
          expect(recordsReadResponse.entry!.data!).toBeDefined();
          sinon.assert.calledOnce(dataStoreGet);

          const readData = await DataStream.toBytes(recordsReadResponse.entry!.data!);
          expect(readData).toEqual(dataBytes);
        });
      });

      describe('encryption scenarios', () => {
        it('should only be able to decrypt record with a correct derived private key  - `protocols` derivation scheme', async () => {
          // scenario: Bob writes into Alice's DWN an encrypted "email", alice is able to decrypt it

          // creating Alice and Bob persona and setting up a stub DID resolver
          const alice = await TestDataGenerator.generatePersona();
          const bob = await TestDataGenerator.generatePersona();
          TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

          // Alice configures email protocol with encryption
          const protocolDefinition: ProtocolDefinition = emailProtocolDefinition as ProtocolDefinition;
          const encryptedProtocolDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
            protocolDefinition, TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
          );
          const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
            author             : alice,
            protocolDefinition : encryptedProtocolDefinition
          });

          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfigure.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Bob queries for Alice's email protocol definition
          const protocolsQuery = await ProtocolsQuery.create({
            filter: { protocol: emailProtocolDefinition.protocol }
          });
          const protocolsQueryReply = await dwn.processMessage(alice.did, protocolsQuery.message);
          const protocolsConfigureMessageReceived = protocolsQueryReply.entries![0] as ProtocolsConfigureMessage;

          // Bob verifies that the email protocol definition is authored by Alice
          await authenticate(protocolsConfigureMessageReceived.authorization, didResolver);
          const protocolsConfigureFetched = await ProtocolsConfigure.parse(protocolsConfigureMessageReceived);
          expect(protocolsConfigureFetched.author).toBe(alice.did);

          // Bob encrypts his email to Alice with a randomly generated symmetric key
          const bobMessageBytes = TestDataGenerator.randomBytes(100);
          const dataEncryptionInitializationVector = TestDataGenerator.randomBytes(16);
          const dataEncryptionKey = TestDataGenerator.randomBytes(32);
          const bobMessageEncryptedBytes = await Encryption.encrypt(
            ContentEncryptionAlgorithm.A256CTR, dataEncryptionKey, dataEncryptionInitializationVector, bobMessageBytes
          );

          // Bob generates an encrypted RecordsWrite,
          // the public encryption key designated by Alice is used to encrypt the symmetric key Bob generated above
          const publicJwk = protocolsConfigureFetched.message.descriptor.definition.structure.email.$keyAgreement?.publicKeyJwk;
          expect(publicJwk).toBeDefined();
          const encryptionInput: EncryptionInput = {
            initializationVector : dataEncryptionInitializationVector,
            key                  : dataEncryptionKey,
            keyEncryptionInputs  : [{
              algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
              keyId            : await Encryption.getKeyId(publicJwk!),
              publicKey        : publicJwk!,
              derivationScheme : KeyDerivationScheme.ProtocolPath
            }]
          };

          const { message, dataStream } = await TestDataGenerator.generateRecordsWrite(
            {
              author       : bob,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'email', // this comes from `types` in protocol definition
              schema       : protocolDefinition.types.email.schema,
              dataFormat   : protocolDefinition.types.email.dataFormats![0],
              data         : bobMessageEncryptedBytes,
              encryptionInput
            }
          );

          // Bob writes the encrypted email to Alice's DWN
          const bobWriteReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(bobWriteReply.status.code).toBe(202);

          // Alice reads the encrypted email
          // assume Alice already made query to get the `recordId` of the email
          const recordsRead = await RecordsRead.create({
            filter: {
              recordId: message.recordId,
            },
            signer: Jws.createSigner(alice)
          });
          const readReply = await dwn.processMessage(alice.did, recordsRead.message);
          expect(readReply.status.code).toBe(200);

          // test that Alice is able decrypt the encrypted email from Bob using the root key
          const rootPrivateKey: DerivedPrivateJwk = {
            rootKeyId         : alice.keyId,
            derivationScheme  : KeyDerivationScheme.ProtocolPath,
            derivedPrivateKey : alice.encryptionKeyPair.privateJwk
          };

          const fetchedRecordsWrite = readReply.entry!.recordsWrite!;
          const cipherStream = readReply.entry!.data!;

          const plaintextDataStream = await Records.decrypt(fetchedRecordsWrite, TestDataGenerator.createKeyDecrypter(rootPrivateKey), cipherStream);
          const plaintextBytes = await DataStream.toBytes(plaintextDataStream);
          expect(ArrayUtility.byteArraysEqual(plaintextBytes, bobMessageBytes)).toBe(true);

          // test that a correct derived key is able decrypt the encrypted email from Bob
          const readReply2 = await dwn.processMessage(alice.did, recordsRead.message);
          expect(readReply2.status.code).toBe(200);

          const relativeDescendantDerivationPath = Records.constructKeyDerivationPath(KeyDerivationScheme.ProtocolPath, fetchedRecordsWrite);
          const derivedPrivateKey: DerivedPrivateJwk
            = await TestDataGenerator.deriveDescendantPrivateKey(rootPrivateKey, relativeDescendantDerivationPath);

          const fetchedRecordsWrite2 = readReply2.entry!.recordsWrite!;
          const cipherStream2 = readReply2.entry!.data!;
          const derivedKeyDecrypter = TestDataGenerator.createKeyDecrypter(derivedPrivateKey);
          const plaintextDataStream2 = await Records.decrypt(fetchedRecordsWrite2, derivedKeyDecrypter, cipherStream2);
          const plaintextBytes2 = await DataStream.toBytes(plaintextDataStream2);
          expect(ArrayUtility.byteArraysEqual(plaintextBytes2, bobMessageBytes)).toBe(true);

          // test unable to decrypt the message if derived key has an unexpected path
          const invalidDerivationPath = [KeyDerivationScheme.ProtocolPath, protocolDefinition.protocol, 'invalidContextId'];
          const inValidDescendantPrivateKey: DerivedPrivateJwk
            = await TestDataGenerator.deriveDescendantPrivateKey(rootPrivateKey, invalidDerivationPath);
          const invalidDescendantKeyDecrypter = TestDataGenerator.createKeyDecrypter(inValidDescendantPrivateKey);
          await expect(
            Records.decrypt(fetchedRecordsWrite, invalidDescendantKeyDecrypter, DataStream.fromBytes(bobMessageEncryptedBytes))
          ).rejects.toThrow(DwnErrorCode.RecordsInvalidAncestorKeyDerivationSegment);

          // test unable to decrypt the message if no derivation scheme used by the message matches the scheme used by the given private key
          const privateKeyWithMismatchingDerivationScheme: DerivedPrivateJwk = {
            rootKeyId         : alice.keyId,
            derivationScheme  : 'scheme-that-is-not-protocol-path' as any,
            derivedPrivateKey : alice.encryptionKeyPair.privateJwk
          };
          const mismatchingSchemeKeyDecrypter = TestDataGenerator.createKeyDecrypter(privateKeyWithMismatchingDerivationScheme);
          await expect(
            Records.decrypt(fetchedRecordsWrite, mismatchingSchemeKeyDecrypter, DataStream.fromBytes(bobMessageEncryptedBytes))
          ).rejects.toThrow(DwnErrorCode.RecordsDecryptUnsupportedKeyDerivationScheme);

          // test unable to decrypt the message if the given private key cannot derive a matching public key ID
          const privateKeyWithMismatchingKeyId: DerivedPrivateJwk = {
            rootKeyId         : bob.keyId,
            derivationScheme  : KeyDerivationScheme.ProtocolPath,
            derivedPrivateKey : bob.encryptionKeyPair.privateJwk
          };
          const mismatchingKeyIdDecrypter = TestDataGenerator.createKeyDecrypter(privateKeyWithMismatchingKeyId);
          await expect(
            Records.decrypt(fetchedRecordsWrite, mismatchingKeyIdDecrypter, DataStream.fromBytes(bobMessageEncryptedBytes))
          ).rejects.toThrow(DwnErrorCode.RecordsDecryptNoMatchingKeyEncryptedFound);
        });
      });
    });

    it('should return 401 if signature check fails', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const recordsRead = await RecordsRead.create({
        filter: {
          recordId: 'any-id',
        },
        signer: Jws.createSigner(alice)
      });

      // setting up a stub did resolver & message store
      // intentionally not supplying the public key so a different public key is generated to simulate invalid signature
      const mismatchingPersona = await TestDataGenerator.generatePersona({ did: alice.did, keyId: alice.keyId });
      const didResolver = TestStubGenerator.createDidResolverStub(mismatchingPersona);
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const dataStoreStub = sinon.createStubInstance(DataStoreLevel);

      const recordsReadHandler = new RecordsReadHandler({
        didResolver, messageStore          : messageStoreStub, dataStore             : dataStoreStub,
        validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub, dataStore: dataStoreStub }),
      });
      const reply = await recordsReadHandler.handle({ tenant: alice.did, message: recordsRead.message });
      expect(reply.status.code).toBe(401);
    });

    it('should return 400 if fail parsing the message', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const recordsRead = await RecordsRead.create({
        filter: {
          recordId: 'any-id',
        },
        signer: Jws.createSigner(alice)
      });

      // setting up a stub method resolver & message store
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const dataStoreStub = sinon.createStubInstance(DataStoreLevel);

      const recordsReadHandler = new RecordsReadHandler({
        didResolver, messageStore          : messageStoreStub, dataStore             : dataStoreStub,
        validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub, dataStore: dataStoreStub }),
      });

      // stub the `parse()` function to throw an error
      sinon.stub(RecordsRead, 'parse').throws('anyError');
      const reply = await recordsReadHandler.handle({ tenant: alice.did, message: recordsRead.message });

      expect(reply.status.code).toBe(400);
    });
  });
}
