import type { DerivedPrivateJwk } from '../../src/utils/hd-key.js';
import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type {
  DataStore,
  EncryptionControlDeliveryPayload,
  EncryptionInput,
  KeyDecrypter,
  MessageStore,
  ProtocolDefinition,
  ProtocolRuleSet,
  RecordsReadReply,
  ResumableTaskStore,
  RoleAudienceKeyMaterial,
} from '../../src/index.js';

import { Encoder } from '../../src/index.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import sinon from 'sinon';
import slackProtocolDefinition from '../vectors/protocol-definitions/slack.json' with { type: 'json' };
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  ContentEncryptionAlgorithm,
  DataStream,
  Dwn,
  Encryption,
  EncryptionControlDeliveryRecipientAuthority,
  Jws,
  KeyAgreementAlgorithm,
  Protocols,
  Records,
  RecordsQuery,
  RecordsRead,
  RecordsWrite,
  ROLE_AUDIENCE_DERIVATION_SCHEME
} from '../../src/index.js';
import { createAudienceControlWrite, createDeliveryControlWrite } from '../utils/encryption-control-test-utils.js';
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

    it('should support protocol-path encrypted records with role-authorized reads', async () => {
      // Scenario:
      // 1. Alice starts a chat thread and adds Bob as a plaintext participant role.
      // 2. Alice writes an encrypted chat message with a protocol-path CEK wrap.
      // 3. Bob reads the encrypted message through his participant role.
      // 4. Alice decrypts through her protocol-path key.

      // creating Alice and Bob persona and setting up a stub DID resolver
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

      const protocolDefinition: ProtocolDefinition = structuredClone(threadRoleProtocolDefinition) as ProtocolDefinition;
      protocolDefinition.types.chat.encryptionRequired = true;
      const threadRuleSet = protocolDefinition.structure.thread as ProtocolRuleSet;
      const participantRuleSet = threadRuleSet.participant as ProtocolRuleSet;
      const chatRuleSet = threadRuleSet.chat as ProtocolRuleSet;
      participantRuleSet.$actions = [
        { who: 'author', of: 'thread', can: ['create'] },
        { role: 'thread/participant', can: ['read', 'create'] },
      ];
      chatRuleSet.$actions = [
        { who: 'author', of: 'thread', can: ['create'] },
        ...chatRuleSet.$actions!,
      ];

      // Alice configures chat protocol with encryption
      const protocolDefinitionForAlice = await Protocols.deriveAndInjectPublicEncryptionKeys(
        protocolDefinition, TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
      );
      const encryptedThreadRuleSet = protocolDefinitionForAlice.structure.thread as ProtocolRuleSet;
      const encryptedParticipantRuleSet = encryptedThreadRuleSet.participant as ProtocolRuleSet;
      const encryptedChatRuleSet = encryptedThreadRuleSet.chat as ProtocolRuleSet;
      const protocolsConfigureForAlice = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : protocolDefinitionForAlice
      });

      const protocolsConfigureForAliceReply = await dwn.processMessage(
        alice.did,
        protocolsConfigureForAlice.message
      );
      expect(protocolsConfigureForAliceReply.status.code).toBe(202);

      // 1. Alice starts a plaintext chat thread writing to her own DWN
      const threadBytes = Encoder.objectToBytes({ title: 'Top Secret' });
      const threadRecord = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'thread',
        data         : threadBytes,
      });
      const threadRecordReply1 = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
      expect(threadRecordReply1.status.code).toBe(202);

      // 2. Alice adds Bob as a plaintext participant role.
      const participantBobRecord = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        data            : Encoder.objectToBytes({ did: bob.did }),
        parentContextId : threadRecord.message.contextId,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'thread/participant',
        recipient       : bob.did,
      });
      const participantRecordReply =
        await dwn.processMessage(alice.did, participantBobRecord.message, { dataStream: participantBobRecord.dataStream });
      expect(participantRecordReply.status.code).toBe(202);

      const role = 'thread/participant';
      const audience = await createAudienceControlWrite({
        author      : alice,
        protocol    : protocolDefinition.protocol,
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
      const protocolPathPublicKey = encryptedChatRuleSet.$keyAgreement!.publicKeyJwk;
      const encryptionInput: EncryptionInput = {
        initializationVector : dataEncryptionInitializationVector,
        key                  : dataEncryptionKey,
        keyEncryptionInputs  : [
          {
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            keyId            : await Encryption.getKeyId(protocolPathPublicKey),
            publicKey        : protocolPathPublicKey,
            derivationScheme : KeyDerivationScheme.ProtocolPath,
          },
          {
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            keyId            : roleKeyId,
            publicKey        : rolePublicKey,
            derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
            protocol         : protocolDefinition.protocol,
            rolePath         : role,
          },
        ],
      };
      const chatMessageByAlice = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'thread/chat',
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
          protocolPath : 'thread/participant',
          recipient    : bob.did,
          contextId    : threadRecord.message.contextId
        },
      });
      const participantReadReply = await dwn.processMessage(alice.did, participantRead.message) as RecordsReadReply;
      expect(participantReadReply.status.code).toBe(200);

      // Test that Bob is able to read the thread root record.
      const threadRead = await RecordsRead.create({
        signer : Jws.createSigner(bob),
        filter : {
          protocolPath : 'thread',
          contextId    : threadRecord.message.contextId
        },
        protocolRole: 'thread/participant'
      });
      const threadReadReply = await dwn.processMessage(alice.did, threadRead.message) as RecordsReadReply;
      expect(threadReadReply.status.code).toBe(200);
      expect(threadReadReply.entry!.recordsWrite).toBeDefined();

      // Test Bob can invoke his participant role to read the chat message.
      const chatRead = await RecordsRead.create({
        signer : Jws.createSigner(bob),
        filter : {
          protocolPath : 'thread/chat',
          contextId    : threadRecord.message.contextId
        },
        protocolRole: 'thread/participant'
      });
      const chatReadReply = await dwn.processMessage(alice.did, chatRead.message) as RecordsReadReply;
      expect(chatReadReply.status.code).toBe(200);
      expect(chatReadReply.entry!.recordsWrite).toBeDefined();

      const encryptedChatMessageBytes = await DataStream.toBytes(chatReadReply.entry!.data!); // to create streams for testing
      // Alice can decrypt through the protocol-path entry.
      const aliceRootKey: DerivedPrivateJwk = {
        derivedPrivateKey : alice.encryptionKeyPair.privateJwk,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        rootKeyId         : alice.keyId,
      };
      const decryptedChatMessageStream2 = await Records.decrypt(
        chatReadReply.entry!.recordsWrite!,
        TestDataGenerator.createKeyDecrypter(aliceRootKey),
        DataStream.fromBytes(encryptedChatMessageBytes)
      );
      expect(await DataStream.toBytes(decryptedChatMessageStream2)).toEqual(Encoder.stringToBytes(messageByAlice));
    });

    it('should bootstrap an offline nested encrypted role replica from RecordsRead support', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

      const definition = structuredClone(slackProtocolDefinition) as ProtocolDefinition;
      definition.protocol = 'http://notesd-replication-support.test';
      definition.types.message.encryptionRequired = true;
      const community = definition.structure.community as ProtocolRuleSet;
      const channel = community.gatedChannel as ProtocolRuleSet;
      const adminAction = channel.$actions![0];
      adminAction.can = adminAction.can!.filter((action): boolean => action !== 'read');

      const aliceDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
        definition,
        TestDataGenerator.createProtocolPathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk),
      );
      const bobDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
        definition,
        TestDataGenerator.createProtocolPathKeyDeriver(bob.keyId, bob.encryptionKeyPair.privateJwk),
      );
      const configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : aliceDefinition,
      });
      expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);

      const notebook = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        data         : Encoder.objectToBytes({ title: 'Notebook' }),
        protocol     : definition.protocol,
        protocolPath : 'community',
      });
      expect((await dwn.processMessage(alice.did, notebook.message, { dataStream: notebook.dataStream })).status.code).toBe(202);

      const adminRolePath = 'community/admin';
      const admin = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        data            : Encoder.objectToBytes({ role: 'admin' }),
        parentContextId : notebook.message.contextId,
        protocol        : definition.protocol,
        protocolPath    : adminRolePath,
        recipient       : alice.did,
      });
      expect((await dwn.processMessage(alice.did, admin.message, { dataStream: admin.dataStream })).status.code).toBe(202);

      const bobAdmin = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        data            : Encoder.objectToBytes({ role: 'admin' }),
        parentContextId : notebook.message.contextId,
        protocol        : definition.protocol,
        protocolPath    : adminRolePath,
        recipient       : bob.did,
      });
      expect((await dwn.processMessage(alice.did, bobAdmin.message, { dataStream: bobAdmin.dataStream })).status.code).toBe(202);

      const page = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        data            : Encoder.objectToBytes({ title: 'Shared page' }),
        parentContextId : notebook.message.contextId,
        protocol        : definition.protocol,
        protocolPath    : 'community/gatedChannel',
        protocolRole    : 'community/admin',
      });
      expect((await dwn.processMessage(alice.did, page.message, { dataStream: page.dataStream })).status.code).toBe(202);

      const rolePath = 'community/gatedChannel/participant';
      const participant = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        data            : Encoder.objectToBytes({ role: 'collaborator' }),
        parentContextId : page.message.contextId,
        protocol        : definition.protocol,
        protocolPath    : rolePath,
        recipient       : bob.did,
      });
      expect((await dwn.processMessage(alice.did, participant.message, { dataStream: participant.dataStream })).status.code).toBe(202);

      const roleRuleSet = ((aliceDefinition.structure.community as ProtocolRuleSet)
        .gatedChannel as ProtocolRuleSet).participant as ProtocolRuleSet;
      const audience = await createAudienceControlWrite({
        author    : alice,
        contextId : page.message.contextId,
        protocol  : definition.protocol,
        rolePath,
        roleRuleSet,
      });
      expect((await dwn.processMessage(alice.did, audience.recordsWrite.message, {
        dataStream: DataStream.fromBytes(audience.dataBytes),
      })).status.code).toBe(202);

      const adminRuleSet = (aliceDefinition.structure.community as ProtocolRuleSet).admin as ProtocolRuleSet;
      const adminAudience = await createAudienceControlWrite({
        author      : alice,
        contextId   : notebook.message.contextId,
        protocol    : definition.protocol,
        rolePath    : adminRolePath,
        roleRuleSet : adminRuleSet,
      });
      expect((await dwn.processMessage(alice.did, adminAudience.recordsWrite.message, {
        dataStream: DataStream.fromBytes(adminAudience.dataBytes),
      })).status.code).toBe(202);
      const adminDelivery = await createDeliveryControlWrite({
        author             : alice,
        contextId          : notebook.message.contextId,
        keyId              : adminAudience.keyId,
        protocol           : definition.protocol,
        recipient          : bob.did,
        recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
        rolePath           : adminRolePath,
        roleRuleSet        : adminRuleSet,
      });
      expect((await dwn.processMessage(alice.did, adminDelivery.recordsWrite.message, {
        dataStream: DataStream.fromBytes(adminDelivery.dataBytes),
      })).status.code).toBe(202);

      const bobRoleRuleSet = ((bobDefinition.structure.community as ProtocolRuleSet)
        .gatedChannel as ProtocolRuleSet).participant as ProtocolRuleSet;
      const bobRolePublicKey = bobRoleRuleSet.$keyAgreement!.publicKeyJwk;
      const audienceKeyMaterial: RoleAudienceKeyMaterial = {
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
        keyId            : audience.keyId,
        privateKeyJwk    : alice.encryptionKeyPair.privateJwk,
        publicKeyJwk     : alice.encryptionKeyPair.publicJwk,
      };
      const deliveryPayload: EncryptionControlDeliveryPayload = {
        protocol    : definition.protocol,
        rolePath,
        contextId   : page.message.contextId!,
        keyId       : audience.keyId,
        keyMaterial : audienceKeyMaterial,
      };
      const deliveryPlaintext = Encoder.objectToBytes(deliveryPayload);
      const deliveryKey = TestDataGenerator.randomBytes(32);
      const deliveryIv = TestDataGenerator.randomBytes(16);
      const deliveryCiphertext = await Encryption.encrypt(
        ContentEncryptionAlgorithm.A256CTR,
        deliveryKey,
        deliveryIv,
        deliveryPlaintext,
      );
      const delivery = await RecordsWrite.create({
        data            : deliveryCiphertext,
        dataFormat      : 'application/json',
        encryptionInput : {
          initializationVector : deliveryIv,
          key                  : deliveryKey,
          keyEncryptionInputs  : [{
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            derivationScheme : KeyDerivationScheme.ProtocolPath,
            keyId            : await Encryption.getKeyId(bobRolePublicKey),
            publicKey        : bobRolePublicKey,
          }],
        },
        protocol     : definition.protocol,
        protocolPath : '$encryption/delivery',
        recipient    : bob.did,
        schema       : 'https://identity.foundation/dwn/json-schemas/encryption/delivery.json',
        signer       : Jws.createSigner(alice),
        tags         : {
          protocol           : definition.protocol,
          rolePath,
          contextId          : page.message.contextId!,
          keyId              : audience.keyId,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
        },
      });
      const messageRuleSet = ((aliceDefinition.structure.community as ProtocolRuleSet)
        .gatedChannel as ProtocolRuleSet).message as ProtocolRuleSet;
      const plaintext = Encoder.stringToBytes('offline shared page data');
      const contentKey = TestDataGenerator.randomBytes(32);
      const contentIv = TestDataGenerator.randomBytes(16);
      const ciphertext = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, contentKey, contentIv, plaintext);
      const encryptedMessage = await TestDataGenerator.generateRecordsWrite({
        author          : bob,
        data            : ciphertext,
        encryptionInput : {
          initializationVector : contentIv,
          key                  : contentKey,
          keyEncryptionInputs  : [{
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            derivationScheme : KeyDerivationScheme.ProtocolPath,
            keyId            : await Encryption.getKeyId(messageRuleSet.$keyAgreement!.publicKeyJwk),
            publicKey        : messageRuleSet.$keyAgreement!.publicKeyJwk,
          }, {
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
            keyId            : audience.keyId,
            protocol         : definition.protocol,
            publicKey        : alice.encryptionKeyPair.publicJwk,
            rolePath,
          }, {
            algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
            keyId            : adminAudience.keyId,
            protocol         : definition.protocol,
            publicKey        : alice.encryptionKeyPair.publicJwk,
            rolePath         : adminRolePath,
          }],
        },
        parentContextId : page.message.contextId,
        protocol        : definition.protocol,
        protocolPath    : 'community/gatedChannel/message',
        protocolRole    : rolePath,
      });
      expect((await dwn.processMessage(alice.did, encryptedMessage.message, {
        dataStream: encryptedMessage.dataStream,
      })).status.code).toBe(202);

      const notReadyRead = await RecordsRead.create({
        filter: {
          protocol     : definition.protocol,
          protocolPath : 'community/gatedChannel/message',
          contextId    : encryptedMessage.message.contextId,
        },
        includeReplicationSupport : true,
        protocolRole              : rolePath,
        signer                    : Jws.createSigner(bob),
      });
      const notReadyReply = await dwn.processMessage(alice.did, notReadyRead.message) as RecordsReadReply;
      expect(notReadyReply.status.code).toBe(200);
      expect(notReadyReply.support?.some(entry => {
        return (entry.message.descriptor as { protocolPath?: string }).protocolPath === '$encryption/delivery';
      })).toBe(false);

      expect((await dwn.processMessage(alice.did, delivery.message, {
        dataStream: DataStream.fromBytes(deliveryCiphertext),
      })).status.code).toBe(202);

      const plaintextBootstrap = await RecordsRead.create({
        filter                    : { recordId: page.message.recordId },
        includeReplicationSupport : true,
        protocolRole              : rolePath,
        signer                    : Jws.createSigner(bob),
      });
      const plaintextReply = await dwn.processMessage(alice.did, plaintextBootstrap.message) as RecordsReadReply;
      expect(plaintextReply.status.code).toBe(200);
      expect(plaintextReply.support?.filter((entry): boolean => {
        const path = (entry.message.descriptor as { protocolPath?: string }).protocolPath;
        return path === '$encryption/audience' || path === '$encryption/delivery';
      }).map((entry): unknown => (entry.message.descriptor as { tags?: { rolePath?: unknown } }).tags?.rolePath))
        .toEqual([rolePath, rolePath]);

      const upgradedDefinition = structuredClone(aliceDefinition);
      upgradedDefinition.types.message.dataFormats = ['text/plain'];
      const upgradedConfigure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : upgradedDefinition,
      });
      expect((await dwn.processMessage(alice.did, upgradedConfigure.message)).status.code).toBe(202);

      const nonRoleBootstrap = await RecordsRead.create({
        filter                    : { recordId: encryptedMessage.message.recordId },
        includeReplicationSupport : true,
        signer                    : Jws.createSigner(bob),
      });
      expect((await dwn.processMessage(alice.did, nonRoleBootstrap.message)).status.code).toBe(401);

      const bootstrapRead = await RecordsRead.create({
        filter: {
          protocol     : definition.protocol,
          protocolPath : 'community/gatedChannel/message',
          contextId    : encryptedMessage.message.contextId,
        },
        includeReplicationSupport : true,
        protocolRole              : rolePath,
        signer                    : Jws.createSigner(bob),
      });
      const bootstrapReply = await dwn.processMessage(alice.did, bootstrapRead.message) as RecordsReadReply;
      expect(bootstrapReply.status.code).toBe(200);
      expect(bootstrapReply.roleRecordId).toBe(participant.message.recordId);
      expect(bootstrapReply.support?.map((entry): string | undefined => {
        return (entry.message.descriptor as { protocolPath?: string }).protocolPath;
      })).toEqual([
        undefined,
        undefined,
        'community',
        'community/gatedChannel',
        rolePath,
        '$encryption/audience',
        '$encryption/delivery',
        '$encryption/audience',
      ]);
      expect(bootstrapReply.support?.filter((entry): boolean => {
        return (entry.message.descriptor as { protocolPath?: string }).protocolPath === '$encryption/audience';
      }).map((entry): unknown => (entry.message.descriptor as { tags?: { rolePath?: unknown } }).tags?.rolePath)).toEqual([
        rolePath,
        adminRolePath,
      ]);
      expect(bootstrapReply.support?.filter((entry): boolean => {
        return (entry.message.descriptor as { protocolPath?: string }).protocolPath === '$encryption/delivery';
      }).map((entry): unknown => (entry.message.descriptor as { tags?: { rolePath?: unknown } }).tags?.rolePath)).toEqual([
        rolePath,
      ]);
      expect(bootstrapReply.support?.slice(0, 2).map((entry): boolean | undefined => entry.isLatestBaseState)).toEqual([
        false,
        true,
      ]);
      expect(bootstrapReply.support?.slice(2, 4).every((entry): boolean => entry.encodedData === undefined)).toBe(true);
      expect(bootstrapReply.support?.slice(4).every((entry): boolean => entry.encodedData !== undefined)).toBe(true);
      const rootBytes = await DataStream.toBytes(bootstrapReply.entry!.data!);

      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();

      for (const entry of bootstrapReply.support!) {
        if (entry.initialWrite !== undefined) {
          expect((await dwn.applyReplicatedMessage(alice.did, entry.initialWrite)).kind).toBe('Applied');
        }
        const dataStream = entry.encodedData === undefined
          ? undefined
          : DataStream.fromBytes(Encoder.base64UrlToBytes(entry.encodedData));
        expect((await dwn.applyReplicatedMessage(alice.did, entry.message, { dataStream })).kind).toBe('Applied');
      }
      if (bootstrapReply.entry!.initialWrite !== undefined) {
        expect((await dwn.applyReplicatedMessage(alice.did, bootstrapReply.entry!.initialWrite)).kind).toBe('Applied');
      }
      expect((await dwn.applyReplicatedMessage(alice.did, bootstrapReply.entry!.recordsWrite!, {
        dataStream: DataStream.fromBytes(rootBytes),
      })).kind).toBe('Applied');

      const localQuery = await RecordsQuery.create({
        filter: {
          protocol     : definition.protocol,
          protocolPath : 'community/gatedChannel/message',
          contextId    : page.message.contextId,
        },
        protocolRole : rolePath,
        signer       : Jws.createSigner(bob),
      });
      const localReply = await dwn.processMessage(alice.did, localQuery.message);
      expect(localReply.status.code).toBe(200);
      expect(localReply.entries?.[0].recordId).toBe(encryptedMessage.message.recordId);

      const rolePathPrivate = await TestDataGenerator.deriveDescendantPrivateKey({
        derivedPrivateKey : bob.encryptionKeyPair.privateJwk,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        rootKeyId         : bob.keyId,
      }, [KeyDerivationScheme.ProtocolPath, definition.protocol, ...rolePath.split('/')]);
      const deliveryDecrypter = fixedKeyDecrypter({
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        privateKeyJwk    : rolePathPrivate.derivedPrivateKey,
        publicKeyJwk     : bobRolePublicKey,
      });
      const decryptedDelivery = await Records.decrypt(
        delivery.message,
        deliveryDecrypter,
        DataStream.fromBytes(deliveryCiphertext),
      );
      const deliveredKey = (Encoder.bytesToObject(
        await DataStream.toBytes(decryptedDelivery),
      ) as EncryptionControlDeliveryPayload).keyMaterial;
      const audienceDecrypter = fixedKeyDecrypter({
        derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
        privateKeyJwk    : deliveredKey.privateKeyJwk,
        publicKeyJwk     : deliveredKey.publicKeyJwk,
      });
      const decryptedRoot = await Records.decrypt(
        bootstrapReply.entry!.recordsWrite!,
        audienceDecrypter,
        DataStream.fromBytes(rootBytes),
      );
      expect(await DataStream.toBytes(decryptedRoot)).toEqual(plaintext);
    });
  });
}

function fixedKeyDecrypter(input: {
  derivationScheme: KeyDecrypter['derivationScheme'];
  privateKeyJwk: RoleAudienceKeyMaterial['privateKeyJwk'];
  publicKeyJwk: RoleAudienceKeyMaterial['publicKeyJwk'];
}): KeyDecrypter {
  return {
    decrypt: async (_fullDerivationPath, keyUnwrapPayload): Promise<Uint8Array> => {
      return Encryption.unwrapKey(input.privateKeyJwk, keyUnwrapPayload.keyEncryption);
    },
    derivationScheme : input.derivationScheme,
    derivePublicKey  : async () => input.publicKeyJwk,
    rootKeyId        : 'fixed-test-key',
  };
}
