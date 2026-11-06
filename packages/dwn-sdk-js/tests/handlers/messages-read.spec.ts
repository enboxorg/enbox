import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type {
  DataStore,
  MessagesReadReply,
  MessageStore,
  ModuleDefinition,
  ModuleRuleSet,
  ResumableTaskStore,
} from '../../src/index.js';

import { Encoder } from '../../src/utils/encoder.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../../src/types/encryption-types.js';
import freeForAll from '../vectors/module-definitions/free-for-all.json' with { type: 'json' };
import { GeneralJwsVerifier } from '../../src/jose/jws/general/verifier.js';
import { Message } from '../../src/core/message.js';
import minimalModuleDefinition from '../vectors/module-definitions/minimal.json' with { type: 'json' };
import sinon from 'sinon';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createAudienceControlWrite, createDeliveryControlWrite, installEncryptedModule, processControlWrite } from '../utils/encryption-control-test-utils.js';
import {
  DataStream,
  Dwn,
  DwnConstant,
  DwnErrorCode,
  DwnInterfaceName,
  DwnMethodName,
  EncryptionModule,
  Jws,
  PermissionGrant,
  PermissionsModule,
  Time,
} from '../../src/index.js';
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

          await TestDataGenerator.installDefaultTestModule(dwn, bob);

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

            await TestDataGenerator.installDefaultTestModule(dwn, alice);

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

            await TestDataGenerator.installDefaultTestModule(dwn, alice);

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

            await TestDataGenerator.installDefaultTestModule(dwn, alice);

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

      describe('Module interface messages', () => {
        it('returns a 401 if the tenant is not the author', async () => {
          // scenario:  Alice configures both a published and non-published module and writes it to her DWN.
          //            Bob is unable to read either of the ModuleConfigure messages because he is not the author.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // unpublished module configuration
          const unpublishedModuleDefinition = {
            ...minimalModuleDefinition,
            module    : 'http://example.com/module/unpublished',
            published : false
          };
          const { message: unpublishedModulesConfigure } = await TestDataGenerator.generateModulesConfigure({
            author           : alice,
            moduleDefinition : unpublishedModuleDefinition
          });
          const unpublishedModulesConfigureReply = await dwn.processMessage(alice.did, unpublishedModulesConfigure);
          expect(unpublishedModulesConfigureReply.status.code).toBe(202);

          // published module configuration
          const publishedModuleDefinition = {
            ...minimalModuleDefinition,
            module    : 'http://example.com/module/published',
            published : true
          };
          const { message: publishedModulesConfigure } = await TestDataGenerator.generateModulesConfigure({
            author           : alice,
            moduleDefinition : publishedModuleDefinition
          });
          const publishedModulesConfigureReply = await dwn.processMessage(alice.did, publishedModulesConfigure);
          expect(publishedModulesConfigureReply.status.code).toBe(202);

          // get the message CIDs
          const unpublishedModuleMessageCid = await Message.getCid(unpublishedModulesConfigure);
          const publishedModuleMessageCid = await Message.getCid(publishedModulesConfigure);

          // bob attempts to read the unpublished module configuration
          const { message: getUnpublishedModuleConfigure } = await TestDataGenerator.generateMessagesRead({
            author     : bob,
            messageCid : unpublishedModuleMessageCid,
          });
          const getUnpublishedModuleConfigureReply = await dwn.processMessage(alice.did, getUnpublishedModuleConfigure);
          expect(getUnpublishedModuleConfigureReply.status.code).toBe(401);
          expect(getUnpublishedModuleConfigureReply.status.detail).toContain(DwnErrorCode.MessagesReadAuthorizationFailed);
          expect(getUnpublishedModuleConfigureReply.entry).toBeUndefined();

          // bob attempts to read the published module configuration
          const { message: getPublishedModuleConfigure } = await TestDataGenerator.generateMessagesRead({
            author     : bob,
            messageCid : publishedModuleMessageCid,
          });
          const getPublishedModuleConfigureReply = await dwn.processMessage(alice.did, getPublishedModuleConfigure);
          expect(getPublishedModuleConfigureReply.status.code).toBe(401);
          expect(getPublishedModuleConfigureReply.status.detail).toContain(DwnErrorCode.MessagesReadAuthorizationFailed);
          expect(getPublishedModuleConfigureReply.entry).toBeUndefined();

          // control: alice is able to read both the published and unpublished module configurations
          const { message: getUnpublishedModuleConfigureAlice } = await TestDataGenerator.generateMessagesRead({
            author     : alice,
            messageCid : unpublishedModuleMessageCid,
          });
          const getUnpublishedModuleConfigureAliceReply = await dwn.processMessage(alice.did, getUnpublishedModuleConfigureAlice);
          expect(getUnpublishedModuleConfigureAliceReply.status.code).toBe(200);
          expect(getUnpublishedModuleConfigureAliceReply.entry).toBeDefined();
          expect(getUnpublishedModuleConfigureAliceReply.entry!.messageCid).toBe(unpublishedModuleMessageCid);
          expect(getUnpublishedModuleConfigureAliceReply.entry!.message).toEqual(unpublishedModulesConfigure);

          const { message: getPublishedModuleConfigureAlice } = await TestDataGenerator.generateMessagesRead({
            author     : alice,
            messageCid : publishedModuleMessageCid,
          });
          const getPublishedModuleConfigureAliceReply = await dwn.processMessage(alice.did, getPublishedModuleConfigureAlice);
          expect(getPublishedModuleConfigureAliceReply.status.code).toBe(200);
          expect(getPublishedModuleConfigureAliceReply.entry).toBeDefined();
          expect(getPublishedModuleConfigureAliceReply.entry!.messageCid).toBe(publishedModuleMessageCid);
          expect(getPublishedModuleConfigureAliceReply.entry!.message).toEqual(publishedModulesConfigure);
        });
      });
    });

    describe('with a grant', () => {
      it('transports delivery control records for MessagesRead grants', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const moduleDefinition: ModuleDefinition = {
          module    : 'http://messages-read-control-delivery.xyz',
          published : false,
          types     : {
            member : { schema: 'http://member-schema', dataFormats: ['application/json'] },
            post   : { schema: 'http://post-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member : { $role: true },
            post   : {},
          },
        };
        const encryptedDefinition = await installEncryptedModule(dwn, alice, moduleDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ModuleRuleSet;
        const audience = await createAudienceControlWrite({
          author   : alice,
          module   : moduleDefinition.module,
          rolePath : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const roleRecord = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          data       : Encoder.stringToBytes('bob is a member'),
          dataFormat : 'application/json',
          module     : moduleDefinition.module,
          modulePath : 'member',
          recipient  : bob.did,
          schema     : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, roleRecord.message, { dataStream: roleRecord.dataStream })).status.code).toBe(202);

        const delivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          module             : moduleDefinition.module,
          recipient          : bob.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, delivery);
        const deliveryCid = await Message.getCid(delivery.recordsWrite.message);

        const bobGrant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : bob,
          scope     : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            module    : moduleDefinition.module,
          },
        });
        expect((await dwn.processMessage(alice.did, bobGrant.message, { dataStream: bobGrant.dataStream })).status.code).toBe(202);

        const carolGrant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : carol,
          scope     : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            module    : moduleDefinition.module,
          },
        });
        expect((await dwn.processMessage(alice.did, carolGrant.message, { dataStream: carolGrant.dataStream })).status.code).toBe(202);

        const audienceCid = await Message.getCid(audience.recordsWrite.message);
        const carolAudienceRead = await TestDataGenerator.generateMessagesRead({
          author             : carol,
          messageCid         : audienceCid,
          permissionGrantIds : [carolGrant.message.recordId],
        });
        const carolAudienceReply = await dwn.processMessage(alice.did, carolAudienceRead.message);
        expect(carolAudienceReply.status.code).toBe(200);
        expect(carolAudienceReply.entry?.messageCid).toBe(audienceCid);

        const bobRead = await TestDataGenerator.generateMessagesRead({
          author             : bob,
          messageCid         : deliveryCid,
          permissionGrantIds : [bobGrant.message.recordId],
        });
        const bobReply = await dwn.processMessage(alice.did, bobRead.message);
        expect(bobReply.status.code).toBe(200);
        expect(bobReply.entry?.messageCid).toBe(deliveryCid);

        const carolRead = await TestDataGenerator.generateMessagesRead({
          author             : carol,
          messageCid         : deliveryCid,
          permissionGrantIds : [carolGrant.message.recordId],
        });
        const carolReply = await dwn.processMessage(alice.did, carolRead.message);
        expect(carolReply.status.code).toBe(200);
        expect(carolReply.entry?.messageCid).toBe(deliveryCid);
      });

      it('returns a 401 if grant has different DWN interface scope', async () => {
        // scenario: Alice grants Bob access to RecordsWrite, then Bob tries to invoke the grant with MessagesRead

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // alice installs a module
        const modulesConfig = await TestDataGenerator.generateModulesConfigure({
          author           : alice,
          moduleDefinition : minimalModuleDefinition
        });
        const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
        expect(modulesConfigureReply.status.code).toBe(202);

        // Alice writes a record which Bob will later try to read
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : minimalModuleDefinition.module,
          modulePath : 'foo',
        });
        const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(recordsWriteReply.status.code).toBe(202);

        // Alice gives Bob a permission grant scoped to a RecordsWrite and the module
        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Write,
            module    : minimalModuleDefinition.module,
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

        await TestDataGenerator.installDefaultTestModule(dwn, alice);

        // Alice writes a record to her DWN
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
        });
        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);
        const messageCid = await Message.getCid(message);

        // Alice issues a permission grant allowing Bob to read any record in her DWN
        const permissionGrant = await PermissionsModule.createGrant({
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

        const module1 = { ...minimalModuleDefinition, module: 'http://plural-grant-read-1' };
        const module2 = { ...minimalModuleDefinition, module: 'http://plural-grant-read-2' };

        for (const moduleDefinition of [module1, module2]) {
          const modulesConfig = await TestDataGenerator.generateModulesConfigure({
            author: alice,
            moduleDefinition,
          });
          const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
          expect(modulesConfigureReply.status.code).toBe(202);
        }

        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : module2.module,
          modulePath : 'foo',
        });
        const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(recordsWriteReply.status.code).toBe(202);

        const permissionGrantIds: string[] = [];
        for (const moduleDefinition of [module1, module2]) {
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              module    : moduleDefinition.module,
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
        const moduleDefinition = { ...minimalModuleDefinition, module: 'http://plural-grant-read-unresolved' };

        const modulesConfig = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
        expect(modulesConfigureReply.status.code).toBe(202);

        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : moduleDefinition.module,
          modulePath : 'foo',
        });
        const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
        expect(recordsWriteReply.status.code).toBe(202);

        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            module    : moduleDefinition.module,
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

      describe('module scoped messages', () => {
        it('allows reads of module messages with a module restricted grant scope', async () => {
          // This test will verify that a grant scoped to a specific module will allow a user to read messages associated with that module.
          // These messages include the ModuleConfiguration itself, even if not published,
          // any RecordsWrite or RecordsDelete messages associated with the module,
          // and any PermissionModule RecordsWrite messages associated with the module.

          // scenario: Alice configures a module that is unpublished and writes it to her DWN.
          //           Alice then gives Bob a grant to read messages from that module.
          //           Carol requests a grant to RecordsWrite to the module, and Alice grants it.
          //           Alice and Carol write records associated with the module.
          //           Alice also deletes a record associated with the module.
          //           Alice revokes the grant to Carol.
          //           Bob invokes his grant to read the various messages.
          //           As a control, Alice writes a record not associated with the module and Bob tries to unsuccessfully read it.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const carol = await TestDataGenerator.generateDidKeyPersona();

          const moduleDefinition = { ...minimalModuleDefinition, published: false };

          // Alice installs the unpublished module
          const modulesConfig = await TestDataGenerator.generateModulesConfigure({
            author: alice,
            moduleDefinition
          });
          const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
          expect(modulesConfigureReply.status.code).toBe(202);
          const moduleConfigureMessageCid = await Message.getCid(modulesConfig.message);

          // Carol requests a grant to write records to the module
          const permissionRequestCarol = await PermissionsModule.createRequest({
            signer    : Jws.createSigner(alice),
            delegated : false,
            scope     : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              module    : moduleDefinition.module,
            }
          });
          const requestDataStreamCarol = DataStream.fromBytes(permissionRequestCarol.permissionRequestBytes);
          const permissionRequestWriteReplyCarol = await dwn.processMessage(
            alice.did,
            permissionRequestCarol.recordsWrite.message,
            { dataStream: requestDataStreamCarol }
          );
          expect(permissionRequestWriteReplyCarol.status.code).toBe(202);

          // Alice gives Carol a grant to write records to the module
          const permissionGrantCarol = await PermissionsModule.createGrant({
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

          // Alice writes a record associated with the module
          const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : moduleDefinition.module,
            modulePath : 'foo',
          });
          const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
          expect(recordsWriteReply.status.code).toBe(202);
          const aliceRecordMessageCid = await Message.getCid(recordsWrite.message);

          // Alice deletes a record associated with the module
          const recordsDelete = await TestDataGenerator.generateRecordsDelete({
            author   : alice,
            recordId : recordsWrite.message.recordId,
          });
          const recordsDeleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
          expect(recordsDeleteReply.status.code).toBe(202);

          // Carol writes a record associated with the module
          const { recordsWrite: recordsWriteCarol, dataStream: dataStreamCarol } = await TestDataGenerator.generateRecordsWrite({
            author            : carol,
            module            : moduleDefinition.module,
            modulePath        : 'foo',
            permissionGrantId : permissionGrantCarol.recordsWrite.message.recordId,
          });
          const recordsWriteReplyCarol = await dwn.processMessage(alice.did, recordsWriteCarol.message, { dataStream: dataStreamCarol });
          expect(recordsWriteReplyCarol.status.code).toBe(202);
          const carolRecordMessageCid = await Message.getCid(recordsWriteCarol.message);

          // Alice revokes Carol's grant
          const permissionRevocationCarol = await PermissionsModule.createRevocation({
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
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              module    : moduleDefinition.module,
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
          // - Module Configuration
          // - Alice's RecordsWrite
          // - Alice's RecordsDelete
          // - Carol's Permission Request
          // - Alice's Permission Grant to Carol
          // - Carol's RecordsWrite
          // - Alice's Revocation of Carol's Grant

          // Module configuration
          const messagesReadModuleConfigure = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : moduleConfigureMessageCid,
            permissionGrantIds : [permissionGrant.recordsWrite.message.recordId],
          });
          const messagesReadModuleConfigureReply = await dwn.processMessage(alice.did, messagesReadModuleConfigure.message);
          expect(messagesReadModuleConfigureReply.status.code).toBe(200);
          expect(messagesReadModuleConfigureReply.entry).toBeDefined();
          expect(messagesReadModuleConfigureReply.entry!.message).toEqual(modulesConfig.message);

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

          // CONTROL: Alice writes a record not associated with the module
          await TestDataGenerator.installDefaultTestModule(dwn, alice);
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

        it('rejects message read of module messages with mismatching module grant scopes', async () => {
          // scenario: Alice writes a module record. Alice gives Bob a grant to read messages from a different module
          //           Bob invokes that grant to read the module message, but fails.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const moduleDefinition = minimalModuleDefinition;

          // Alice installs the module
          const modulesConfig = await TestDataGenerator.generateModulesConfigure({
            author: alice,
            moduleDefinition
          });
          const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
          expect(modulesConfigureReply.status.code).toBe(202);

          // Alice writes a record which Bob will later try to read
          const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : moduleDefinition.module,
            modulePath : 'foo',
          });
          const recordsWriteReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream });
          expect(recordsWriteReply.status.code).toBe(202);

          // Alice gives Bob a permission grant with scope MessagesRead
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              module    : 'a-different-module'
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

        it('rejects reading arbitrary permission records with a grant scoped to the Permissions module', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const appModuleGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              module    : minimalModuleDefinition.module,
            }
          });
          expect((await dwn.processMessage(
            alice.did,
            appModuleGrant.recordsWrite.message,
            { dataStream: DataStream.fromBytes(appModuleGrant.permissionGrantBytes) }
          )).status.code).toBe(202);

          const permissionsModuleGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              module    : PermissionsModule.uri,
            }
          });
          expect((await dwn.processMessage(
            alice.did,
            permissionsModuleGrant.recordsWrite.message,
            { dataStream: DataStream.fromBytes(permissionsModuleGrant.permissionGrantBytes) }
          )).status.code).toBe(202);

          const messagesRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(appModuleGrant.recordsWrite.message),
            permissionGrantIds : [permissionsModuleGrant.recordsWrite.message.recordId],
          });
          const messagesReadReply = await dwn.processMessage(alice.did, messagesRead.message);
          expect(messagesReadReply.status.code).toBe(401);
          expect(messagesReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);
        });

        it('authorizes Records messages with modulePath subtree Messages.Read grants', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const moduleDefinition = { ...freeForAll, module: 'http://messages-read-path-scope' };
          const otherModuleDefinition = { ...freeForAll, module: 'http://messages-read-path-scope-other' };

          const { message: moduleMessage } = await TestDataGenerator.generateModulesConfigure({
            author: alice,
            moduleDefinition
          });
          expect((await dwn.processMessage(alice.did, moduleMessage)).status.code).toBe(202);
          const { message: otherModuleMessage } = await TestDataGenerator.generateModulesConfigure({
            author           : alice,
            moduleDefinition : otherModuleDefinition
          });
          expect((await dwn.processMessage(alice.did, otherModuleMessage)).status.code).toBe(202);

          const { recordsWrite: post, dataStream: postData } = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : moduleDefinition.module,
            modulePath : 'post',
            schema     : moduleDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, post.message, { dataStream: postData })).status.code).toBe(202);

          const postContextId = post.message.contextId ?? post.message.recordId;
          const { recordsWrite: attachment, dataStream: attachmentData } = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            module          : moduleDefinition.module,
            modulePath      : 'post/attachment',
            parentContextId : postContextId,
          });
          expect((await dwn.processMessage(alice.did, attachment.message, { dataStream: attachmentData })).status.code).toBe(202);

          const { recordsWrite: otherModulePost, dataStream: otherModulePostData } = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : otherModuleDefinition.module,
            modulePath : 'post',
            schema     : otherModuleDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, otherModulePost.message, { dataStream: otherModulePostData })).status.code).toBe(202);

          const { recordsDelete } = await TestDataGenerator.generateRecordsDelete({
            author   : alice,
            recordId : post.message.recordId,
          });
          expect((await dwn.processMessage(alice.did, recordsDelete.message)).status.code).toBe(202);

          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface  : DwnInterfaceName.Messages,
              method     : DwnMethodName.Read,
              module     : moduleDefinition.module,
              modulePath : 'post',
            }
          });
          expect((await dwn.processMessage(
            alice.did,
            permissionGrant.recordsWrite.message,
            { dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes) }
          )).status.code).toBe(202);

          const grantId = permissionGrant.recordsWrite.message.recordId;
          const encryptionRecord = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : EncryptionModule.uri,
            modulePath : EncryptionModule.grantKeyPath,
            tags       : {
              grantId    : grantId,
              keyId      : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              module     : moduleDefinition.module,
              modulePath : 'post',
            },
          });
          await messageStore.put(alice.did, encryptionRecord.message, await encryptionRecord.recordsWrite.constructIndexes(true));

          const postRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(post.message),
            permissionGrantIds : [grantId],
          });
          const postReadReply = await dwn.processMessage(alice.did, postRead.message);
          expect(postReadReply.status.code).toBe(200);
          expect(postReadReply.entry!.data).toBeUndefined();
          expect('encodedData' in postReadReply.entry!.message).toBe(false);

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
          const attachmentReadReply = await dwn.processMessage(alice.did, attachmentRead.message);
          expect(attachmentReadReply.status.code).toBe(200);
          expect(attachmentReadReply.entry!.data).toBeUndefined();
          expect('encodedData' in attachmentReadReply.entry!.message).toBe(false);

          const otherModuleRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(otherModulePost.message),
            permissionGrantIds : [grantId],
          });
          const otherModuleReadReply = await dwn.processMessage(alice.did, otherModuleRead.message);
          expect(otherModuleReadReply.status.code).toBe(401);
          expect(otherModuleReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const moduleRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(moduleMessage),
            permissionGrantIds : [grantId],
          });
          const moduleReadReply = await dwn.processMessage(alice.did, moduleRead.message);
          expect(moduleReadReply.status.code).toBe(401);
          expect(moduleReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const otherModuleConfigRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(otherModuleMessage),
            permissionGrantIds : [grantId],
          });
          const otherModuleConfigReadReply = await dwn.processMessage(alice.did, otherModuleConfigRead.message);
          expect(otherModuleConfigReadReply.status.code).toBe(401);
          expect(otherModuleConfigReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const grantRecordRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(permissionGrant.recordsWrite.message),
            permissionGrantIds : [grantId],
          });
          const grantRecordReadReply = await dwn.processMessage(alice.did, grantRecordRead.message);
          expect(grantRecordReadReply.status.code).toBe(401);
          expect(grantRecordReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const encryptionRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(encryptionRecord.message),
            permissionGrantIds : [grantId],
          });
          const encryptionReadReply = await dwn.processMessage(alice.did, encryptionRead.message);
          expect(encryptionReadReply.status.code).toBe(401);
          expect(encryptionReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);
        });

        it('authorizes Records messages with context subtree Messages.Read grants', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const moduleDefinition = { ...freeForAll, module: 'http://messages-read-context-scope' };

          const { message: moduleMessage } = await TestDataGenerator.generateModulesConfigure({
            author: alice,
            moduleDefinition
          });
          expect((await dwn.processMessage(alice.did, moduleMessage)).status.code).toBe(202);

          const { recordsWrite: post, dataStream: postData } = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : moduleDefinition.module,
            modulePath : 'post',
            schema     : moduleDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, post.message, { dataStream: postData })).status.code).toBe(202);

          const postContextId = post.message.contextId ?? post.message.recordId;
          const { recordsWrite: attachment, dataStream: attachmentData } = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            module          : moduleDefinition.module,
            modulePath      : 'post/attachment',
            parentContextId : postContextId,
          });
          expect((await dwn.processMessage(alice.did, attachment.message, { dataStream: attachmentData })).status.code).toBe(202);

          const { recordsWrite: siblingPost, dataStream: siblingData } = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : moduleDefinition.module,
            modulePath : 'post',
            schema     : moduleDefinition.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, siblingPost.message, { dataStream: siblingData })).status.code).toBe(202);

          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              module    : moduleDefinition.module,
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
            const messagesReadReply = await dwn.processMessage(alice.did, messagesRead.message);
            expect(messagesReadReply.status.code).toBe(200);
            expect(messagesReadReply.entry!.data).toBeUndefined();
            expect('encodedData' in messagesReadReply.entry!.message).toBe(false);
          }

          const siblingRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(siblingPost.message),
            permissionGrantIds : [grantId],
          });
          const siblingReadReply = await dwn.processMessage(alice.did, siblingRead.message);
          expect(siblingReadReply.status.code).toBe(401);
          expect(siblingReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

          const moduleRead = await TestDataGenerator.generateMessagesRead({
            author             : bob,
            messageCid         : await Message.getCid(moduleMessage),
            permissionGrantIds : [grantId],
          });
          const moduleReadReply = await dwn.processMessage(alice.did, moduleRead.message);
          expect(moduleReadReply.status.code).toBe(401);
          expect(moduleReadReply.status.detail).toContain(DwnErrorCode.MessagesReadVerifyScopeFailed);

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

          const moduleDefinition = minimalModuleDefinition;

          // Alice installs the module
          const modulesConfig = await TestDataGenerator.generateModulesConfigure({
            author: alice,
            moduleDefinition,
          });
          const modulesConfigureReply = await dwn.processMessage(alice.did, modulesConfig.message);
          expect(modulesConfigureReply.status.code).toBe(202);

          // Alice gives bob a grant to read messages in the module
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              module    : moduleDefinition.module,
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
            author     : alice,
            module     : moduleDefinition.module,
            modulePath : 'foo',
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
