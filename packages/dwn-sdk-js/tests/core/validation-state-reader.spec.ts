import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { ProtocolDefinition } from '../../src/types/protocols-types.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../../src/index.js';

import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import nestedProtocolDefinition from '../vectors/protocol-definitions/nested.json' with { type: 'json' };

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { Time } from '../../src/utils/time.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';

/**
 * Validation-state reader parity: replicated apply returns structured repair outcomes, but it
 * must not admit messages through a weaker validation basis than `processMessage()`.
 */
describe('validation-state reader admission parity', () => {
  let didResolver: DidResolver;
  let messageStore: MessageStore;
  let dataStore: DataStore;
  let resumableTaskStore: ResumableTaskStore;
  let stateIndex: StateIndex;
  let eventLog: EventLog;
  let dwn: Dwn;

  beforeAll(async () => {
    didResolver = new UniversalResolver({ didResolvers: [DidKey] });

    const stores = TestStores.get();
    messageStore = stores.messageStore;
    dataStore = stores.dataStore;
    resumableTaskStore = stores.resumableTaskStore;
    stateIndex = stores.stateIndex;
    eventLog = TestEventLog.get();

    dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, eventLog, resumableTaskStore });
  });

  beforeEach(async () => {
    await messageStore.clear();
    await dataStore.clear();
    await stateIndex.clear();
    await resumableTaskStore.clear();
  });

  afterAll(async () => {
    await dwn.close();
  });

  describe('row 3 — parent existence', () => {
    it('should admit a child of a dataless parent through processMessage and replication apply', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolDefinition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const configureReply = await dwn.processMessage(alice.did, configureMessage);
      expect(configureReply.status.code).toBe(202);

      // the parent replays dataless — a data-compacted parent is ancestry-only mid-replay
      const { message: parentMessage, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'foo',
        schema       : 'foo',
        dataFormat   : 'text/plain',
      });
      const parentResult = await dwn.applyReplicatedMessage(alice.did, parentMessage);
      expect(parentResult.kind).toBe('Applied'); // stored as non-queryable initial state (204)

      const { message: processChildMessage, dataStream: processChildDataStream } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });

      const processReply = await dwn.processMessage(alice.did, processChildMessage, { dataStream: processChildDataStream });
      expect(processReply.status.code).toBe(202);

      const { message: replicatedChildMessage, dataBytes: replicatedChildDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });

      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, replicatedChildMessage, {
        dataStream: DataStream.fromBytes(replicatedChildDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Applied');
    });

    it('should continue to admit a child after the same dataless parent is completed with data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolDefinition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const configureReply = await dwn.processMessage(alice.did, configureMessage);
      expect(configureReply.status.code).toBe(202);

      const { message: parentMessage, recordsWrite: parentWrite, dataBytes: parentDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'foo',
        schema       : 'foo',
        dataFormat   : 'text/plain',
      });
      const datalessParentReply = await dwn.processMessage(alice.did, parentMessage);
      expect(datalessParentReply.status.code).toBe(204);

      const { message: childBeforeCompletionMessage, dataStream: childBeforeCompletionDataStream } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      const childBeforeCompletionReply = await dwn.processMessage(alice.did, childBeforeCompletionMessage, {
        dataStream: childBeforeCompletionDataStream,
      });
      expect(childBeforeCompletionReply.status.code).toBe(202);

      // Same-CID delivery with data flips the parent from retained ancestry to latest/queryable state.
      const completedParentReply = await dwn.processMessage(alice.did, parentMessage, {
        dataStream: DataStream.fromBytes(parentDataBytes!),
      });
      expect(completedParentReply.status.code).toBe(202);

      const { message: childAfterCompletionMessage, dataStream: childAfterCompletionDataStream } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      const childAfterCompletionReply = await dwn.processMessage(alice.did, childAfterCompletionMessage, {
        dataStream: childAfterCompletionDataStream,
      });
      expect(childAfterCompletionReply.status.code).toBe(202);
    });

    it('should admit a child after a parent update because immutable parent facts are unchanged', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolDefinition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const configureReply = await dwn.processMessage(alice.did, configureMessage);
      expect(configureReply.status.code).toBe(202);

      const { message: parentMessage, dataStream: parentDataStream, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'foo',
        schema       : 'foo',
        dataFormat   : 'text/plain',
      });
      const parentReply = await dwn.processMessage(alice.did, parentMessage, { dataStream: parentDataStream });
      expect(parentReply.status.code).toBe(202);

      const parentUpdate = await RecordsWrite.createFrom({
        recordsWriteMessage : parentMessage,
        published           : true,
        signer              : Jws.createSigner(alice),
      });
      const parentUpdateReply = await dwn.processMessage(alice.did, parentUpdate.message);
      expect(parentUpdateReply.status.code).toBe(202);

      const { message: childMessage, dataStream: childDataStream } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      const childReply = await dwn.processMessage(alice.did, childMessage, { dataStream: childDataStream });
      expect(childReply.status.code).toBe(202);
    });

    it('should reject a child of a tombstoned parent through processMessage and replication apply', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolDefinition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const configureReply = await dwn.processMessage(alice.did, configureMessage);
      expect(configureReply.status.code).toBe(202);

      // parent is written with data, then deleted — its initial write is retained beside the tombstone
      const { message: parentMessage, dataStream: parentDataStream, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'foo',
        schema       : 'foo',
        dataFormat   : 'text/plain',
      });
      const parentReply = await dwn.processMessage(alice.did, parentMessage, { dataStream: parentDataStream });
      expect(parentReply.status.code).toBe(202);

      const { message: deleteMessage } = await TestDataGenerator.generateRecordsDelete({
        author   : alice,
        recordId : parentMessage.recordId,
      });
      const deleteReply = await dwn.processMessage(alice.did, deleteMessage);
      expect(deleteReply.status.code).toBe(202);

      const { message: childMessage, dataStream: childDataStream, dataBytes: childDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });

      // processMessage rejects — the latest-only filter exists exactly to exclude deleted parents
      const processReply = await dwn.processMessage(alice.did, childMessage, { dataStream: childDataStream });
      expect(processReply.status.code).toBe(400);
      expect(processReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationParentRecordNotFound);

      // applyReplicatedMessage uses the same admission rule
      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, childMessage, {
        dataStream: DataStream.fromBytes(childDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Incomplete');
      if (replicatedResult.kind === 'Incomplete') {
        expect(replicatedResult.missing[0].type).toBe('Parent');
      }
    });
  });

  describe('row 4 — role records', () => {
    it('should authorize a role-invoking write against a dataless role record through processMessage and replication apply', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const protocolDefinition = friendRoleProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const configureReply = await dwn.processMessage(alice.did, configureMessage);
      expect(configureReply.status.code).toBe(202);

      // the role record replays dataless — an above-threshold role record is ancestry-only mid-replay
      const { message: roleMessage } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        recipient    : bob.did,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'friend',
      });
      const roleResult = await dwn.applyReplicatedMessage(alice.did, roleMessage);
      expect(roleResult.kind).toBe('Applied'); // stored as non-queryable initial state (204)

      const { message: processChatMessage, dataStream: processChatDataStream } = await TestDataGenerator.generateRecordsWrite({
        author       : bob,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'chat',
        protocolRole : 'friend',
      });

      const processReply = await dwn.processMessage(alice.did, processChatMessage, { dataStream: processChatDataStream });
      expect(processReply.status.code).toBe(202);

      const { message: replicatedChatMessage, dataBytes: replicatedChatDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author       : bob,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'chat',
        protocolRole : 'friend',
      });

      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, replicatedChatMessage, {
        dataStream: DataStream.fromBytes(replicatedChatDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Applied');
    });

    it('should reject a role-invoking write against a tombstoned role record through processMessage and replication apply', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const protocolDefinition = friendRoleProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const configureReply = await dwn.processMessage(alice.did, configureMessage);
      expect(configureReply.status.code).toBe(202);

      const { message: roleMessage, dataStream: roleDataStream } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        recipient    : bob.did,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'friend',
      });
      const roleReply = await dwn.processMessage(alice.did, roleMessage, { dataStream: roleDataStream });
      expect(roleReply.status.code).toBe(202);

      const { message: deleteMessage } = await TestDataGenerator.generateRecordsDelete({
        author   : alice,
        recordId : roleMessage.recordId,
      });
      const deleteReply = await dwn.processMessage(alice.did, deleteMessage);
      expect(deleteReply.status.code).toBe(202);

      const { message: chatMessage, dataStream: chatDataStream, dataBytes: chatDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author       : bob,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'chat',
        protocolRole : 'friend',
      });

      // processMessage rejects
      const processReply = await dwn.processMessage(alice.did, chatMessage, { dataStream: chatDataStream });
      expect(processReply.status.code).toBe(401);
      expect(processReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);

      // applyReplicatedMessage uses the same admission rule
      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, chatMessage, {
        dataStream: DataStream.fromBytes(chatDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Incomplete');
      if (replicatedResult.kind === 'Incomplete') {
        expect(replicatedResult.missing[0].type).toBe('Role');
      }
    });
  });

  describe('row 6 — protocol definition history', () => {
    it('should reject initial writes using the latest config in both entry points', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolUri = 'http://earliest-retained-config.xyz';
      const v1Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : {
          foo : { schema: 'foo', dataFormats: ['text/plain'] },
          bar : { schema: 'bar', dataFormats: ['text/plain'] },
        },
        structure: {
          foo : {},
          bar : {},
        },
      };
      const v2Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : {
          bar: { schema: 'bar', dataFormats: ['text/plain'] },
        },
        structure: {
          bar: {},
        },
      };
      const writeTimestamp = Time.createTimestamp({ year: 2023, month: 1, day: 1 });
      const v1Timestamp = Time.createTimestamp({ year: 2024, month: 1, day: 1 });
      const v2Timestamp = Time.createTimestamp({ year: 2025, month: 1, day: 1 });

      const recordsWrite = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'foo',
        schema           : 'foo',
        dataFormat       : 'text/plain',
        dateCreated      : writeTimestamp,
        messageTimestamp : writeTimestamp,
      });

      const v1Configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : v1Definition,
        messageTimestamp   : v1Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v1Configure.message)).status.code).toBe(202);

      const v2Configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : v2Definition,
        messageTimestamp   : v2Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v2Configure.message)).status.code).toBe(202);

      const processReply = await dwn.processMessage(
        alice.did, recordsWrite.message, { dataStream: recordsWrite.dataStream },
      );
      expect(processReply.status.code).toBe(400);
      expect(processReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationInvalidType);

      const result = await dwn.applyReplicatedMessage(
        alice.did, recordsWrite.message, { dataStream: DataStream.fromBytes(recordsWrite.dataBytes!) },
      );
      expect(result.kind).toBe('Invalid');
      if (result.kind === 'Invalid') {
        expect(result.reason).toContain(DwnErrorCode.ProtocolAuthorizationInvalidType);
      }
    });

    it('should report a missing initial write through standard admission before replication maps it to incomplete', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocolDefinition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      const initialWrite = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'foo',
        schema       : 'foo',
        dataFormat   : 'text/plain',
      });
      const update = await TestDataGenerator.generateFromRecordsWrite({
        author        : alice,
        existingWrite : initialWrite.recordsWrite,
      });

      const processReply = await dwn.processMessage(
        alice.did, update.message, { dataStream: DataStream.fromBytes(update.dataBytes!) },
      );
      expect(processReply.status.code).toBe(400);
      expect(processReply.status.detail).toContain(DwnErrorCode.RecordsWriteGetInitialWriteNotFound);

      const result = await dwn.applyReplicatedMessage(
        alice.did, update.message, { dataStream: DataStream.fromBytes(update.dataBytes!) },
      );

      expect(result).toEqual({
        kind    : 'Incomplete',
        missing : [{
          type     : 'InitialWrite',
          recordId : update.message.recordId,
          protocol : protocolDefinition.protocol,
        }],
      });
    });

    it('should validate replicated ProtocolsConfigure composition against current referenced configs', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const baseProtocolUri = 'http://historical-composition-base.xyz';
      const composedProtocolUri = 'http://historical-composition-composed.xyz';
      const v1Timestamp = Time.createTimestamp({ year: 2024, month: 1, day: 1 });
      const composedTimestamp = Time.createTimestamp({ year: 2024, month: 6, day: 1 });
      const v2Timestamp = Time.createTimestamp({ year: 2025, month: 1, day: 1 });
      const baseV1Definition: ProtocolDefinition = {
        protocol  : baseProtocolUri,
        published : false,
        types     : {
          profile : { schema: 'profile', dataFormats: ['text/plain'] },
          keeper  : { schema: 'keeper', dataFormats: ['text/plain'] },
        },
        structure: {
          profile : {},
          keeper  : {},
        },
      };
      const baseV2Definition: ProtocolDefinition = {
        protocol  : baseProtocolUri,
        published : false,
        types     : {
          keeper: { schema: 'keeper', dataFormats: ['text/plain'] },
        },
        structure: {
          keeper: {},
        },
      };
      const composedDefinition: ProtocolDefinition = {
        protocol  : composedProtocolUri,
        published : false,
        uses      : {
          base: baseProtocolUri,
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

      const baseV1Configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : baseV1Definition,
        messageTimestamp   : v1Timestamp,
      });
      expect((await dwn.processMessage(alice.did, baseV1Configure.message)).status.code).toBe(202);

      const baseV2Configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : baseV2Definition,
        messageTimestamp   : v2Timestamp,
      });
      expect((await dwn.processMessage(alice.did, baseV2Configure.message)).status.code).toBe(202);

      const composedConfigure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : composedDefinition,
        messageTimestamp   : composedTimestamp,
      });

      const processReply = await dwn.processMessage(alice.did, composedConfigure.message);
      expect(processReply.status.code).toBe(400);
      expect(processReply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefProtocolPath);

      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, composedConfigure.message);
      expect(replicatedResult.kind).toBe('Invalid');
      if (replicatedResult.kind === 'Invalid') {
        expect(replicatedResult.reason).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefProtocolPath);
      }
    });

    it('should derive missing cross-protocol role dependencies from the governing config', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const roleProtocolV1Uri = 'http://role-context-v1.xyz';
      const roleProtocolV2Uri = 'http://role-context-v2.xyz';
      const composedProtocolUri = 'http://role-context-composed.xyz';
      const v1Timestamp = Time.createTimestamp({ year: 2024, month: 1, day: 1 });
      const initialTimestamp = Time.createTimestamp({ year: 2024, month: 6, day: 1 });
      const v2Timestamp = Time.createTimestamp({ year: 2025, month: 1, day: 1 });
      const updateTimestamp = Time.createTimestamp({ year: 2025, month: 6, day: 1 });

      const roleProtocolV1: ProtocolDefinition = {
        protocol  : roleProtocolV1Uri,
        published : false,
        types     : {
          participant: {},
        },
        structure: {
          participant: {
            $role: true,
          },
        },
      };
      const roleProtocolV2: ProtocolDefinition = {
        protocol  : roleProtocolV2Uri,
        published : false,
        types     : {
          participant: {},
        },
        structure: {
          participant: {
            $role: true,
          },
        },
      };
      const composedV1: ProtocolDefinition = {
        protocol  : composedProtocolUri,
        published : false,
        uses      : {
          roles: roleProtocolV1Uri,
        },
        types: {
          comment: { schema: 'comment', dataFormats: ['text/plain'] },
        },
        structure: {
          comment: {
            $actions: [
              { who: 'anyone', can: ['create'] },
              { role: 'roles:participant', can: ['co-update'] },
            ],
          },
        },
      };
      const composedV2: ProtocolDefinition = {
        ...composedV1,
        uses: {
          roles: roleProtocolV2Uri,
        },
      };

      for (const protocolDefinition of [roleProtocolV1, roleProtocolV2]) {
        const configure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
        expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
      }

      const composedV1Configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : composedV1,
        messageTimestamp   : v1Timestamp,
      });
      expect((await dwn.processMessage(alice.did, composedV1Configure.message)).status.code).toBe(202);

      const initialComment = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : composedProtocolUri,
        protocolPath     : 'comment',
        schema           : 'comment',
        dataFormat       : 'text/plain',
        dateCreated      : initialTimestamp,
        messageTimestamp : initialTimestamp,
      });
      expect(await dwn.applyReplicatedMessage(
        alice.did,
        initialComment.message,
        { dataStream: DataStream.fromBytes(initialComment.dataBytes!) },
      )).toEqual({ kind: 'Applied' });

      const composedV2Configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : composedV2,
        messageTimestamp   : v2Timestamp,
      });
      expect((await dwn.processMessage(alice.did, composedV2Configure.message)).status.code).toBe(202);

      const update = await TestDataGenerator.generateFromRecordsWrite({
        author           : bob,
        existingWrite    : initialComment.recordsWrite,
        protocolRole     : 'roles:participant',
        messageTimestamp : updateTimestamp,
      });

      const result = await dwn.applyReplicatedMessage(
        alice.did, update.message, { dataStream: update.dataStream },
      );

      expect(result).toEqual({
        kind    : 'Incomplete',
        missing : [{
          type         : 'Role',
          protocol     : roleProtocolV1Uri,
          protocolPath : 'participant',
          recipient    : bob.did,
        }],
      });
    });

    it('should not validate initial writes against a backdated config in either entry point', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolUri = 'http://config-history.xyz';
      const v1Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : {
          alpha  : { schema: 'alpha', dataFormats: ['text/plain'] },
          keeper : { schema: 'keeper', dataFormats: ['text/plain'] },
        },
        structure: {
          alpha  : {},
          keeper : {},
        },
      };

      // v2 removes the `alpha` type entirely
      const v2Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : {
          keeper: { schema: 'keeper', dataFormats: ['text/plain'] },
        },
        structure: {
          keeper: {},
        },
      };

      const v1Timestamp = Time.createTimestamp({ year: 2024, month: 1, day: 1 });
      const writeTimestamp = Time.createTimestamp({ year: 2024, month: 6, day: 1 });
      const v2Timestamp = Time.createTimestamp({ year: 2025, month: 1, day: 1 });

      const { message: v1Message } = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : v1Definition,
        messageTimestamp   : v1Timestamp,
      });
      const v1Reply = await dwn.processMessage(alice.did, v1Message);
      expect(v1Reply.status.code).toBe(202);

      const { message: v2Message } = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : v2Definition,
        messageTimestamp   : v2Timestamp,
      });
      const v2Reply = await dwn.processMessage(alice.did, v2Message);
      expect(v2Reply.status.code).toBe(202);

      // an initial write authored between v1 and v2, arriving after v2 superseded v1
      const { message: alphaMessage, dataStream: alphaDataStream, dataBytes: alphaDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'alpha',
        schema           : 'alpha',
        dataFormat       : 'text/plain',
        dateCreated      : writeTimestamp,
        messageTimestamp : writeTimestamp,
      });

      // processMessage validates an initial write against the latest definition (v2): `alpha` no longer exists
      const processReply = await dwn.processMessage(alice.did, alphaMessage, { dataStream: alphaDataStream });
      expect(processReply.status.code).toBe(400);
      expect(processReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationInvalidType);

      // applyReplicatedMessage uses the same latest-config admission rule
      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, alphaMessage, {
        dataStream: DataStream.fromBytes(alphaDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Invalid');
      if (replicatedResult.kind === 'Invalid') {
        expect(replicatedResult.reason).toContain(DwnErrorCode.ProtocolAuthorizationInvalidType);
      }
    });

    it('should not enforce squash backstop from a backdated config in either entry point', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolUri = 'http://config-history-squash.xyz';
      const v1Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : {
          patch: { schema: 'patch', dataFormats: ['text/plain'] },
        },
        structure: {
          patch: { $squash: true },
        },
      };
      const v2Definition: ProtocolDefinition = {
        protocol  : protocolUri,
        published : false,
        types     : {
          patch: { schema: 'patch', dataFormats: ['text/plain'] },
        },
        structure: {
          patch: {},
        },
      };

      const v1Timestamp = Time.createTimestamp({ year: 2024, month: 1, day: 1 });
      const olderPatchTimestamp = Time.createTimestamp({ year: 2024, month: 2, day: 1 });
      const squashTimestamp = Time.createTimestamp({ year: 2024, month: 3, day: 1 });
      const v2Timestamp = Time.createTimestamp({ year: 2024, month: 4, day: 1 });

      const { message: v1Message } = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : v1Definition,
        messageTimestamp   : v1Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v1Message)).status.code).toBe(202);

      const squashRecord = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'patch',
        schema           : 'patch',
        dataFormat       : 'text/plain',
        dateCreated      : squashTimestamp,
        messageTimestamp : squashTimestamp,
        squash           : true,
      });
      expect((await dwn.processMessage(alice.did, squashRecord.message, { dataStream: squashRecord.dataStream })).status.code).toBe(202);

      const { message: v2Message } = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : v2Definition,
        messageTimestamp   : v2Timestamp,
      });
      expect((await dwn.processMessage(alice.did, v2Message)).status.code).toBe(202);

      const processOlderPatch = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'patch',
        schema           : 'patch',
        dataFormat       : 'text/plain',
        dateCreated      : olderPatchTimestamp,
        messageTimestamp : olderPatchTimestamp,
      });

      const processReply = await dwn.processMessage(alice.did, processOlderPatch.message, {
        dataStream: processOlderPatch.dataStream,
      });
      expect(processReply.status.code).toBe(202);

      const olderPatch = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'patch',
        schema           : 'patch',
        dataFormat       : 'text/plain',
        dateCreated      : olderPatchTimestamp,
        messageTimestamp : olderPatchTimestamp,
      });

      const result = await dwn.applyReplicatedMessage(alice.did, olderPatch.message, {
        dataStream: DataStream.fromBytes(olderPatch.dataBytes!),
      });
      expect(result).toEqual({ kind: 'Applied' });
    });
  });
});
