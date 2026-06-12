import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { ProtocolDefinition } from '../../src/types/protocols-types.js';
import type { RecordingValidationStateReader } from '../../src/core/recording-validation-state-reader.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../../src/index.js';

import freeForAllProtocolDefinition from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import nestedProtocolDefinition from '../vectors/protocol-definitions/nested.json' with { type: 'json' };

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { DwnConstant } from '../../src/core/dwn-constant.js';
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
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Maps every `ValidationStateReader` method to its row in the read-set table
 * (sync replication-log design, "Invariant and the replay basis"). A validation read whose
 * method is missing here is a read outside the table — adding a new reader method requires
 * writing its row (compaction risk and strategy) first, and adding it to this map.
 */
const READ_SET_TABLE_ROW_BY_METHOD: Record<string, number> = {
  fetchInitialRecordsWrite       : 1,
  fetchInitialWrite              : 1,
  constructRecordChain           : 1,
  fetchParentRecord              : 3,
  hasMatchingRoleRecord          : 4,
  queryLatestRoleRecords         : 4,
  fetchGrant                     : 5,
  fetchOldestGrantRevocation     : 5,
  fetchNewestRecordsWrite        : 2,
  getGoverningTimestamp          : 6,
  fetchProtocolDefinition        : 6,
  countLatestRecordsAtScope      : 7,
  fetchLatestSquashRecordAtScope : 9,
  hasStoredData                  : 8,
};

const TRACE_ARTIFACT_PATH = new URL('./validation-read-trace.json', import.meta.url).pathname;

/**
 * Replay-basis closure: representative admissions run with a recording `ValidationStateReader`;
 * the test fails on any validation read outside the read-set table, and the recorded traces are
 * compared against the committed regression artifact (`validation-read-trace.json`).
 *
 * When validation reads legitimately change, regenerate the artifact deliberately:
 * `REGENERATE_VALIDATION_READ_TRACE=true bun test tests/core/validation-read-closure.spec.ts`
 * and review the diff — it is the read-set change you are shipping.
 */
describe('validation read closure', () => {
  let didResolver: DidResolver;
  let messageStore: MessageStore;
  let dataStore: DataStore;
  let resumableTaskStore: ResumableTaskStore;
  let stateIndex: StateIndex;
  let eventLog: EventLog;
  let dwn: Dwn;
  let recorder: RecordingValidationStateReader;

  beforeAll(async () => {
    didResolver = new UniversalResolver({ didResolvers: [DidKey] });

    const stores = TestStores.get();
    messageStore = stores.messageStore;
    dataStore = stores.dataStore;
    resumableTaskStore = stores.resumableTaskStore;
    stateIndex = stores.stateIndex;
    eventLog = TestEventLog.get();

    dwn = await Dwn.create({
      didResolver, messageStore, dataStore, stateIndex, eventLog, resumableTaskStore,
      instrumentValidationStateReader: (validationStateReader): RecordingValidationStateReader => {
        recorder = new RecordingReader(validationStateReader);
        return recorder;
      },
    });
  });

  afterAll(async () => {
    await dwn.close();
  });

  it('should perform no validation read outside the read-set table across representative admissions', async () => {
    const trace: Record<string, string[]> = {};

    const clearStores = async (): Promise<void> => {
      await messageStore.clear();
      await dataStore.clear();
      await stateIndex.clear();
      await resumableTaskStore.clear();
    };

    const snapshot = (scenario: string): void => {
      const reads = recorder.reads.map((read): string => read.method);
      trace[scenario] = [...new Set(reads)].sort();
      recorder.clearRecordedReads();
    };

    // ---- scenario: live protocol record lifecycle ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: parentMessage, dataStream: parentDataStream, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: definition.protocol, protocolPath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, parentMessage, { dataStream: parentDataStream })).status.code).toBe(202);

      const { message: childMessage, dataStream: childDataStream, recordsWrite: childWrite } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : definition.protocol,
        protocolPath    : 'foo/bar',
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

      snapshot('live: protocol record lifecycle');
    }

    // ---- scenario: live role-authorized write ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = friendRoleProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: roleMessage, dataStream: roleDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: alice, recipient: bob.did, protocol: definition.protocol, protocolPath: 'friend',
      });
      expect((await dwn.processMessage(alice.did, roleMessage, { dataStream: roleDataStream })).status.code).toBe(202);

      const { message: chatMessage, dataStream: chatDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: bob, protocol: definition.protocol, protocolPath: 'chat', protocolRole: 'friend',
      });
      expect((await dwn.processMessage(alice.did, chatMessage, { dataStream: chatDataStream })).status.code).toBe(202);

      snapshot('live: role-authorized write');
    }

    // ---- scenario: live composed protocol configure ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const baseDefinition: ProtocolDefinition = {
        protocol  : 'http://closure-composition-base.xyz',
        published : false,
        types     : {
          profile: { schema: 'profile', dataFormats: ['text/plain'] },
        },
        structure: {
          profile: {},
        },
      };
      const composedDefinition: ProtocolDefinition = {
        protocol  : 'http://closure-composition-composed.xyz',
        published : false,
        uses      : {
          base: baseDefinition.protocol,
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
      const { message: baseConfigureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : baseDefinition,
      });
      expect((await dwn.processMessage(alice.did, baseConfigureMessage)).status.code).toBe(202);

      const { message: composedConfigureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : composedDefinition,
      });
      expect((await dwn.processMessage(alice.did, composedConfigureMessage)).status.code).toBe(202);

      snapshot('live: composed protocol configure');
    }

    // ---- scenario: live grant-authorized write ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = freeForAllProtocolDefinition as ProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: grantMessage, dataStream: grantDataStream, recordsWrite: grantWrite } = await TestDataGenerator.generateGrantCreate({
        author    : alice,
        grantedTo : bob,
        scope     : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : definition.protocol,
        },
      });
      expect((await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream })).status.code).toBe(202);

      const { message: grantedWriteMessage, dataStream: grantedWriteDataStream } = await TestDataGenerator.generateRecordsWrite({
        author            : bob,
        protocol          : definition.protocol,
        protocolPath      : 'post',
        schema            : definition.types.post.schema,
        dataFormat        : definition.types.post.dataFormats![0],
        permissionGrantId : grantWrite.message.recordId,
      });
      expect((await dwn.processMessage(alice.did, grantedWriteMessage, { dataStream: grantedWriteDataStream })).status.code).toBe(202);

      snapshot('live: grant-authorized write');
    }

    // ---- scenario: live Messages.Read of a RecordsDelete with a protocol grant ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = freeForAllProtocolDefinition as ProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: recordMessage, dataStream: recordDataStream } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : definition.protocol,
        protocolPath : 'post',
        schema       : definition.types.post.schema,
        dataFormat   : definition.types.post.dataFormats![0],
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
          protocol  : definition.protocol,
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

    // ---- scenario: live record-limit rejection ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition: ProtocolDefinition = {
        protocol  : 'http://record-limit-closure.xyz',
        published : false,
        types     : { item: { schema: 'item', dataFormats: ['text/plain'] } },
        structure : { item: { $recordLimit: { max: 1, strategy: 'reject' } } },
      };
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const { message: firstMessage, dataStream: firstDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: definition.protocol, protocolPath: 'item', schema: 'item', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, firstMessage, { dataStream: firstDataStream })).status.code).toBe(202);

      const { message: secondMessage, dataStream: secondDataStream } = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: definition.protocol, protocolPath: 'item', schema: 'item', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, secondMessage, { dataStream: secondDataStream })).status.code).toBe(400);

      snapshot('live: record-limit rejection');
    }

    // ---- scenario: live squash backstop ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition: ProtocolDefinition = {
        protocol  : 'http://squash-closure.xyz',
        published : false,
        types     : { patch: { schema: 'patch', dataFormats: ['text/plain'] } },
        structure : { patch: { $squash: true } },
      };
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the squash write admission only

      const { message: squashMessage, dataStream: squashDataStream } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : definition.protocol,
        protocolPath : 'patch',
        schema       : 'patch',
        dataFormat   : 'text/plain',
        squash       : true,
      });
      expect((await dwn.processMessage(alice.did, squashMessage, { dataStream: squashDataStream })).status.code).toBe(202);

      snapshot('live: squash backstop');
    }

    // ---- scenario: live dataless update of an above-threshold record ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const largeData = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
      const { message: largeMessage, dataStream: largeDataStream, recordsWrite: largeWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: definition.protocol, protocolPath: 'foo', schema: 'foo', dataFormat: 'text/plain', data: largeData,
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

    // ---- scenario: replicated child admitted under a dataless parent (row 3) ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated applies only

      const { message: parentMessage, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: definition.protocol, protocolPath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.applyReplicatedMessage(alice.did, parentMessage)).kind).toBe('Applied');

      const { message: childMessage, dataBytes: childDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : definition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      const childResult = await dwn.applyReplicatedMessage(alice.did, childMessage, { dataStream: DataStream.fromBytes(childDataBytes!) });
      expect(childResult.kind).toBe('Applied');

      snapshot('replicated: child admitted under dataless parent');
    }

    // ---- scenario: replicated role-invoking write admitted under a dataless role record (row 4) ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const definition = friendRoleProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated applies only

      const { message: roleMessage } = await TestDataGenerator.generateRecordsWrite({
        author: alice, recipient: bob.did, protocol: definition.protocol, protocolPath: 'friend',
      });
      expect((await dwn.applyReplicatedMessage(alice.did, roleMessage)).kind).toBe('Applied');

      const { message: chatMessage, dataBytes: chatDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author: bob, protocol: definition.protocol, protocolPath: 'chat', protocolRole: 'friend',
      });
      const chatResult = await dwn.applyReplicatedMessage(alice.did, chatMessage, { dataStream: DataStream.fromBytes(chatDataBytes!) });
      expect(chatResult.kind).toBe('Applied');

      snapshot('replicated: role-invoking write admitted under dataless role record');
    }

    // ---- scenario: initial write rejected by the latest config through replication apply (row 6) ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocolUri = 'http://config-history-closure.xyz';
      const v1Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : { alpha: { schema: 'alpha', dataFormats: ['text/plain'] }, keeper: { schema: 'keeper', dataFormats: ['text/plain'] } },
        structure : { alpha: {}, keeper: {} },
      };
      const v2Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : { keeper: { schema: 'keeper', dataFormats: ['text/plain'] } },
        structure : { keeper: {} },
      };

      const v1Timestamp = Time.createTimestamp({ year: 2024, month: 1, day: 1 });
      const writeTimestamp = Time.createTimestamp({ year: 2024, month: 6, day: 1 });
      const v2Timestamp = Time.createTimestamp({ year: 2025, month: 1, day: 1 });

      const { message: v1Message } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice, protocolDefinition: v1Definition, messageTimestamp: v1Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v1Message)).status.code).toBe(202);
      const { message: v2Message } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice, protocolDefinition: v2Definition, messageTimestamp: v2Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v2Message)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated apply only

      const { message: alphaMessage, dataBytes: alphaDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'alpha',
        schema           : 'alpha',
        dataFormat       : 'text/plain',
        dateCreated      : writeTimestamp,
        messageTimestamp : writeTimestamp,
      });
      const alphaResult = await dwn.applyReplicatedMessage(alice.did, alphaMessage, { dataStream: DataStream.fromBytes(alphaDataBytes!) });
      expect(alphaResult.kind).toBe('Invalid');

      snapshot('replicated: initial write rejected by latest config');
    }

    // ---- scenario: replicated completion of a dataless stub (row 8) ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);
      recorder.clearRecordedReads(); // trace the replicated applies only

      const { message: stubMessage, dataBytes: stubDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: definition.protocol, protocolPath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.applyReplicatedMessage(alice.did, stubMessage)).kind).toBe('Applied');

      // same-CID re-delivery with data completes the record instead of classifying as Duplicate
      const completionResult = await dwn.applyReplicatedMessage(alice.did, stubMessage, { dataStream: DataStream.fromBytes(stubDataBytes!) });
      expect(completionResult.kind).toBe('Applied');

      snapshot('replicated: same-CID completion of dataless stub');
    }

    // ---- scenario: replicated tombstone-beaten dataless update missing compacted data (row 8) ----
    {
      await clearStores();
      recorder.clearRecordedReads();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition: definition });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const largeData = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
      const { message: initialMessage, recordsWrite: initialWrite } = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: definition.protocol, protocolPath: 'foo', schema: 'foo', dataFormat: 'text/plain', data: largeData,
      });
      expect(await dwn.applyReplicatedMessage(
        alice.did, initialMessage, { dataStream: DataStream.fromBytes(largeData) },
      )).toEqual({ kind: 'Applied' });

      const recordsDelete = await RecordsDelete.create({
        recordId : initialMessage.recordId,
        signer   : Jws.createSigner(alice),
      });
      expect(await dwn.applyReplicatedMessage(alice.did, recordsDelete.message)).toEqual({ kind: 'Applied' });
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

    // ---- closure assertion: every recorded read maps to a read-set table row ----
    for (const [scenario, reads] of Object.entries(trace)) {
      for (const read of reads) {
        const method = read.split(' ')[0];
        expect(
          READ_SET_TABLE_ROW_BY_METHOD[method],
          `validation read '${read}' in scenario '${scenario}' is outside the read-set table`
        ).toBeDefined();
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
