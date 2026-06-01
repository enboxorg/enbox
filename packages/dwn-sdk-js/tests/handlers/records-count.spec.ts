import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ResumableTaskStore, StateIndex } from '../../src/index.js';

import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DataStream } from '../../src/utils/data-stream.js';
import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { PermissionsProtocol } from '../../src/protocols/permissions.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };
import { DidKey, UniversalResolver } from '@enbox/dids';
import { Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Time } from '../../src/index.js';

export function testRecordsCountHandler(): void {
  describe('RecordsCountHandler.handle()', () => {

    beforeEach(() => {
      sinon.restore();
    });

    describe('functional tests', () => {
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
        await resumableTaskStore.clear();
        await stateIndex.clear();
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('should return 0 when no records match', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        const { message } = await TestDataGenerator.generateRecordsCount({
          author : alice,
          filter : { schema: 'nonexistent-schema' }
        });
        const reply = await dwn.processMessage(alice.did, message);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(0);
      });

      it('should count records owned by the tenant', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write 3 records with the same schema
        const schema = 'http://test-schema.example';
        for (let i = 0; i < 3; i++) {
          const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author: alice,
            schema
          });
          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);
        }

        // count them
        const { message } = await TestDataGenerator.generateRecordsCount({
          author : alice,
          filter : { schema }
        });
        const reply = await dwn.processMessage(alice.did, message);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(3);
      });

      it('should allow anonymous count of published records', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://published-schema.example';

        // write 2 published records
        for (let i = 0; i < 2; i++) {
          const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author    : alice,
            schema,
            published : true
          });
          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);
        }

        // write 1 unpublished record
        const { message: unpublished, dataStream: unpublishedStream } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
          schema,
        });
        const unpublishedReply = await dwn.processMessage(alice.did, unpublished, { dataStream: unpublishedStream });
        expect(unpublishedReply.status.code).toBe(202);

        // anonymous count (no signer) should only see published records
        const { message: countMessage } = await TestDataGenerator.generateRecordsCount({
          anonymous : true,
          filter    : { schema, published: true }
        });
        const reply = await dwn.processMessage(alice.did, countMessage);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(2);
      });

      it('should return 0 for anonymous count when no published records exist', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write an unpublished record
        const schema = 'http://unpublished.example';
        const { message: writeMsg, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
          schema,
        });
        const writeReply = await dwn.processMessage(alice.did, writeMsg, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // anonymous count without explicit `published: true` — still scans published records, finds 0
        const { message } = await TestDataGenerator.generateRecordsCount({
          anonymous : true,
          filter    : { schema }
        });
        const reply = await dwn.processMessage(alice.did, message);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(0);
      });

      it('should only count records matching the filter for non-owner (recipient)', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://recipient-schema.example';

        // alice writes a record with bob as recipient
        const { message: write1, dataStream: stream1 } = await TestDataGenerator.generateRecordsWrite({
          author    : alice,
          schema,
          recipient : bob.did
        });
        const writeReply1 = await dwn.processMessage(alice.did, write1, { dataStream: stream1 });
        expect(writeReply1.status.code).toBe(202);

        // alice writes another record with NO recipient
        const { message: write2, dataStream: stream2 } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
          schema,
        });
        const writeReply2 = await dwn.processMessage(alice.did, write2, { dataStream: stream2 });
        expect(writeReply2.status.code).toBe(202);

        // bob counts records: should only see the one where he is the recipient
        const { message: countMessage } = await TestDataGenerator.generateRecordsCount({
          author : bob,
          filter : { schema }
        });
        const reply = await dwn.processMessage(alice.did, countMessage);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(1);
      });

      it('should count unpublished records authorized by permissionGrantId', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const { message: unpublished, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, unpublished, { dataStream });
        expect(writeReply.status.code).toBe(202);

        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface    : DwnInterfaceName.Records,
            method       : DwnMethodName.Count,
            protocol     : 'http://test-protocol.xyz',
            protocolPath : 'testRecord',
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        const { message } = await TestDataGenerator.generateRecordsCount({
          author : bob,
          filter : {
            protocol     : 'http://test-protocol.xyz',
            protocolPath : 'testRecord',
            published    : false,
          },
          permissionGrantId: permissionGrant.recordsWrite.message.recordId,
        });
        const reply = await dwn.processMessage(alice.did, message);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(1);
      });

      it('should reject permissionGrantId counts with filters outside the grant scope', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const permissionGrant = await PermissionsProtocol.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface    : DwnInterfaceName.Records,
            method       : DwnMethodName.Count,
            protocol     : 'http://test-protocol.xyz',
            protocolPath : 'testRecord',
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        for (const filter of [
          { published: false },
          { protocol: 'http://other-protocol.xyz', protocolPath: 'testRecord', published: false },
        ]) {
          const { message } = await TestDataGenerator.generateRecordsCount({
            author            : bob,
            filter,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const reply = await dwn.processMessage(alice.did, message);
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationQueryOrSubscribeProtocolScopeMismatch);
        }
      });

      it('should only count published records for non-owner with published filter', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://published-filter.example';

        // alice writes 2 published records
        for (let i = 0; i < 2; i++) {
          const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author    : alice,
            schema,
            published : true
          });
          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);
        }

        // alice writes 1 unpublished record
        const { message: unpublished, dataStream: unpublishedStream } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
          schema,
        });
        const unpublishedReply = await dwn.processMessage(alice.did, unpublished, { dataStream: unpublishedStream });
        expect(unpublishedReply.status.code).toBe(202);

        // bob counts only published records
        const { message: countMessage } = await TestDataGenerator.generateRecordsCount({
          author : bob,
          filter : { schema, published: true }
        });
        const reply = await dwn.processMessage(alice.did, countMessage);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(2);
      });

      it('should count protocol records with role-based authorization', async () => {
        // Scenario: Alice installs a thread protocol, Bob is a thread participant,
        // Bob uses his role to count chat messages.
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

        const protocolDefinition = threadRoleProtocolDefinition as ProtocolDefinition;
        const protocol = protocolDefinition.protocol;

        // alice installs protocol
        const { message: protocolConfig } = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig);
        expect(configReply.status.code).toBe(202);

        // alice creates a thread
        const { message: threadWrite, dataStream: threadStream } = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol,
          protocolPath : 'thread',
        });
        const threadReply = await dwn.processMessage(alice.did, threadWrite, { dataStream: threadStream });
        expect(threadReply.status.code).toBe(202);

        // alice adds bob as a participant
        const { message: participantWrite, dataStream: participantStream } = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          protocol,
          protocolPath    : 'thread/participant',
          parentContextId : threadWrite.contextId,
        });
        const participantReply = await dwn.processMessage(alice.did, participantWrite, { dataStream: participantStream });
        expect(participantReply.status.code).toBe(202);

        // alice writes 3 chat messages
        for (let i = 0; i < 3; i++) {
          const { message: chatWrite, dataStream: chatStream } = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            protocol,
            protocolPath    : 'thread/chat',
            parentContextId : threadWrite.contextId,
          });
          const chatReply = await dwn.processMessage(alice.did, chatWrite, { dataStream: chatStream });
          expect(chatReply.status.code).toBe(202);
        }

        // bob counts chat messages using his participant role
        const { message: countMessage } = await TestDataGenerator.generateRecordsCount({
          author       : bob,
          filter       : { protocol, protocolPath: 'thread/chat', contextId: threadWrite.contextId },
          protocolRole : 'thread/participant',
        });
        const reply = await dwn.processMessage(alice.did, countMessage);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(3);
      });

      it('should return 400 for invalid RecordsCount message', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // send a malformed message
        const reply = await dwn.processMessage(alice.did, {
          descriptor: {
            interface        : 'Records',
            method           : 'Count',
            messageTimestamp : Time.getCurrentTimestamp(),
            // missing filter — should fail validation
          }
        } as any);

        expect(reply.status.code).toBe(400);
      });

      it('should reject role-authorized count without protocolPath in filter', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // create a count message with protocolRole but no protocolPath in the filter
        const { message } = await TestDataGenerator.generateRecordsCount({
          author       : alice,
          filter       : { protocol: 'http://example.com/protocol' },
          protocolRole : 'thread/participant',
        });

        // the handler calls parse() which should reject this
        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(400);
      });

      it('should count all records with a free-for-all protocol', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

        const protocolDefinition = freeForAll as ProtocolDefinition;
        const protocol = protocolDefinition.protocol;

        // alice installs protocol
        const { message: protocolConfig } = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const configReply = await dwn.processMessage(alice.did, protocolConfig);
        expect(configReply.status.code).toBe(202);

        // bob writes 2 posts
        for (let i = 0; i < 2; i++) {
          const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : bob,
            protocol,
            protocolPath : 'post',
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats![0],
          });
          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);
        }

        // alice (owner) counts all protocol posts
        const { message: countMessage } = await TestDataGenerator.generateRecordsCount({
          author : alice,
          filter : { protocol, protocolPath: 'post' }
        });
        const reply = await dwn.processMessage(alice.did, countMessage);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(2);
      });
    });
  });
}
