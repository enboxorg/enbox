import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { ProtocolDefinition } from '../../src/types/protocols-types.js';
import type { RecordsQueryReply } from '../../src/types/records-types.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../../src/index.js';

import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import nestedProtocolDefinition from '../vectors/protocol-definitions/nested.json' with { type: 'json' };

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { Time } from '../../src/utils/time.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';

/**
 * The replicated-validation divergences (read-set table rows 3, 4, and 6): each test drives the
 * same message through both entry points and asserts the live path keeps its strict behavior
 * while the replicated path reconstructs the historical answer from retained material.
 */
describe('replicated validation divergences', () => {
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
    it('should admit a child of a dataless (ancestry-only) parent in replicated mode but not in live mode', async () => {
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

      const { message: childMessage, dataStream: childDataStream, dataBytes: childDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });

      // live mode: the latest-only parent query misses the ancestry-only parent
      const liveReply = await dwn.processMessage(alice.did, childMessage, { dataStream: childDataStream });
      expect(liveReply.status.code).toBe(400);
      expect(liveReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationParentRecordNotFound);

      // replicated mode: the parent's initial write verifies the immutable protocolPath/contextId facts
      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, childMessage, {
        dataStream: DataStream.fromBytes(childDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Applied');

      // the child is live and queryable
      const { message: queryMessage } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { recordId: childMessage.recordId },
      });
      const queryReply = await dwn.processMessage(alice.did, queryMessage) as RecordsQueryReply;
      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries?.length).toBe(1);
    });

    it('should reject a child of a tombstoned parent in both modes', async () => {
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

      // live mode rejects — the latest-only filter exists exactly to exclude deleted parents
      const liveReply = await dwn.processMessage(alice.did, childMessage, { dataStream: childDataStream });
      expect(liveReply.status.code).toBe(400);
      expect(liveReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationParentRecordNotFound);

      // replicated mode also rejects — the local tombstone blocks the initial-write fallback
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
    it('should authorize a role-invoking write against a dataless (ancestry-only) role record in replicated mode but not in live mode', async () => {
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

      const { message: chatMessage, dataStream: chatDataStream, dataBytes: chatDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author       : bob,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'chat',
        protocolRole : 'friend',
      });

      // live mode: the latest-only role query misses the ancestry-only role record
      const liveReply = await dwn.processMessage(alice.did, chatMessage, { dataStream: chatDataStream });
      expect(liveReply.status.code).toBe(401);
      expect(liveReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);

      // replicated mode: the initial-write role record matches the selector (filter-only facts)
      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, chatMessage, {
        dataStream: DataStream.fromBytes(chatDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Applied');
    });

    it('should reject a role-invoking write against a tombstoned role record in both modes', async () => {
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

      // live mode rejects
      const liveReply = await dwn.processMessage(alice.did, chatMessage, { dataStream: chatDataStream });
      expect(liveReply.status.code).toBe(401);
      expect(liveReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);

      // replicated mode also rejects — the local tombstone blocks the initial-write fallback
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
    it('should apply a replicated initial write authored before the earliest retained config (oldest-config fallback)', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      // the record is AUTHORED before the protocol is configured — admission order, not
      // timestamp order, governed the source, so replay must not classify the installed
      // protocol as a missing dependency
      const recordsWrite = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : nestedProtocolDefinition.protocol,
        protocolPath : 'foo',
        schema       : nestedProtocolDefinition.types.foo.schema,
        dataFormat   : nestedProtocolDefinition.types.foo.dataFormats[0],
      });

      const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : nestedProtocolDefinition as ProtocolDefinition,
      });
      expect((await dwn.processMessage(alice.did, protocolsConfigure.message)).status.code).toBe(202);

      const result = await dwn.applyReplicatedMessage(
        alice.did, recordsWrite.message, { dataStream: DataStream.fromBytes(recordsWrite.dataBytes!) },
      );
      expect(result).toEqual({ kind: 'Applied' });
    });

    it('should validate a replicated initial write against the historically-governing config while live mode uses the latest', async () => {
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

      // live mode validates an initial write against the latest definition (v2): `alpha` no longer exists
      const liveReply = await dwn.processMessage(alice.did, alphaMessage, { dataStream: alphaDataStream });
      expect(liveReply.status.code).toBe(400);
      expect(liveReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationInvalidType);

      // replicated mode selects the governing config by the message's own timestamp: v1 admits it
      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, alphaMessage, {
        dataStream: DataStream.fromBytes(alphaDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Applied');

      // the record is live and queryable
      const { message: queryMessage } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { recordId: alphaMessage.recordId },
      });
      const queryReply = await dwn.processMessage(alice.did, queryMessage) as RecordsQueryReply;
      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries?.length).toBe(1);
    });
  });
});
