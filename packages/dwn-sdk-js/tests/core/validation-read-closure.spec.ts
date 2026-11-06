import type { DidResolver } from '@enbox/dids';
import type { EncryptionInput } from '../../src/utils/encryption.js';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { RecordingValidationStateReader } from '../../src/core/recording-validation-state-reader.js';
import type { DataStore, MessageStore, ResumableTaskStore } from '../../src/index.js';
import type { ModuleDefinition, ModuleRuleSet } from '../../src/types/modules-types.js';

import freeForAllModuleDefinition from '../vectors/module-definitions/free-for-all.json' with { type: 'json' };
import friendRoleModuleDefinition from '../vectors/module-definitions/friend-role.json' with { type: 'json' };
import nestedModuleDefinition from '../vectors/module-definitions/nested.json' with { type: 'json' };

import { createAudienceControlWrite } from '../utils/encryption-control-test-utils.js';
import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { DwnConstant } from '../../src/core/dwn-constant.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { RecordingValidationStateReader as RecordingReader } from '../../src/core/recording-validation-state-reader.js';
import { RecordsDelete } from '../../src/interfaces/records-delete.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { Time } from '../../src/utils/time.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, Encryption, KeyAgreementAlgorithm, ROLE_AUDIENCE_DERIVATION_SCHEME } from '../../src/utils/encryption.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';
import { KeyDerivationScheme, Modules } from '../../src/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

const VALIDATION_READER_METHODS = new Set<string>([
  'fetchInitialRecordsWrite',
  'fetchInitialWrite',
  'constructRecordChain',
  'fetchParentRecord',
  'isRecordPruned',
  'hasMatchingRoleRecord',
  'queryLatestRoleRecords',
  'queryAudienceRecords',
  'fetchGrant',
  'fetchOldestGrantRevocation',
  'fetchNewestRecordsWrite',
  'fetchModuleDefinition',
  'fetchLatestSquashRecordAtScope',
  'hasStoredData',
]);

const TRACE_ARTIFACT_PATH = new URL('./validation-read-trace.json', import.meta.url).pathname;

/**
 * Replay-basis closure: representative admissions run with a recording `ValidationStateReader`;
 * the test fails on any validation read outside the reader surface, and the recorded traces are
 * compared against the committed regression artifact (`validation-read-trace.json`).
 *
 * When validation reads legitimately change, regenerate the artifact deliberately:
 * `REGENERATE_VALIDATION_READ_TRACE=true bun test tests/core/validation-read-closure.spec.ts`
 * and review the diff.
 */
describe('validation read closure', () => {
  let didResolver: DidResolver;
  let messageStore: MessageStore;
  let dataStore: DataStore;
  let resumableTaskStore: ResumableTaskStore;
  let eventLog: EventLog;
  let dwn: Dwn;
  let recorder: RecordingValidationStateReader;

  beforeAll(async () => {
    didResolver = new UniversalResolver({ didResolvers: [DidKey] });

    const stores = TestStores.get();
    messageStore = stores.messageStore;
    dataStore = stores.dataStore;
    resumableTaskStore = stores.resumableTaskStore;
    eventLog = TestEventLog.get();

    dwn = await Dwn.create({
      didResolver, messageStore, dataStore, eventLog, resumableTaskStore,
      instrumentValidationStateReader: (validationStateReader): RecordingValidationStateReader => {
        recorder = new RecordingReader(validationStateReader);
        return recorder;
      },
    });
  });

  afterAll(async () => {
    await dwn.close();
  });

  it('should perform no validation read outside the reader surface across representative admissions', async () => {
    const trace: Record<string, string[]> = {};

    const clearStores = async (): Promise<void> => {
      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
    };

    const snapshot = (scenario: string): void => {
      const reads = recorder.reads.map((read): string => read.method);
      trace[scenario] = [...new Set(reads)].sort();
      recorder.clearRecordedReads();
    };

    // ---- scenario: live module record lifecycle ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: parentMessage, dataStream: parentDataStream, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, parentMessage, { dataStream: parentDataStream })).status.code).toBe(202);

      const { message: childMessage, dataStream: childDataStream, recordsWrite: childWrite } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : definition.module,
        modulePath      : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      expect((await dwn.processMessage(alice.did, childMessage, { dataStream: childDataStream })).status.code).toBe(202);

      const { message: updateMessage, dataStream: updateDataStream } = await TestDataGenerator.generateFromRecordsWrite({
        author: alice, existingWrite: childWrite,
      });
      expect((await dwn.processMessage(alice.did, updateMessage, { dataStream: updateDataStream })).status.code).toBe(202);

      const { message: queryMessage } = await TestDataGenerator.generateRecordsQuery({
        author: alice, filter: { recordId: childMessage.recordId },
      });
      expect((await dwn.processMessage(alice.did, queryMessage)).status.code).toBe(200);

      const recordsRead = await RecordsRead.create({ filter: { recordId: childMessage.recordId }, signer: Jws.createSigner(alice) });
      expect((await dwn.processMessage(alice.did, recordsRead.message)).status.code).toBe(200);

      const { message: deleteMessage } = await TestDataGenerator.generateRecordsDelete({ author: alice, recordId: childMessage.recordId });
      expect((await dwn.processMessage(alice.did, deleteMessage)).status.code).toBe(202);

      snapshot('live: module record lifecycle');
    }

    // ---- scenario: live role-authorized write ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = friendRoleModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: roleMessage, dataStream: roleDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: alice, recipient: bob.did, module: definition.module, modulePath: 'friend',
      });
      expect((await dwn.processMessage(alice.did, roleMessage, { dataStream: roleDataStream })).status.code).toBe(202);

      const { message: chatMessage, dataStream: chatDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: bob, module: definition.module, modulePath: 'chat', moduleRole: 'friend',
      });
      expect((await dwn.processMessage(alice.did, chatMessage, { dataStream: chatDataStream })).status.code).toBe(202);

      snapshot('live: role-authorized write');
    }

    // ---- scenario: live encrypted role-audience write ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const moduleDefinition: ModuleDefinition = {
        module    : 'http://encrypted-role-closure.xyz',
        published : false,
        types     : {
          thread      : { schema: 'http://thread-schema', dataFormats: ['application/json'] },
          participant : { schema: 'http://participant-schema', dataFormats: ['application/json'] },
          chat        : { schema: 'http://chat-schema', dataFormats: ['text/plain'], encryptionRequired: true },
        },
        structure: {
          thread: {
            participant : { $role: true },
            chat        : {
              $actions: [
                { role: 'thread/participant', can: ['read'] },
              ],
            },
          },
        },
      };
      const encryptedModuleDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
        moduleDefinition, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
      );
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({
        author           : alice,
        moduleDefinition : encryptedModuleDefinition,
      });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const thread = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : moduleDefinition.module,
        modulePath : 'thread',
        schema     : 'http://thread-schema',
        dataFormat : 'application/json',
        data       : Encoder.stringToBytes('{"title":"secret"}'),
      });
      expect((await dwn.processMessage(alice.did, thread.message, { dataStream: thread.dataStream })).status.code).toBe(202);

      const role = 'thread/participant';
      const threadRuleSet = encryptedModuleDefinition.structure.thread;
      const participantRuleSet = threadRuleSet.participant as ModuleRuleSet;
      const audience = await createAudienceControlWrite({
        author      : alice,
        module      : moduleDefinition.module,
        rolePath    : role,
        contextId   : thread.message.contextId!,
        roleRuleSet : participantRuleSet,
      });
      expect((await dwn.processMessage(
        alice.did,
        audience.recordsWrite.message,
        { dataStream: DataStream.fromBytes(audience.dataBytes) }
      )).status.code).toBe(202);
      const roleKeyId = audience.keyId;
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;

      const dataEncryptionKey = TestDataGenerator.randomBytes(32);
      const dataEncryptionInitializationVector = TestDataGenerator.randomBytes(16);
      const encryptedData = await Encryption.encrypt(
        ContentEncryptionAlgorithm.A256CTR,
        dataEncryptionKey,
        dataEncryptionInitializationVector,
        Encoder.stringToBytes('encrypted chat')
      );
      const chatRuleSet = threadRuleSet.chat as ModuleRuleSet;
      const modulePathPublicKey = chatRuleSet.$keyAgreement!.publicKeyJwk;
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

      recorder.clearRecordedReads(); // trace the encrypted role-audience write admission only
      const recordsWrite = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : moduleDefinition.module,
        modulePath      : 'thread/chat',
        parentContextId : thread.message.contextId,
        schema          : 'http://chat-schema',
        dataFormat      : 'text/plain',
        data            : encryptedData,
        encryptionInput,
      });
      const writeReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream: recordsWrite.dataStream });
      expect(writeReply.status.code).toBe(202);

      snapshot('live: encrypted role-audience write');
    }

    // ---- scenario: live composed module configure ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const baseDefinition: ModuleDefinition = {
        module    : 'http://closure-composition-base.xyz',
        published : false,
        types     : {
          profile: { schema: 'profile', dataFormats: ['text/plain'] },
        },
        structure: {
          profile: {},
        },
      };
      const composedDefinition: ModuleDefinition = {
        module    : 'http://closure-composition-composed.xyz',
        published : false,
        uses      : {
          base: baseDefinition.module,
        },
        types: {
          mirror: { schema: 'mirror', dataFormats: ['text/plain'] },
        },
        structure: {
          mirror: {
            $ref: 'base:profile',
          },
        },
      };
      const { message: baseConfigureMessage } = await TestDataGenerator.generateModulesConfigure({
        author           : alice,
        moduleDefinition : baseDefinition,
      });
      expect((await dwn.processMessage(alice.did, baseConfigureMessage)).status.code).toBe(202);

      const { message: composedConfigureMessage } = await TestDataGenerator.generateModulesConfigure({
        author           : alice,
        moduleDefinition : composedDefinition,
      });
      expect((await dwn.processMessage(alice.did, composedConfigureMessage)).status.code).toBe(202);

      snapshot('live: composed module configure');
    }

    // ---- scenario: live grant-authorized write ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = freeForAllModuleDefinition as ModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: grantMessage, dataStream: grantDataStream, recordsWrite: grantWrite } = await TestDataGenerator.generateGrantCreate({
        author    : alice,
        grantedTo : bob,
        scope     : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          module    : definition.module,
        },
      });
      expect((await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream })).status.code).toBe(202);

      const { message: grantedWriteMessage, dataStream: grantedWriteDataStream } = await TestDataGenerator.generateRecordsWrite({
        author            : bob,
        module            : definition.module,
        modulePath        : 'post',
        schema            : definition.types.post.schema,
        dataFormat        : definition.types.post.dataFormats![0],
        permissionGrantId : grantWrite.message.recordId,
      });
      expect((await dwn.processMessage(alice.did, grantedWriteMessage, { dataStream: grantedWriteDataStream })).status.code).toBe(202);

      snapshot('live: grant-authorized write');
    }

    // ---- scenario: live Messages.Read of a RecordsDelete with a module grant ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = freeForAllModuleDefinition as ModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: recordMessage, dataStream: recordDataStream } = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : definition.module,
        modulePath : 'post',
        schema     : definition.types.post.schema,
        dataFormat : definition.types.post.dataFormats![0],
      });
      expect((await dwn.processMessage(alice.did, recordMessage, { dataStream: recordDataStream })).status.code).toBe(202);

      const { message: deleteMessage } = await TestDataGenerator.generateRecordsDelete({ author: alice, recordId: recordMessage.recordId });
      expect((await dwn.processMessage(alice.did, deleteMessage)).status.code).toBe(202);

      const { dataStream: grantDataStream, recordsWrite: grantWrite } = await TestDataGenerator.generateGrantCreate({
        author    : alice,
        grantedTo : bob,
        scope     : {
          interface : DwnInterfaceName.Messages,
          method    : DwnMethodName.Read,
          module    : definition.module,
        },
      });
      expect((await dwn.processMessage(alice.did, grantWrite.message, { dataStream: grantDataStream })).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the grant-authorized Messages.Read only

      const { message: messagesReadMessage } = await TestDataGenerator.generateMessagesRead({
        author             : bob,
        messageCid         : await Message.getCid(deleteMessage),
        permissionGrantIds : [grantWrite.message.recordId],
      });
      expect((await dwn.processMessage(alice.did, messagesReadMessage)).status.code).toBe(200);

      snapshot('live: messages-read of deleted record with grant');
    }

    // ---- scenario: live record-limit candidate admission ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition: ModuleDefinition = {
        module    : 'http://record-limit-closure.xyz',
        published : false,
        types     : { item: { schema: 'item', dataFormats: ['text/plain'] } },
        structure : { item: { $recordLimit: { max: 1 } } },
      };
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: firstMessage, dataStream: firstDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'item', schema: 'item', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, firstMessage, { dataStream: firstDataStream })).status.code).toBe(202);

      const { message: secondMessage, dataStream: secondDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'item', schema: 'item', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, secondMessage, { dataStream: secondDataStream })).status.code).toBe(202);

      snapshot('live: record-limit candidate admission');
    }

    // ---- scenario: live squash backstop ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition: ModuleDefinition = {
        module    : 'http://squash-closure.xyz',
        published : false,
        types     : { patch: { schema: 'patch', dataFormats: ['text/plain'] } },
        structure : { patch: { $squash: true } },
      };
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the squash write admission only

      const { message: squashMessage, dataStream: squashDataStream } = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : definition.module,
        modulePath : 'patch',
        schema     : 'patch',
        dataFormat : 'text/plain',
        squash     : true,
      });
      expect((await dwn.processMessage(alice.did, squashMessage, { dataStream: squashDataStream })).status.code).toBe(202);

      snapshot('live: squash backstop');
    }

    // ---- scenario: live dataless update of an above-threshold record ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const largeData = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
      const { message: largeMessage, dataStream: largeDataStream, recordsWrite: largeWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'foo', schema: 'foo', dataFormat: 'text/plain', data: largeData,
      });
      expect((await dwn.processMessage(alice.did, largeMessage, { dataStream: largeDataStream })).status.code).toBe(202);

      const datalessUpdate = await RecordsWrite.createFrom({
        recordsWriteMessage : largeWrite.message,
        signer              : Jws.createSigner(alice),
        published           : true,
        datePublished       : Time.getCurrentTimestamp(),
      });
      expect((await dwn.processMessage(alice.did, datalessUpdate.message)).status.code).toBe(202);

      snapshot('live: dataless update of above-threshold record');
    }

    // ---- scenario: replicated child admitted under a dataless parent ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated applies only

      const { message: parentMessage, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.applyReplicatedMessage(alice.did, parentMessage)).kind).toBe('Applied');

      const { message: childMessage, dataBytes: childDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : definition.module,
        modulePath      : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      const childResult = await dwn.applyReplicatedMessage(alice.did, childMessage, { dataStream: DataStream.fromBytes(childDataBytes!) });
      expect(childResult.kind).toBe('Applied');

      snapshot('replicated: child admitted under dataless parent');
    }

    // ---- scenario: replicated role-invoking write admitted under a dataless role record ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = friendRoleModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated applies only

      const { message: roleMessage } = await TestDataGenerator.generateRecordsWrite({
        author: alice, recipient: bob.did, module: definition.module, modulePath: 'friend',
      });
      expect((await dwn.applyReplicatedMessage(alice.did, roleMessage)).kind).toBe('Applied');

      const { message: chatMessage, dataBytes: chatDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author: bob, module: definition.module, modulePath: 'chat', moduleRole: 'friend',
      });
      const chatResult = await dwn.applyReplicatedMessage(alice.did, chatMessage, { dataStream: DataStream.fromBytes(chatDataBytes!) });
      expect(chatResult.kind).toBe('Applied');

      snapshot('replicated: role-invoking write admitted under dataless role record');
    }

    // ---- scenario: initial write accepted by timestamped module history through replication apply ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const moduleUri = 'http://config-history-closure.xyz';
      const v1Definition: ModuleDefinition = {
        module    : moduleUri,
        published : false,
        types     : { alpha: { schema: 'alpha', dataFormats: ['text/plain'] }, keeper: { schema: 'keeper', dataFormats: ['text/plain'] } },
        structure : { alpha: {}, keeper: {} },
      };
      const v2Definition: ModuleDefinition = {
        module    : moduleUri,
        published : false,
        types     : { keeper: { schema: 'keeper', dataFormats: ['text/plain'] } },
        structure : { keeper: {} },
      };

      const v1Timestamp = Time.createTimestamp({ year: 2024, month: 1, day: 1 });
      const writeTimestamp = Time.createTimestamp({ year: 2024, month: 6, day: 1 });
      const v2Timestamp = Time.createTimestamp({ year: 2025, month: 1, day: 1 });

      const { message: v1Message } = await TestDataGenerator.generateModulesConfigure({
        author: alice, moduleDefinition: v1Definition, messageTimestamp: v1Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v1Message)).status.code).toBe(202);
      const { message: v2Message } = await TestDataGenerator.generateModulesConfigure({
        author: alice, moduleDefinition: v2Definition, messageTimestamp: v2Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v2Message)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated apply only

      const { message: alphaMessage, dataBytes: alphaDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        module           : moduleUri,
        modulePath       : 'alpha',
        schema           : 'alpha',
        dataFormat       : 'text/plain',
        dateCreated      : writeTimestamp,
        messageTimestamp : writeTimestamp,
      });
      const alphaResult = await dwn.applyReplicatedMessage(alice.did, alphaMessage, { dataStream: DataStream.fromBytes(alphaDataBytes!) });
      expect(alphaResult.kind).toBe('Applied');

      snapshot('replicated: initial write accepted by timestamped config');
    }

    // ---- scenario: replicated completion of a dataless stub ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated applies only

      const { message: stubMessage, dataBytes: stubDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.applyReplicatedMessage(alice.did, stubMessage)).kind).toBe('Applied');

      // Same-CID replicated data completes the already-admitted ancestry record.
      const retryResult = await dwn.applyReplicatedMessage(alice.did, stubMessage, { dataStream: DataStream.fromBytes(stubDataBytes!) });
      expect(retryResult.kind).toBe('Applied');

      snapshot('replicated: same-CID completion of dataless stub');
    }

    // ---- scenario: replicated tombstone-beaten dataless update missing compacted data ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedModuleDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const largeData = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
      const { message: initialMessage, recordsWrite: initialWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'foo', schema: 'foo', dataFormat: 'text/plain', data: largeData,
      });
      expect(await dwn.applyReplicatedMessage(
        alice.did, initialMessage, { dataStream: DataStream.fromBytes(largeData) },
      )).toEqual(expect.objectContaining({ kind: 'Applied' }));

      const recordsDelete = await RecordsDelete.create({
        recordId : initialMessage.recordId,
        signer   : Jws.createSigner(alice),
      });
      expect(await dwn.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual(expect.objectContaining({ kind: 'Applied' }));
      recorder.clearRecordedReads(); // trace the beaten-write validation only

      await Time.minimalSleep();
      const datalessUpdate = await RecordsWrite.createFrom({
        recordsWriteMessage : initialWrite.message,
        signer              : Jws.createSigner(alice),
        published           : true,
        datePublished       : Time.getCurrentTimestamp(),
      });
      const datalessUpdateResult = await dwn.applyReplicatedMessage(alice.did, datalessUpdate.message);
      expect(datalessUpdateResult.kind).toBe('Incomplete');

      snapshot('replicated: tombstone-beaten dataless update missing compacted data');
    }

    // ---- retained parent ancestry and receiver-local prune classification ----
    for (const prune of [false, true]) {
      await clearStores();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedModuleDefinition;
      const configure = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
      const parent = await TestDataGenerator.generateRecordsWrite({
        author: alice, module: definition.module, modulePath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, parent.message, { dataStream: parent.dataStream })).status.code).toBe(202);
      const deletion = await RecordsDelete.create({ recordId: parent.message.recordId, prune, signer: Jws.createSigner(alice) });
      expect((await dwn.processMessage(alice.did, deletion.message)).status.code).toBe(202);
      const child = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : definition.module,
        modulePath      : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parent.message.contextId,
      });
      recorder.clearRecordedReads();
      const result = await dwn.applyReplicatedMessage(alice.did, child.message, { dataStream: child.dataStream });
      expect(result.kind).toBe(prune ? 'Superseded' : 'Applied');
      snapshot(`replicated: child of ${prune ? 'pruned' : 'soft-deleted'} parent`);
    }

    // ---- closure assertion: every recorded read is part of the validation reader surface ----
    for (const [scenario, reads] of Object.entries(trace)) {
      for (const read of reads) {
        const method = read.split(' ')[0];
        expect(
          VALIDATION_READER_METHODS.has(method),
          `validation read '${read}' in scenario '${scenario}' is outside the validation reader surface`
        ).toBe(true);
      }
    }

    // ---- regression artifact: the recorded trace must match the committed one ----
    if (process.env.REGENERATE_VALIDATION_READ_TRACE === 'true') {
      writeFileSync(TRACE_ARTIFACT_PATH, `${JSON.stringify(trace, undefined, 2)}\n`);
    }

    const expectedTrace = JSON.parse(readFileSync(TRACE_ARTIFACT_PATH, 'utf-8'));
    expect(trace).toEqual(expectedTrace);
  });
});
