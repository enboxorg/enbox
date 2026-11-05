import type { DerivedPrivateJwk } from '../../src/utils/hd-key.js';
import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, EncryptionInput, MessageStore, ModuleDefinition, ModuleRuleSet, RecordsReadReply, ResumableTaskStore } from '../../src/index.js';

import { createAudienceControlWrite } from '../utils/encryption-control-test-utils.js';
import { Encoder } from '../../src/index.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import sinon from 'sinon';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import threadRoleModuleDefinition from '../vectors/module-definitions/thread-role.json' with { type: 'json' };

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  ContentEncryptionAlgorithm,
  DataStream,
  Dwn,
  Encryption,
  Jws,
  KeyAgreementAlgorithm,
  Modules,
  Records,
  RecordsRead,
  ROLE_AUDIENCE_DERIVATION_SCHEME
} from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testEndToEndScenarios(): void {
  describe('End-to-end Scenarios Spanning Features', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
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

    it('should support module-path encrypted records with role-authorized reads', async () => {
      // Scenario:
      // 1. Alice starts a chat thread and adds Bob as a plaintext participant role.
      // 2. Alice writes an encrypted chat message with a module-path CEK wrap.
      // 3. Bob reads the encrypted message through his participant role.
      // 4. Alice decrypts through her module-path key.

      // creating Alice and Bob persona and setting up a stub DID resolver
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

      const moduleDefinition: ModuleDefinition = structuredClone(threadRoleModuleDefinition) as ModuleDefinition;
      moduleDefinition.types.chat.encryptionRequired = true;
      const threadRuleSet = moduleDefinition.structure.thread as ModuleRuleSet;
      const participantRuleSet = threadRuleSet.participant as ModuleRuleSet;
      const chatRuleSet = threadRuleSet.chat as ModuleRuleSet;
      participantRuleSet.$actions = [
        { who: 'author', of: 'thread', can: ['create'] },
        { role: 'thread/participant', can: ['read', 'create'] },
      ];
      chatRuleSet.$actions = [
        { who: 'author', of: 'thread', can: ['create'] },
        ...chatRuleSet.$actions!,
      ];

      // Alice configures chat module with encryption
      const moduleDefinitionForAlice = await Modules.deriveAndInjectPublicEncryptionKeys(
        moduleDefinition, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
      );
      const encryptedThreadRuleSet = moduleDefinitionForAlice.structure.thread as ModuleRuleSet;
      const encryptedParticipantRuleSet = encryptedThreadRuleSet.participant as ModuleRuleSet;
      const encryptedChatRuleSet = encryptedThreadRuleSet.chat as ModuleRuleSet;
      const modulesConfigureForAlice = await TestDataGenerator.generateModulesConfigure({
        author           : alice,
        moduleDefinition : moduleDefinitionForAlice
      });

      const modulesConfigureForAliceReply = await dwn.processMessage(
        alice.did,
        modulesConfigureForAlice.message
      );
      expect(modulesConfigureForAliceReply.status.code).toBe(202);

      // 1. Alice starts a plaintext chat thread writing to her own DWN
      const threadBytes = Encoder.objectToBytes({ title: 'Top Secret' });
      const threadRecord = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : moduleDefinition.module,
        modulePath : 'thread',
        data       : threadBytes,
      });
      const threadRecordReply1 = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
      expect(threadRecordReply1.status.code).toBe(202);

      // 2. Alice adds Bob as a plaintext participant role.
      const participantBobRecord = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        data            : Encoder.objectToBytes({ did: bob.did }),
        parentContextId : threadRecord.message.contextId,
        module          : moduleDefinition.module,
        modulePath      : 'thread/participant',
        recipient       : bob.did,
      });
      const participantRecordReply =
        await dwn.processMessage(alice.did, participantBobRecord.message, { dataStream: participantBobRecord.dataStream });
      expect(participantRecordReply.status.code).toBe(202);

      const role = 'thread/participant';
      const audience = await createAudienceControlWrite({
        author      : alice,
        module      : moduleDefinition.module,
        rolePath    : role,
        contextId   : threadRecord.message.contextId!,
        roleRuleSet : encryptedParticipantRuleSet,
      });
      const audienceReply = await dwn.processMessage(
        alice.did,
        audience.recordsWrite.message,
        { dataStream: DataStream.fromBytes(audience.dataBytes) }
      );
      expect(audienceReply.status.code).toBe(202);
      const roleKeyId = audience.keyId;
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;

      // 3. Alice writes a chat message in the thread.
      const messageByAlice = 'Message from Alice';
      const dataEncryptionKey = TestDataGenerator.randomBytes(32);
      const dataEncryptionInitializationVector = TestDataGenerator.randomBytes(16);
      const encryptedData = await Encryption.encrypt(
        ContentEncryptionAlgorithm.A256CTR,
        dataEncryptionKey,
        dataEncryptionInitializationVector,
        Encoder.stringToBytes(messageByAlice)
      );
      const modulePathPublicKey = encryptedChatRuleSet.$keyAgreement!.publicKeyJwk;
      const encryptionInput: EncryptionInput = {
        initializationVector : dataEncryptionInitializationVector,
        key                  : dataEncryptionKey,
        keyEncryptionInputs  : [
          {
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            keyId            : await Encryption.getKeyId(modulePathPublicKey),
            publicKey        : modulePathPublicKey,
            derivationScheme : KeyDerivationScheme.ModulePath,
          },
          {
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            keyId            : roleKeyId,
            publicKey        : rolePublicKey,
            derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
            module           : moduleDefinition.module,
            rolePath         : role,
          },
        ],
      };
      const chatMessageByAlice = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : moduleDefinition.module,
        modulePath      : 'thread/chat',
        parentContextId : threadRecord.message.contextId,
        data            : encryptedData,
        encryptionInput,
      });
      const chatMessageReply = await dwn.processMessage(alice.did, chatMessageByAlice.message, { dataStream: chatMessageByAlice.dataStream });
      expect(chatMessageReply.status.code).toBe(202);

      // Bob can read his participant role record.
      const participantRead = await RecordsRead.create({
        signer : Jws.createSigner(bob),
        filter : {
          modulePath : 'thread/participant',
          recipient  : bob.did,
          contextId  : threadRecord.message.contextId
        },
      });
      const participantReadReply = await dwn.processMessage(alice.did, participantRead.message) as RecordsReadReply;
      expect(participantReadReply.status.code).toBe(200);

      // Test that Bob is able to read the thread root record.
      const threadRead = await RecordsRead.create({
        signer : Jws.createSigner(bob),
        filter : {
          modulePath : 'thread',
          contextId  : threadRecord.message.contextId
        },
        moduleRole: 'thread/participant'
      });
      const threadReadReply = await dwn.processMessage(alice.did, threadRead.message) as RecordsReadReply;
      expect(threadReadReply.status.code).toBe(200);
      expect(threadReadReply.entry!.recordsWrite).toBeDefined();

      // Test Bob can invoke his participant role to read the chat message.
      const chatRead = await RecordsRead.create({
        signer : Jws.createSigner(bob),
        filter : {
          modulePath : 'thread/chat',
          contextId  : threadRecord.message.contextId
        },
        moduleRole: 'thread/participant'
      });
      const chatReadReply = await dwn.processMessage(alice.did, chatRead.message) as RecordsReadReply;
      expect(chatReadReply.status.code).toBe(200);
      expect(chatReadReply.entry!.recordsWrite).toBeDefined();

      const encryptedChatMessageBytes = await DataStream.toBytes(chatReadReply.entry!.data!); // to create streams for testing
      // Alice can decrypt through the module-path entry.
      const aliceRootKey: DerivedPrivateJwk = {
        derivedPrivateKey : alice.encryptionKeyPair.privateJwk,
        derivationScheme  : KeyDerivationScheme.ModulePath,
        rootKeyId         : alice.keyId,
      };
      const decryptedChatMessageStream2 = await Records.decrypt(
        chatReadReply.entry!.recordsWrite!,
        TestDataGenerator.createKeyDecrypter(aliceRootKey),
        DataStream.fromBytes(encryptedChatMessageBytes)
      );
      expect(await DataStream.toBytes(decryptedChatMessageStream2)).toEqual(Encoder.stringToBytes(messageByAlice));
    });
  });
}
