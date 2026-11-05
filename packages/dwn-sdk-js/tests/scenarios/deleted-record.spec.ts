import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, RecordsReadReply, ResumableTaskStore } from '../../src/index.js';

import freeForAllModuleDefinition from '../vectors/module-definitions/free-for-all.json' with { type: 'json' };
import sinon from 'sinon';
import threadRoleModuleDefinition from '../vectors/module-definitions/thread-role.json' with { type: 'json' };
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';

import { DataStream, Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Jws, ModulesConfigure, PermissionsModule, RecordsRead, Time } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { Encoder, RecordsDelete, RecordsWrite } from '../../src/index.js';

export function testDeletedRecordScenarios(): void {
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

    it('should return the RecordsDelete and initial RecordsWrite when reading a deleted record', async () => {
      // Scenario:
      // 1. Alice deletes an existing record.
      // 2. Alice attempts to read the deleted record.
      // Expected outcome: Alice should get a 404 error with the reply containing the deleted record and the initial write of the record.

      // 0. Setting up a module and write a record
      const alice = await TestDataGenerator.generatePersona();
      TestStubGenerator.stubDidResolver(didResolver, [alice]);

      const moduleDefinition = freeForAllModuleDefinition;
      const modulesConfigure = await ModulesConfigure.create({
        signer     : Jws.createSigner(alice),
        definition : moduleDefinition
      });
      const modulesConfigureForAliceReply = await dwn.processMessage(
        alice.did,
        modulesConfigure.message
      );
      expect(modulesConfigureForAliceReply.status.code).toBe(202);

      const data = Encoder.stringToBytes('some post content');
      const { message: recordsWriteMessage } = await RecordsWrite.create({
        signer     : Jws.createSigner(alice),
        module     : moduleDefinition.module,
        modulePath : 'post',
        schema     : moduleDefinition.types.post.schema,
        dataFormat : moduleDefinition.types.post.dataFormats[0],
        data,
      });
      const writeReply = await dwn.processMessage(alice.did, recordsWriteMessage, { dataStream: DataStream.fromBytes(data) });
      expect(writeReply.status.code).toBe(202);

      // 1. Alice deletes an existing record.
      const recordsDelete = await RecordsDelete.create({
        signer   : Jws.createSigner(alice),
        recordId : recordsWriteMessage.recordId
      });

      const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
      expect(deleteReply.status.code).toBe(202);

      // 2. Alice attempts to read the deleted record.
      const readData = await RecordsRead.create({
        signer : Jws.createSigner(alice),
        filter : { recordId: recordsWriteMessage.recordId }
      });
      const readReply = await dwn.processMessage(alice.did, readData.message);

      // Expected outcome: Alice should get a 404 error with the reply containing the deleted record and the initial write of the record.
      expect(readReply.status.code).toBe(404);
      expect(readReply.entry!.recordsDelete).toBeDefined();
      expect(readReply.entry!.recordsDelete).toEqual(recordsDelete.message);
      expect(readReply.entry!.initialWrite).toBeDefined();
      expect(readReply.entry!.initialWrite).toEqual(recordsWriteMessage);
    });

    // =========================================================================
    // Authorization checks for deleted record reads (#222)
    // =========================================================================

    describe('deleted record read authorization', () => {
      it('should allow the non-owner author to read their own deleted record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install the free-for-all module on Alice's DWN
        const moduleDefinition = freeForAllModuleDefinition;
        const modulesConfigure = await ModulesConfigure.create({
          signer     : Jws.createSigner(alice),
          definition : moduleDefinition
        });
        await dwn.processMessage(alice.did, modulesConfigure.message);

        // Bob writes a record to Alice's DWN (via 'anyone' can 'create')
        const data = Encoder.stringToBytes('bob writes a post');
        const { message: writeMessage } = await RecordsWrite.create({
          signer     : Jws.createSigner(bob),
          module     : moduleDefinition.module,
          modulePath : 'post',
          schema     : moduleDefinition.types.post.schema,
          dataFormat : moduleDefinition.types.post.dataFormats[0],
          data,
        });
        const writeReply = await dwn.processMessage(alice.did, writeMessage, { dataStream: DataStream.fromBytes(data) });
        expect(writeReply.status.code).toBe(202);

        // Alice (tenant) deletes Bob's record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : writeMessage.recordId,
        });
        const deleteReply = await dwn.processMessage(alice.did, recordsDelete.message);
        expect(deleteReply.status.code).toBe(202);

        // Bob (non-owner author) should be able to read the deleted record
        const bobRead = await RecordsRead.create({
          signer : Jws.createSigner(bob),
          filter : { recordId: writeMessage.recordId },
        });
        const readReply = await dwn.processMessage(alice.did, bobRead.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(404);
        expect(readReply.entry!.recordsDelete).toBeDefined();
        expect(readReply.entry!.initialWrite).toBeDefined();
      });

      it('should allow the recipient to read a deleted record', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

        // Install a module where recipient can read (requires `of` property)
        const moduleDefinition = {
          module    : 'http://recipient-read.xyz',
          published : true,
          types     : {
            note: {
              schema      : 'note',
              dataFormats : ['application/json'],
            },
          },
          structure: {
            note: {
              $actions: [
                { who: 'anyone', can: ['create', 'delete'] },
                { who: 'recipient', of: 'note', can: ['read'] },
              ],
            },
          },
        };

        const modulesConfigure = await ModulesConfigure.create({
          signer     : Jws.createSigner(alice),
          definition : moduleDefinition,
        });
        await dwn.processMessage(alice.did, modulesConfigure.message);

        // Alice writes a record with Bob as recipient
        const data = Encoder.stringToBytes('secret note for bob');
        const { message: writeMessage } = await RecordsWrite.create({
          signer     : Jws.createSigner(alice),
          recipient  : bob.did,
          module     : moduleDefinition.module,
          modulePath : 'note',
          schema     : 'note',
          dataFormat : 'application/json',
          data,
        });
        await dwn.processMessage(alice.did, writeMessage, { dataStream: DataStream.fromBytes(data) });

        // Alice deletes the record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : writeMessage.recordId,
        });
        await dwn.processMessage(alice.did, recordsDelete.message);

        // Bob (recipient) should be able to read the deleted record
        const bobRead = await RecordsRead.create({
          signer : Jws.createSigner(bob),
          filter : { recordId: writeMessage.recordId },
        });
        const readReply = await dwn.processMessage(alice.did, bobRead.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(404);
        expect(readReply.entry!.recordsDelete).toBeDefined();
        expect(readReply.entry!.initialWrite).toBeDefined();
      });

      it('should allow a grant holder to read a deleted record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install module
        const moduleDefinition = freeForAllModuleDefinition;
        const modulesConfigure = await ModulesConfigure.create({
          signer     : Jws.createSigner(alice),
          definition : moduleDefinition,
        });
        await dwn.processMessage(alice.did, modulesConfigure.message);

        // Alice writes a record
        const data = Encoder.stringToBytes('some post');
        const { message: writeMessage } = await RecordsWrite.create({
          signer     : Jws.createSigner(alice),
          module     : moduleDefinition.module,
          modulePath : 'post',
          schema     : moduleDefinition.types.post.schema,
          dataFormat : moduleDefinition.types.post.dataFormats[0],
          data,
        });
        await dwn.processMessage(alice.did, writeMessage, { dataStream: DataStream.fromBytes(data) });

        // Alice deletes the record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : writeMessage.recordId,
        });
        await dwn.processMessage(alice.did, recordsDelete.message);

        // Alice creates a read grant for Bob
        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 }),
          scope       : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            module    : moduleDefinition.module,
          },
        });
        const grantDataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
        await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream: grantDataStream });

        // Bob reads the deleted record using the grant
        const bobRead = await RecordsRead.create({
          signer            : Jws.createSigner(bob),
          permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          filter            : { recordId: writeMessage.recordId },
        });
        const readReply = await dwn.processMessage(alice.did, bobRead.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(404);
        expect(readReply.entry!.recordsDelete).toBeDefined();
        expect(readReply.entry!.initialWrite).toBeDefined();
      });

      it('should allow a module role holder to read a deleted record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install thread-role module
        const moduleDefinition = threadRoleModuleDefinition;
        const modulesConfigure = await ModulesConfigure.create({
          signer     : Jws.createSigner(alice),
          definition : moduleDefinition,
        });
        await dwn.processMessage(alice.did, modulesConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : moduleDefinition.module,
          modulePath : 'thread',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant (role)
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : moduleDefinition.module,
          modulePath      : 'thread/participant',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Bob creates a chat message (via participant role)
        const chatWrite = await TestDataGenerator.generateRecordsWrite({
          author          : bob,
          module          : moduleDefinition.module,
          modulePath      : 'thread/chat',
          moduleRole      : 'thread/participant',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, chatWrite.message, { dataStream: chatWrite.dataStream });

        // Alice deletes the chat message
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : chatWrite.message.recordId,
        });
        await dwn.processMessage(alice.did, recordsDelete.message);

        // Bob reads the deleted chat message using his participant role
        const bobRead = await RecordsRead.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'thread/participant',
          filter     : {
            recordId: chatWrite.message.recordId,
          },
        });
        const readReply = await dwn.processMessage(alice.did, bobRead.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(404);
        expect(readReply.entry!.recordsDelete).toBeDefined();
        expect(readReply.entry!.initialWrite).toBeDefined();
      });

      it('should allow anonymous read of a deleted record that was published', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install module
        const moduleDefinition = freeForAllModuleDefinition;
        const modulesConfigure = await ModulesConfigure.create({
          signer     : Jws.createSigner(alice),
          definition : moduleDefinition,
        });
        await dwn.processMessage(alice.did, modulesConfigure.message);

        // Alice writes a published record
        const data = Encoder.stringToBytes('public post');
        const { message: writeMessage } = await RecordsWrite.create({
          signer     : Jws.createSigner(alice),
          module     : moduleDefinition.module,
          modulePath : 'post',
          schema     : moduleDefinition.types.post.schema,
          dataFormat : moduleDefinition.types.post.dataFormats[0],
          published  : true,
          data,
        });
        await dwn.processMessage(alice.did, writeMessage, { dataStream: DataStream.fromBytes(data) });

        // Alice deletes the record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : writeMessage.recordId,
        });
        await dwn.processMessage(alice.did, recordsDelete.message);

        // Anonymous read (no signer) should succeed because the record was published
        const anonRead = await RecordsRead.create({
          filter: { recordId: writeMessage.recordId },
        });
        const readReply = await dwn.processMessage(alice.did, anonRead.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(404);
        expect(readReply.entry!.recordsDelete).toBeDefined();
        expect(readReply.entry!.initialWrite).toBeDefined();
      });

      it('should reject an unauthorized user from reading a deleted record', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        const carol = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob, carol]);

        // Install a module where only author and recipient can read (no 'anyone' can 'read')
        const moduleDefinition = {
          module    : 'http://restricted-read.xyz',
          published : true,
          types     : {
            note: {
              schema      : 'note',
              dataFormats : ['application/json'],
            },
          },
          structure: {
            note: {
              $actions: [
                { who: 'anyone', can: ['create', 'delete'] },
                { who: 'recipient', of: 'note', can: ['read'] },
              ],
            },
          },
        };

        const modulesConfigure = await ModulesConfigure.create({
          signer     : Jws.createSigner(alice),
          definition : moduleDefinition,
        });
        await dwn.processMessage(alice.did, modulesConfigure.message);

        // Alice writes a record with Bob as recipient
        const data = Encoder.stringToBytes('private note');
        const { message: writeMessage } = await RecordsWrite.create({
          signer     : Jws.createSigner(alice),
          recipient  : bob.did,
          module     : moduleDefinition.module,
          modulePath : 'note',
          schema     : 'note',
          dataFormat : 'application/json',
          data,
        });
        await dwn.processMessage(alice.did, writeMessage, { dataStream: DataStream.fromBytes(data) });

        // Alice deletes the record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : writeMessage.recordId,
        });
        await dwn.processMessage(alice.did, recordsDelete.message);

        // Carol (neither author, recipient, nor tenant) tries to read — should be rejected
        const carolRead = await RecordsRead.create({
          signer : Jws.createSigner(carol),
          filter : { recordId: writeMessage.recordId },
        });
        const readReply = await dwn.processMessage(alice.did, carolRead.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(401);
        expect(readReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationActionNotAllowed);
      });

      it('should authorize against the newest write when a record was updated before deletion', async () => {
        // Scenario: Alice writes a record (unpublished), updates it to published, then deletes it.
        // An anonymous reader should be able to get the 404 + metadata because the newest write was published.
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install module
        const moduleDefinition = freeForAllModuleDefinition;
        const modulesConfigure = await ModulesConfigure.create({
          signer     : Jws.createSigner(alice),
          definition : moduleDefinition,
        });
        await dwn.processMessage(alice.did, modulesConfigure.message);

        // Alice writes an unpublished record
        const data = Encoder.stringToBytes('initially unpublished');
        const recordsWrite = await RecordsWrite.create({
          signer     : Jws.createSigner(alice),
          module     : moduleDefinition.module,
          modulePath : 'post',
          schema     : moduleDefinition.types.post.schema,
          dataFormat : moduleDefinition.types.post.dataFormats[0],
          data,
        });
        await dwn.processMessage(alice.did, recordsWrite.message, { dataStream: DataStream.fromBytes(data) });

        // Alice updates the record to published
        const updatedData = Encoder.stringToBytes('now published');
        const recordsUpdate = await RecordsWrite.createFrom({
          recordsWriteMessage : recordsWrite.message,
          signer              : Jws.createSigner(alice),
          published           : true,
          data                : updatedData,
        });
        await dwn.processMessage(alice.did, recordsUpdate.message, { dataStream: DataStream.fromBytes(updatedData) });

        // Alice deletes the record
        const recordsDelete = await RecordsDelete.create({
          signer   : Jws.createSigner(alice),
          recordId : recordsWrite.message.recordId,
        });
        await dwn.processMessage(alice.did, recordsDelete.message);

        // Anonymous read should succeed because the newest write had published: true
        const anonRead = await RecordsRead.create({
          filter: { recordId: recordsWrite.message.recordId },
        });
        const readReply = await dwn.processMessage(alice.did, anonRead.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(404);
        expect(readReply.entry!.recordsDelete).toBeDefined();
        expect(readReply.entry!.initialWrite).toBeDefined();
      });
    });
  });
}