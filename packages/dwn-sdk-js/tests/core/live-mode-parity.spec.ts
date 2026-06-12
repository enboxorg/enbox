import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { GenericMessageReply } from '../../src/types/message-types.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../../src/index.js';
import type { RecordsQueryReply, RecordsReadReply } from '../../src/types/records-types.js';

import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import nestedProtocolDefinition from '../vectors/protocol-definitions/nested.json' with { type: 'json' };

import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { RecordsRead } from '../../src/interfaces/records-read.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';

/**
 * Live-mode parity pin: this spec exercises a representative matrix of writes, deletes, queries,
 * and reads through the public `processMessage()` API only, asserting the exact reply statuses
 * the handlers produce on the live path.
 *
 * The expectations were derived from the pre-`ValidationStateReader` handlers (current `main`).
 * The `ValidationStateReader` refactor must not change any of them: this file deliberately avoids
 * every new API so it runs byte-identically against the pre-refactor code.
 */
describe('live-mode parity', () => {
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

  it('should pin reply statuses for the plain record lifecycle', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    // 1. initial write with data → 202
    const { message: writeMessage, dataStream, dataBytes, recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const writeReply = await dwn.processMessage(alice.did, writeMessage, { dataStream });
    expect(writeReply.status.code).toBe(202);

    // 2. exact duplicate of an already-stored write → 409
    const duplicateReply = await dwn.processMessage(alice.did, writeMessage);
    expect(duplicateReply.status.code).toBe(409);

    // 3. update (non-initial write) with data → 202
    const { message: updateMessage, dataStream: updateDataStream } = await TestDataGenerator.generateFromRecordsWrite({
      author        : alice,
      existingWrite : recordsWrite,
    });
    const updateReply = await dwn.processMessage(alice.did, updateMessage, { dataStream: updateDataStream });
    expect(updateReply.status.code).toBe(202);

    // 4. read → 200 with the updated record
    const recordsRead = await RecordsRead.create({
      filter : { recordId: writeMessage.recordId },
      signer : Jws.createSigner(alice),
    });
    const readReply = await dwn.processMessage(alice.did, recordsRead.message) as RecordsReadReply;
    expect(readReply.status.code).toBe(200);
    expect(readReply.entry?.recordsWrite?.recordId).toBe(writeMessage.recordId);

    // 5. query → 200 with exactly one entry for the record
    const { message: queryMessage } = await TestDataGenerator.generateRecordsQuery({
      author : alice,
      filter : { recordId: writeMessage.recordId },
    });
    const queryReply = await dwn.processMessage(alice.did, queryMessage) as RecordsQueryReply;
    expect(queryReply.status.code).toBe(200);
    expect(queryReply.entries?.length).toBe(1);

    // 6. delete → 202
    const { message: deleteMessage } = await TestDataGenerator.generateRecordsDelete({
      author   : alice,
      recordId : writeMessage.recordId,
    });
    const deleteReply = await dwn.processMessage(alice.did, deleteMessage);
    expect(deleteReply.status.code).toBe(202);

    // 7. write-after-delete → 400 RecordsWriteNotAllowedAfterDelete
    const { message: writeAfterDeleteMessage, dataStream: writeAfterDeleteStream } = await TestDataGenerator.generateFromRecordsWrite({
      author        : alice,
      existingWrite : recordsWrite,
    });
    const writeAfterDeleteReply = await dwn.processMessage(alice.did, writeAfterDeleteMessage, { dataStream: writeAfterDeleteStream });
    expect(writeAfterDeleteReply.status.code).toBe(400);
    expect(writeAfterDeleteReply.status.detail).toContain(DwnErrorCode.RecordsWriteNotAllowedAfterDelete);

    // 8. delete of a record that never existed → 404
    const { message: deleteMissingMessage } = await TestDataGenerator.generateRecordsDelete({
      author   : alice,
      recordId : await TestDataGenerator.randomCborSha256Cid(),
    });
    const deleteMissingReply = await dwn.processMessage(alice.did, deleteMissingMessage);
    expect(deleteMissingReply.status.code).toBe(404);

    expect(dataBytes!.length).toBeGreaterThan(0); // sanity: the matrix exercised real data
  });

  it('should pin reply statuses for protocol referential integrity and authorization', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const bob = await TestDataGenerator.generateDidKeyPersona();

    // 1. protocol configure → 202
    const protocolDefinition = nestedProtocolDefinition;
    const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
      author: alice,
      protocolDefinition,
    });
    const configureReply = await dwn.processMessage(alice.did, configureMessage);
    expect(configureReply.status.code).toBe(202);

    // 2. initial protocol write without data → 204 (stored as non-queryable initial state)
    const { message: parentMessage, recordsWrite: parentWrite } = await TestDataGenerator.generateRecordsWrite({
      author       : alice,
      protocol     : protocolDefinition.protocol,
      protocolPath : 'foo',
      schema       : 'foo',
      dataFormat   : 'text/plain',
    });
    const datalessParentReply = await dwn.processMessage(alice.did, parentMessage);
    expect(datalessParentReply.status.code).toBe(204);

    // 3. child write under the dataless (non-latest) parent → 400 parent not found
    const { message: childMessage, dataStream: childDataStream } = await TestDataGenerator.generateRecordsWrite({
      author          : alice,
      protocol        : protocolDefinition.protocol,
      protocolPath    : 'foo/bar',
      schema          : 'bar',
      dataFormat      : 'text/plain',
      parentContextId : parentWrite.message.contextId,
    });
    const childReply = await dwn.processMessage(alice.did, childMessage, { dataStream: childDataStream });
    expect(childReply.status.code).toBe(400);
    expect(childReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationParentRecordNotFound);

    // 4. write by a non-tenant author with no grant, role, or action rule → 401
    const { message: strangerMessage, dataStream: strangerDataStream } = await TestDataGenerator.generateRecordsWrite({
      author       : bob,
      protocol     : protocolDefinition.protocol,
      protocolPath : 'foo',
      schema       : 'foo',
      dataFormat   : 'text/plain',
    });
    const strangerReply = await dwn.processMessage(alice.did, strangerMessage, { dataStream: strangerDataStream });
    expect(strangerReply.status.code).toBe(401);
    expect(strangerReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionRulesNotFound);
  });

  it('should pin reply statuses for role-authorized writes', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const bob = await TestDataGenerator.generateDidKeyPersona();
    const carol = await TestDataGenerator.generateDidKeyPersona();

    const protocolDefinition = friendRoleProtocolDefinition;
    const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
      author: alice,
      protocolDefinition,
    });
    const configureReply = await dwn.processMessage(alice.did, configureMessage);
    expect(configureReply.status.code).toBe(202);

    // 1. role record for bob with data → 202
    const { message: roleMessage, dataStream: roleDataStream } = await TestDataGenerator.generateRecordsWrite({
      author       : alice,
      recipient    : bob.did,
      protocol     : protocolDefinition.protocol,
      protocolPath : 'friend',
    });
    const roleReply = await dwn.processMessage(alice.did, roleMessage, { dataStream: roleDataStream });
    expect(roleReply.status.code).toBe(202);

    // 2. bob invokes the friend role to create a chat record → 202
    const { message: chatMessage, dataStream: chatDataStream } = await TestDataGenerator.generateRecordsWrite({
      author       : bob,
      protocol     : protocolDefinition.protocol,
      protocolPath : 'chat',
      protocolRole : 'friend',
    });
    const chatReply = await dwn.processMessage(alice.did, chatMessage, { dataStream: chatDataStream });
    expect(chatReply.status.code).toBe(202);

    // 3. carol invokes the friend role without holding a role record → 401 matching role record not found
    const { message: carolChatMessage, dataStream: carolChatDataStream } = await TestDataGenerator.generateRecordsWrite({
      author       : carol,
      protocol     : protocolDefinition.protocol,
      protocolPath : 'chat',
      protocolRole : 'friend',
    });
    const carolChatReply: GenericMessageReply = await dwn.processMessage(alice.did, carolChatMessage, { dataStream: carolChatDataStream });
    expect(carolChatReply.status.code).toBe(401);
    expect(carolChatReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
  });
});
