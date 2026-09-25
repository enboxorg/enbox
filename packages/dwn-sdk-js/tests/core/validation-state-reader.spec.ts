import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { Filter } from '../../src/types/query-types.js';
import type { GenericMessage } from '../../src/types/message-types.js';
import type { ProtocolDefinition } from '../../src/types/protocols-types.js';
import type { RecordsWriteMessage } from '../../src/types/records-types.js';
import type { ValidationStateReader } from '../../src/types/validation-state-reader.js';
import type { DataStore, MessageStore, ResumableTaskStore } from '../../src/index.js';

import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import nestedProtocolDefinition from '../vectors/protocol-definitions/nested.json' with { type: 'json' };

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH } from '../../src/core/constants.js';
import { Jws } from '../../src/utils/jws.js';
import { RecordingValidationStateReader } from '../../src/core/recording-validation-state-reader.js';
import { RecordsDelete } from '../../src/interfaces/records-delete.js';
import { RecordsQuery } from '../../src/interfaces/records-query.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { RecordsWrite } from '../../src/interfaces/records-write.js';
import { StoreValidationStateReader } from '../../src/core/validation-state-reader.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { Time } from '../../src/utils/time.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';

/**
 * Validation-state reader parity: replicated apply returns structured repair outcomes, but it
 * must not admit messages through a weaker validation basis than `processMessage()`.
 */
describe('validation-state reader admission parity', () => {
  let didResolver: DidResolver;
  let messageStore: MessageStore;
  let dataStore: DataStore;
  let resumableTaskStore: ResumableTaskStore;
  let eventLog: EventLog;
  let dwn: Dwn;

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
    await messageStore.clear();
    await dataStore.clear();
    await resumableTaskStore.clear();
  });

  afterAll(async () => {
    await dwn.close();
  });

  describe('parent existence', () => {
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

    it('should continue to admit a child after same-CID data completion', async () => {
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

      const { message: childBeforeRetryMessage, dataStream: childBeforeRetryDataStream } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      const childBeforeRetryReply = await dwn.processMessage(alice.did, childBeforeRetryMessage, {
        dataStream: childBeforeRetryDataStream,
      });
      expect(childBeforeRetryReply.status.code).toBe(202);

      // The exact signed write can supply its missing body without repeating mutable admission.
      const retriedParentReply = await dwn.processMessage(alice.did, parentMessage, {
        dataStream: DataStream.fromBytes(parentDataBytes!),
      });
      expect(retriedParentReply.status.code).toBe(202);

      const { message: childAfterRetryMessage, dataStream: childAfterRetryDataStream } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parentWrite.message.contextId,
      });
      const childAfterRetryReply = await dwn.processMessage(alice.did, childAfterRetryMessage, {
        dataStream: childAfterRetryDataStream,
      });
      expect(childAfterRetryReply.status.code).toBe(202);
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

      const reader = new StoreValidationStateReader({ messageStore, dataStore });
      const retainedParent = await reader.fetchParentRecord({
        tenant: alice.did, parentProtocolUri: protocolDefinition.protocol, parentId: parentMessage.recordId,
      });
      expect(retainedParent?.descriptor).toEqual(parentMessage.descriptor);

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

    it('should reject a child of a pruned parent through processMessage and replication apply', async () => {
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

      const { message: deleteMessage } = await RecordsDelete.create({
        signer   : Jws.createSigner(alice),
        recordId : parentMessage.recordId,
        prune    : true,
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

      // processMessage rejects with the same generic missing-parent code as a not-yet-seen parent
      const processReply = await dwn.processMessage(alice.did, childMessage, { dataStream: childDataStream });
      expect(processReply.status.code).toBe(400);
      expect(processReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationParentRecordNotFound);

      // The receiver can see the local tombstone, so it classifies the terminal failure as Invalid
      // rather than an Incomplete dependency that could be retried forever.
      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, childMessage, {
        dataStream: DataStream.fromBytes(childDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Superseded');
    });

    for (const prune of [false, true]) {
      it(`should converge parent/child/delete arrival orders with prune=${prune}`, async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocolDefinition = nestedProtocolDefinition;
        const configure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
        const parent = await TestDataGenerator.generateRecordsWrite({
          author: alice, protocol: protocolDefinition.protocol, protocolPath: 'foo', schema: 'foo', dataFormat: 'text/plain',
        });
        const child = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : protocolDefinition.protocol,
          protocolPath    : 'foo/bar',
          schema          : 'bar',
          dataFormat      : 'text/plain',
          parentContextId : parent.message.contextId,
        });
        const deletion = await RecordsDelete.create({ signer: Jws.createSigner(alice), recordId: parent.message.recordId, prune });
        const deliveries = [parent, child, deletion];
        // Each replica receives the exact same signed messages; only delivery order changes.
        const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        for (const order of orders) {
          await messageStore.clear();
          await dataStore.clear();
          await resumableTaskStore.clear();
          expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
          const pending: number[] = [];
          let parentPruned = false;
          for (const index of order) {
            const delivery = deliveries[index];
            const dataBytes = 'dataBytes' in delivery ? delivery.dataBytes : undefined;
            const result = await dwn.applyReplicatedMessage(alice.did, delivery.message, {
              dataStream: dataBytes === undefined ? undefined : DataStream.fromBytes(dataBytes),
            });
            if (result.kind === 'Incomplete') {
              pending.push(index);
            } else {
              expect(result.kind).toBe(parentPruned && index === 1 ? 'Superseded' : 'Applied');
              if (prune && index === 2) {
                parentPruned = true;
              }
            }
          }
          // Repair the delete before retrying the child, once the retained parent is available.
          for (const index of pending.sort((a, b): number => b - a)) {
            const delivery = deliveries[index];
            const dataBytes = 'dataBytes' in delivery ? delivery.dataBytes : undefined;
            const result = await dwn.applyReplicatedMessage(alice.did, delivery.message, {
              dataStream: dataBytes === undefined ? undefined : DataStream.fromBytes(dataBytes),
            });
            expect(result.kind).toBe(prune && index === 1 ? 'Superseded' : 'Applied');
          }
          const readParent = await RecordsRead.create({ filter: { recordId: parent.message.recordId }, signer: Jws.createSigner(alice) });
          expect((await dwn.processMessage(alice.did, readParent.message)).status.code).toBe(404);
          const readChild = await RecordsRead.create({ filter: { recordId: child.message.recordId }, signer: Jws.createSigner(alice) });
          expect((await dwn.processMessage(alice.did, readChild.message)).status.code).toBe(prune ? 404 : 200);
          for (const filter of [
            { recordId: child.message.recordId },
            { protocol: protocolDefinition.protocol, protocolPath: 'foo/bar', contextId: child.message.contextId },
          ]) {
            const query = await RecordsQuery.create({ filter, signer: Jws.createSigner(alice) });
            const reply = await dwn.processMessage(alice.did, query.message);
            expect(reply.status.code).toBe(200);
            expect(reply.entries?.length).toBe(prune ? 0 : 1);
          }
          // Soft-deleted parents produce the same client-facing admission reply as live parents.
          const newChild = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'foo/bar',
            schema          : 'bar',
            dataFormat      : 'text/plain',
            parentContextId : parent.message.contextId,
          });
          const reply = await dwn.processMessage(alice.did, newChild.message, { dataStream: newChild.dataStream });
          expect(reply.status.code).toBe(prune ? 400 : 202);
          if (prune) {
            expect((await dwn.applyReplicatedMessage(alice.did, newChild.message)).kind).toBe('Superseded');
          }
        }
      });
    }

    it('should settle a late descendant of a pruned subtree without retrying it', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocolDefinition = nestedProtocolDefinition;
      const configure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
      expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
      const parent = await TestDataGenerator.generateRecordsWrite({
        author: alice, protocol: protocolDefinition.protocol, protocolPath: 'foo', schema: 'foo', dataFormat: 'text/plain',
      });
      expect((await dwn.processMessage(alice.did, parent.message, { dataStream: parent.dataStream })).status.code).toBe(202);
      const child = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : parent.message.contextId,
      });
      expect((await dwn.processMessage(alice.did, child.message, { dataStream: child.dataStream })).status.code).toBe(202);
      const deletion = await RecordsDelete.create({
        recordId : parent.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice),
      });
      expect((await dwn.processMessage(alice.did, deletion.message)).status.code).toBe(202);
      const grandchild = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar/baz',
        schema          : 'baz',
        dataFormat      : 'text/plain',
        parentContextId : child.message.contextId,
      });

      expect((await dwn.applyReplicatedMessage(
        alice.did, grandchild.message, { dataStream: grandchild.dataStream },
      )).kind).toBe('Superseded');
    });

    it('should classify a not-yet-seen parent as a repairable Incomplete dependency', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const protocolDefinition = nestedProtocolDefinition;
      const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      expect((await dwn.processMessage(alice.did, configureMessage)).status.code).toBe(202);

      // No parent was ever written, so the missing dependency can still be repaired.
      const { message: childMessage, dataBytes: childDataBytes } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'foo/bar',
        schema          : 'bar',
        dataFormat      : 'text/plain',
        parentContextId : 'missingparentcontext',
      });

      const reply = await dwn.processMessage(alice.did, childMessage, { dataStream: DataStream.fromBytes(childDataBytes!) });
      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationParentRecordNotFound);

      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, childMessage, {
        dataStream: DataStream.fromBytes(childDataBytes!),
      });
      expect(replicatedResult.kind).toBe('Incomplete');
      if (replicatedResult.kind === 'Incomplete') {
        expect(replicatedResult.missing[0].type).toBe('Parent');
      }
    });
  });

  describe('role records', () => {
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

  describe('protocol definition history', () => {
    it('should accept backdated initial writes using the earliest retained config in both entry points', async () => {
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

      const processReply = await dwn.processMessage(alice.did, recordsWrite.message, { dataStream: recordsWrite.dataStream });
      expect(processReply.status.code).toBe(202);

      const replicatedWrite = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'foo',
        schema           : 'foo',
        dataFormat       : 'text/plain',
        dateCreated      : writeTimestamp,
        messageTimestamp : writeTimestamp,
      });

      const result = await dwn.applyReplicatedMessage(
        alice.did, replicatedWrite.message, { dataStream: DataStream.fromBytes(replicatedWrite.dataBytes!) },
      );
      expect(result.kind).toBe('Applied');
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

    it('should derive missing cross-protocol role dependencies from the incoming message timestamp config', async () => {
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
      )).toEqual(expect.objectContaining({ kind: 'Applied' }));

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
          protocol     : roleProtocolV2Uri,
          protocolPath : 'participant',
          recipient    : bob.did,
        }],
      });
    });

    it('should validate initial writes against the config active at their message timestamp in both entry points', async () => {
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
      const { message: alphaMessage, dataStream: alphaDataStream } = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'alpha',
        schema           : 'alpha',
        dataFormat       : 'text/plain',
        dateCreated      : writeTimestamp,
        messageTimestamp : writeTimestamp,
      });

      const processReply = await dwn.processMessage(alice.did, alphaMessage, { dataStream: alphaDataStream });
      expect(processReply.status.code).toBe(202);

      const replicatedWrite = await TestDataGenerator.generateRecordsWrite({
        author           : alice,
        protocol         : protocolUri,
        protocolPath     : 'alpha',
        schema           : 'alpha',
        dataFormat       : 'text/plain',
        dateCreated      : writeTimestamp,
        messageTimestamp : writeTimestamp,
      });

      const replicatedResult = await dwn.applyReplicatedMessage(alice.did, replicatedWrite.message, {
        dataStream: DataStream.fromBytes(replicatedWrite.dataBytes!),
      });
      expect(replicatedResult.kind).toBe('Applied');
    });

    it('should enforce squash backstop from the config active at the incoming write timestamp in both entry points', async () => {
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
      expect(processReply.status.code).toBe(409);
      expect(processReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationSquashBackstop);

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
      expect(result.kind).toBe('Superseded');
    });
  });
});

describe('StoreValidationStateReader', () => {

  describe('queryAudienceRecords()', () => {
    it('should query accepted source-protocol audience records by audience coordinates', async () => {
      const message = { recordId: 'audience1' } as RecordsWriteMessage;
      let capturedTenant: string | undefined;
      let capturedFilters: Filter[] | undefined;
      const messageStore = {
        query: async (tenant: string, filters: Filter[]): Promise<{ messages: GenericMessage[] }> => {
          capturedTenant = tenant;
          capturedFilters = filters;
          return { messages: [message] };
        },
      } as unknown as MessageStore;
      const reader = new StoreValidationStateReader({
        dataStore: {} as DataStore,
        messageStore,
      });

      const messages = await reader.queryAudienceRecords({
        tenant    : 'did:example:alice',
        protocol  : 'https://example.com/protocol/chat',
        contextId : 'chat1',
        rolePath  : 'chat/member',
        keyId     : 'abc',
      });

      expect(messages).toEqual([message]);
      expect(capturedTenant).toBe('did:example:alice');
      expect(capturedFilters).toEqual([{
        interface         : DwnInterfaceName.Records,
        method            : DwnMethodName.Write,
        isLatestBaseState : true,
        protocol          : 'https://example.com/protocol/chat',
        protocolPath      : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        'tag.protocol'    : 'https://example.com/protocol/chat',
        'tag.rolePath'    : 'chat/member',
        'tag.contextId'   : 'chat1',
        'tag.keyId'       : 'abc',
      }]);
    });

    it('should omit keyId from source-protocol audience queries when not supplied', async () => {
      let capturedFilters: Filter[] | undefined;
      const messageStore = {
        query: async (_tenant: string, filters: Filter[]): Promise<{ messages: GenericMessage[] }> => {
          capturedFilters = filters;
          return { messages: [] };
        },
      } as unknown as MessageStore;
      const reader = new StoreValidationStateReader({
        dataStore: {} as DataStore,
        messageStore,
      });

      await reader.queryAudienceRecords({
        tenant    : 'did:example:alice',
        protocol  : 'https://example.com/protocol/chat',
        contextId : '',
        rolePath  : 'member',
      });

      expect(capturedFilters?.[0]['tag.keyId']).toBeUndefined();
    });
  });
});

describe('RecordingValidationStateReader', () => {
  describe('queryAudienceRecords()', () => {
    it('should record source-protocol audience reads before delegating', async () => {
      const message = { recordId: 'audience1' } as RecordsWriteMessage;
      const inner = {
        queryAudienceRecords: async (): Promise<RecordsWriteMessage[]> => [message],
      } as unknown as ValidationStateReader;
      const reader = new RecordingValidationStateReader(inner);

      const messages = await reader.queryAudienceRecords({
        tenant    : 'did:example:alice',
        protocol  : 'https://example.com/protocol/chat',
        contextId : 'chat1',
        rolePath  : 'chat/member',
      });

      expect(messages).toEqual([message]);
      expect(reader.reads).toEqual([{ method: 'queryAudienceRecords' }]);

      reader.clearRecordedReads();
      expect(reader.reads).toEqual([]);
    });
  });
});
