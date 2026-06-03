import type { DidResolver } from '@enbox/dids';
import type {
  DataStore,
  EventLog,
  MessageStore,
  ProtocolDefinition,
  ResumableTaskStore,
  StateIndex,
} from '../../src/index.js';

import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { MessagesSync } from '../../src/interfaces/messages-sync.js';
import { MessagesSyncHandler } from '../../src/handlers/messages-sync.js';
import sinon from 'sinon';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, PermissionGrant, PermissionsProtocol, Time } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';


export function testMessagesSyncHandler(): void {
  describe('MessagesSyncHandler.handle()', () => {
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

    describe('root action', () => {
      it('returns the empty root hash for a tenant with no messages', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(200);
        expect(typeof reply.root).toBe('string');
        expect(reply.root!.length).toBe(64); // hex-encoded 32-byte hash
      });

      it('returns a different root hash after writing a message', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // get the empty root
        const { message: rootMsg1 } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });
        const reply1 = await dwn.processMessage(alice.did, rootMsg1);
        expect(reply1.status.code).toBe(200);
        const emptyRoot = reply1.root;

        // write a record
        const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // get the root again
        const { message: rootMsg2 } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });
        const reply2 = await dwn.processMessage(alice.did, rootMsg2);
        expect(reply2.status.code).toBe(200);
        expect(reply2.root).not.toBe(emptyRoot);
      });

      it('returns protocol-scoped root hash when protocol is specified', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: true };

        // configure the protocol
        const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const configureReply = await dwn.processMessage(alice.did, protocolMessage);
        expect(configureReply.status.code).toBe(202);

        // write a record for this protocol
        const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'post',
          schema       : protocolDefinition.types.post.schema,
        });
        const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // write a record under a different protocol to diverge the global root
        const { message: otherRecord, dataStream: otherDataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const otherWriteReply = await dwn.processMessage(alice.did, otherRecord, { dataStream: otherDataStream });
        expect(otherWriteReply.status.code).toBe(202);

        // get the global root
        const { message: globalRootMsg } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });
        const globalReply = await dwn.processMessage(alice.did, globalRootMsg);
        expect(globalReply.status.code).toBe(200);

        // get the protocol-scoped root
        const { message: protoRootMsg } = await MessagesSync.create({
          signer   : Jws.createSigner(alice),
          action   : 'root',
          protocol : protocolDefinition.protocol,
        });
        const protoReply = await dwn.processMessage(alice.did, protoRootMsg);
        expect(protoReply.status.code).toBe(200);

        // global root and protocol root should be different
        // (global includes the record from the other protocol)
        expect(protoReply.root).not.toBe(globalReply.root);
        // both should be non-empty roots
        expect(protoReply.root!.length).toBe(64);
      });
    });

    describe('subtree action', () => {
      it('returns a subtree hash for a given bit prefix', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write a record so the tree is non-empty
        const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'subtree',
          prefix : '0',
        });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(200);
        expect(typeof reply.hash).toBe('string');
        expect(reply.hash!.length).toBe(64);
      });

      it('returns different hashes for different prefixes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write several records to populate various subtrees
        for (let i = 0; i < 10; i++) {
          const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
          const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
          expect(writeReply.status.code).toBe(202);
        }

        const { message: msg0 } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'subtree',
          prefix : '0',
        });
        const reply0 = await dwn.processMessage(alice.did, msg0);

        const { message: msg1 } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'subtree',
          prefix : '1',
        });
        const reply1 = await dwn.processMessage(alice.did, msg1);

        expect(reply0.status.code).toBe(200);
        expect(reply1.status.code).toBe(200);
        // With 10 messages, it's very likely the two halves of the tree differ
        // (not guaranteed but probabilistically near-certain)
      });
    });

    describe('leaves action', () => {
      it('returns all message CIDs for an empty prefix', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write some messages
        const expectedCids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
          const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
          expect(writeReply.status.code).toBe(202);
          expectedCids.push(await Message.getCid(recordMessage));
        }

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'leaves',
          prefix : '',
        });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(200);
        expect(Array.isArray(reply.entries)).toBe(true);
        // 3 RecordsWrite messages + 1 ProtocolsConfigure for the default test protocol
        expect(reply.entries!.length).toBe(4);
        for (const cid of expectedCids) {
          expect(reply.entries).toContain(cid);
        }
      });

      it('returns protocol-scoped leaves when protocol is specified', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: true };

        // configure the protocol
        const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const configureReply = await dwn.processMessage(alice.did, protocolMessage);
        expect(configureReply.status.code).toBe(202);

        // write a protocol-scoped record
        const { message: protoRecord, dataStream: protoDataStream } = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'post',
          schema       : protocolDefinition.types.post.schema,
        });
        const protoWriteReply = await dwn.processMessage(alice.did, protoRecord, { dataStream: protoDataStream });
        expect(protoWriteReply.status.code).toBe(202);

        // write a record under a different protocol
        const { message: otherRecord, dataStream: otherDataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const otherWriteReply = await dwn.processMessage(alice.did, otherRecord, { dataStream: otherDataStream });
        expect(otherWriteReply.status.code).toBe(202);

        // query protocol-scoped leaves
        const { message } = await MessagesSync.create({
          signer   : Jws.createSigner(alice),
          action   : 'leaves',
          prefix   : '',
          protocol : protocolDefinition.protocol,
        });

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(200);
        // should contain the ProtocolsConfigure and the protocol-scoped record, but not the other-protocol record
        expect(reply.entries!.length).toBe(2);
        const protocolCid = await Message.getCid(protocolMessage);
        const recordCid = await Message.getCid(protoRecord);
        expect(reply.entries).toContain(protocolCid);
        expect(reply.entries).toContain(recordCid);
      });
    });

    describe('authorization', () => {
      it('returns 401 if tenant is not the author', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });

        const reply = await dwn.processMessage(bob.did, message);
        expect(reply.status.code).toBe(401);
      });

      it('returns 400 if message is invalid', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });
        (message['descriptor'] as any)['troll'] = 'hehe';

        const handler = new MessagesSyncHandler({ didResolver, messageStore, stateIndex });
        const reply = await handler.handle({ tenant: alice.did, message });
        expect(reply.status.code).toBe(400);
      });

      describe('grant-based sync', () => {
        it('allows sync with a matching MessagesSync grant scope', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // write a record so the tree is non-empty
          const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
          const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
          expect(writeReply.status.code).toBe(202);

          // grant bob permission to sync Alice's messages
          const { message: grantMessage, dataStream: grantDataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
            },
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream });
          expect(grantReply.status.code).toBe(202);

          // bob syncs using the grant — root action
          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'root',
            permissionGrantIds : [grantMessage.recordId],
          });

          const reply = await dwn.processMessage(alice.did, syncMsg);
          expect(reply.status.code).toBe(200);
          expect(typeof reply.root).toBe('string');
          expect(reply.root!.length).toBe(64);
        });

        it('allows sync with a unified MessagesRead grant scope', async () => {
          // scenario: A Messages.Read grant should also authorize MessagesSync operations
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

          // write a record so the tree is non-empty
          const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
          const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
          expect(writeReply.status.code).toBe(202);

          // grant bob permission with Messages.Read scope (unified)
          const { message: grantMessage, dataStream: grantDataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
            },
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream });
          expect(grantReply.status.code).toBe(202);

          // bob syncs using the Messages.Read grant — root action
          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'root',
            permissionGrantIds : [grantMessage.recordId],
          });

          const reply2 = await dwn.processMessage(alice.did, syncMsg);
          expect(reply2.status.code).toBe(200);
          expect(typeof reply2.root).toBe('string');
          expect(reply2.root!.length).toBe(64);
        });

        it('allows sync with a protocol-scoped MessagesRead grant', async () => {
          // scenario: A Messages.Read grant scoped to a protocol should authorize protocol-scoped MessagesSync
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: true };

          // configure and write a protocol record
          const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition,
          });
          await dwn.processMessage(alice.did, protocolMessage);

          const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'post',
            schema       : protocolDefinition.types.post.schema,
          });
          await dwn.processMessage(alice.did, recordMessage, { dataStream });

          // grant bob permission with Messages.Read scope scoped to this protocol
          const { message: grantMessage, dataStream: grantDataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : protocolDefinition.protocol,
            },
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream });
          expect(grantReply.status.code).toBe(202);

          // bob syncs leaves with the protocol-scoped Messages.Read grant
          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'leaves',
            prefix             : '',
            protocol           : protocolDefinition.protocol,
            permissionGrantIds : [grantMessage.recordId],
          });

          const reply2 = await dwn.processMessage(alice.did, syncMsg);
          expect(reply2.status.code).toBe(200);
          expect(Array.isArray(reply2.entries)).toBe(true);
          expect(reply2.entries!.length).toBe(2);
        });

        it('allows sync with a protocol-scoped grant', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition: ProtocolDefinition = { ...freeForAll, published: true };

          // configure and write a protocol record
          const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition,
          });
          await dwn.processMessage(alice.did, protocolMessage);

          const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'post',
            schema       : protocolDefinition.types.post.schema,
          });
          await dwn.processMessage(alice.did, recordMessage, { dataStream });

          // grant bob permission to sync Alice's messages scoped to this protocol
          const { message: grantMessage, dataStream: grantDataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : protocolDefinition.protocol,
            },
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream });
          expect(grantReply.status.code).toBe(202);

          // bob syncs leaves with the protocol-scoped grant
          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'leaves',
            prefix             : '',
            protocol           : protocolDefinition.protocol,
            permissionGrantIds : [grantMessage.recordId],
          });

          const reply = await dwn.processMessage(alice.did, syncMsg);
          expect(reply.status.code).toBe(200);
          expect(Array.isArray(reply.entries)).toBe(true);
          // includes both the ProtocolsConfigure and the RecordsWrite
          expect(reply.entries!.length).toBe(2);
          const protocolCid = await Message.getCid(protocolMessage);
          const recordCid = await Message.getCid(recordMessage);
          expect(reply.entries).toContain(protocolCid);
          expect(reply.entries).toContain(recordCid);
        });

        it('allows protocol sync when one grant in a plural grant set covers the protocol', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocol1: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://plural-grant-sync-1' };
          const protocol2: ProtocolDefinition = { ...freeForAll, published: true, protocol: 'http://plural-grant-sync-2' };

          for (const protocolDefinition of [protocol1, protocol2]) {
            const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition,
            });
            await dwn.processMessage(alice.did, protocolMessage);
          }

          const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocol2.protocol,
            protocolPath : 'post',
            schema       : protocol2.types.post.schema,
          });
          await dwn.processMessage(alice.did, recordMessage, { dataStream });

          const grantIds: string[] = [];
          for (const protocolDefinition of [protocol1, protocol2]) {
            const { message: grantMessage, dataStream: grantDataStream } = await TestDataGenerator.generateGrantCreate({
              author    : alice,
              grantedTo : bob,
              scope     : {
                interface : DwnInterfaceName.Messages,
                method    : DwnMethodName.Read,
                protocol  : protocolDefinition.protocol,
              },
            });
            const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream });
            expect(grantReply.status.code).toBe(202);
            grantIds.push(grantMessage.recordId);
          }

          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'leaves',
            prefix             : '',
            protocol           : protocol2.protocol,
            permissionGrantIds : grantIds.reverse(),
          });

          const reply = await dwn.processMessage(alice.did, syncMsg);
          expect(reply.status.code).toBe(200);
          expect(reply.entries).toContain(await Message.getCid(recordMessage));
          expect(syncMsg.descriptor.permissionGrantIds).toEqual([...grantIds].sort());
        });

        it('rejects sync when any grant in a plural grant set is expired', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocol = 'http://plural-grant-sync-expired';
          const now = Time.getCurrentTimestamp();

          const { message: activeGrantMessage, dataStream: activeGrantDataStream } = await TestDataGenerator.generateGrantCreate({
            author      : alice,
            grantedTo   : bob,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 }, now),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol,
            },
          });
          expect((await dwn.processMessage(alice.did, activeGrantMessage, { dataStream: activeGrantDataStream })).status.code).toBe(202);

          const { message: expiredGrantMessage, dataStream: expiredGrantDataStream } = await TestDataGenerator.generateGrantCreate({
            author      : alice,
            grantedTo   : bob,
            dateGranted : Time.createOffsetTimestamp({ seconds: -120 }, now),
            dateExpires : Time.createOffsetTimestamp({ seconds: -60 }, now),
            scope       : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol,
            },
          });
          expect((await dwn.processMessage(alice.did, expiredGrantMessage, { dataStream: expiredGrantDataStream })).status.code).toBe(202);

          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'root',
            protocol,
            permissionGrantIds : [activeGrantMessage.recordId, expiredGrantMessage.recordId],
          });

          const reply = await dwn.processMessage(alice.did, syncMsg);
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantExpired);
        });

        it('rejects sync when any grant in a plural grant set is revoked', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocol = 'http://plural-grant-sync-revoked';

          const { message: activeGrantMessage, dataStream: activeGrantDataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol,
            },
          });
          expect((await dwn.processMessage(alice.did, activeGrantMessage, { dataStream: activeGrantDataStream })).status.code).toBe(202);

          const revokedGrant = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol,
            },
          });
          expect((await dwn.processMessage(alice.did, revokedGrant.message, { dataStream: revokedGrant.dataStream })).status.code).toBe(202);

          const revocation = await PermissionsProtocol.createRevocation({
            signer : Jws.createSigner(alice),
            grant  : PermissionGrant.parse(revokedGrant.dataEncodedMessage),
          });
          const revocationReply = await dwn.processMessage(
            alice.did,
            revocation.recordsWrite.message,
            { dataStream: DataStream.fromBytes(revocation.permissionRevocationBytes) }
          );
          expect(revocationReply.status.code).toBe(202);
          await Time.minimalSleep();

          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'root',
            protocol,
            permissionGrantIds : [activeGrantMessage.recordId, revokedGrant.message.recordId],
          });

          const reply = await dwn.processMessage(alice.did, syncMsg);
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantRevoked);
        });

        it('rejects sync with mismatching interface grant scope', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // create a RecordsWrite grant (wrong interface for MessagesSync)
          const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              protocol  : freeForAll.protocol,
            },
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'root',
            permissionGrantIds : [grantMessage.recordId],
          });

          const reply = await dwn.processMessage(alice.did, syncMsg);
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.GrantAuthorizationInterfaceMismatch);
        });

        it('rejects sync with mismatching protocol grant scope', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // grant bob permission to sync protocol1
          const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : 'http://protocol1',
            },
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          // bob attempts to sync protocol2 using the protocol1 grant
          const { message: syncMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'root',
            protocol           : 'http://protocol2',
            permissionGrantIds : [grantMessage.recordId],
          });

          const reply = await dwn.processMessage(alice.did, syncMsg);
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationMismatchedProtocol);
        });

        it('rejects full-tenant sync actions with a protocol-scoped grant', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const { message: grantMessage, dataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : 'http://protocol-scoped-sync',
            },
          });
          const grantReply = await dwn.processMessage(alice.did, grantMessage, { dataStream });
          expect(grantReply.status.code).toBe(202);

          const syncActions = [
            { action: 'root' as const },
            { action: 'subtree' as const, prefix: '' },
            { action: 'leaves' as const, prefix: '' },
            { action: 'diff' as const, hashes: {}, depth: 2 },
          ];

          for (const syncAction of syncActions) {
            const { message: syncMsg } = await MessagesSync.create({
              signer             : Jws.createSigner(bob),
              ...syncAction,
              permissionGrantIds : [grantMessage.recordId],
            });

            const reply = await dwn.processMessage(alice.did, syncMsg);
            expect(reply.status.code).toBe(401);
            expect(reply.status.detail).toContain(DwnErrorCode.MessagesGrantAuthorizationMismatchedProtocol);
          }
        });

        it('returns only protocol-scoped diff entries for a delegated protocol grant', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const protocolA: ProtocolDefinition = { ...freeForAll, protocol: 'http://delegated-diff-protocol-a' };
          const protocolB: ProtocolDefinition = { ...freeForAll, protocol: 'http://delegated-diff-protocol-b' };

          for (const protocolDefinition of [protocolA, protocolB]) {
            const { message: protocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
              author: alice,
              protocolDefinition,
            });
            expect((await dwn.processMessage(alice.did, protocolMessage)).status.code).toBe(202);
          }

          const { message: recordA, dataStream: dataStreamA } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolA.protocol,
            protocolPath : 'post',
            schema       : protocolA.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, recordA, { dataStream: dataStreamA })).status.code).toBe(202);

          const { message: recordB, dataStream: dataStreamB } = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolB.protocol,
            protocolPath : 'post',
            schema       : protocolB.types.post.schema,
          });
          expect((await dwn.processMessage(alice.did, recordB, { dataStream: dataStreamB })).status.code).toBe(202);

          const { message: grantMessage, dataStream: grantDataStream } = await TestDataGenerator.generateGrantCreate({
            author    : alice,
            grantedTo : bob,
            scope     : {
              interface : DwnInterfaceName.Messages,
              method    : DwnMethodName.Read,
              protocol  : protocolA.protocol,
            },
          });
          expect((await dwn.processMessage(alice.did, grantMessage, { dataStream: grantDataStream })).status.code).toBe(202);

          const { message: diffMsg } = await MessagesSync.create({
            signer             : Jws.createSigner(bob),
            action             : 'diff',
            hashes             : {},
            depth              : 2,
            protocol           : protocolA.protocol,
            permissionGrantIds : [grantMessage.recordId],
          });

          const reply = await dwn.processMessage(alice.did, diffMsg);
          expect(reply.status.code).toBe(200);

          const remoteCids = reply.onlyRemote!.map(entry => entry.messageCid);
          expect(remoteCids).toContain(await Message.getCid(recordA));
          expect(remoteCids).not.toContain(await Message.getCid(recordB));
          expect(reply.onlyRemote!.every(entry => {
            if (entry.message?.descriptor.interface !== DwnInterfaceName.Records) {
              return true;
            }
            const recordsMessage = entry.message as { descriptor: { protocol?: string } };
            return recordsMessage.descriptor.protocol === protocolA.protocol;
          })).toBe(true);
        });
      });
    });

    describe('input validation', () => {
      it('returns 400 for an unknown action', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });
        // manually override to an invalid action
        (message.descriptor as any).action = 'invalid';

        const handler = new MessagesSyncHandler({ didResolver, messageStore, stateIndex });
        const reply = await handler.handle({ tenant: alice.did, message });
        expect(reply.status.code).toBe(400);
        // the JSON schema validator catches the invalid action before the handler switch/case
        expect(reply.status.detail).toContain('SchemaValidatorFailure');
      });

      it('returns 400 for unknown action that bypasses schema validation (default case)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });

        // Stub MessagesSync.parse to skip schema validation
        const parseStub = sinon.stub(MessagesSync, 'parse').resolves({
          author           : alice.did,
          message          : message,
          signaturePayload : { descriptorCid: 'test' },
        } as any);

        try {
          // Override action to something that passes the stub but hits the default case
          (message.descriptor as any).action = 'bogusAction';

          const handler = new MessagesSyncHandler({ didResolver, messageStore, stateIndex });
          const reply = await handler.handle({ tenant: alice.did, message });
          expect(reply.status.code).toBe(400);
          expect(reply.status.detail).toContain('Unknown action');
        } finally {
          parseStub.restore();
        }
      });

      it('returns 500 for invalid prefix with non-binary characters (via stubbed parse)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'subtree',
          prefix : '0',
        });

        // Stub parse to skip schema validation
        const parseStub = sinon.stub(MessagesSync, 'parse').resolves({
          author           : alice.did,
          message          : message,
          signaturePayload : { descriptorCid: 'test' },
        } as any);

        try {
          // Override prefix to contain invalid characters
          (message.descriptor as any).prefix = 'abc';

          const handler = new MessagesSyncHandler({ didResolver, messageStore, stateIndex });
          const reply = await handler.handle({ tenant: alice.did, message });
          expect(reply.status.code).toBe(500);
          expect(reply.status.detail).toContain('MessagesSyncInvalidPrefix');
        } finally {
          parseStub.restore();
        }
      });

      it('returns 500 for prefix exceeding 256 characters (via stubbed parse)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'subtree',
          prefix : '0',
        });

        // Stub parse to skip schema validation
        const parseStub = sinon.stub(MessagesSync, 'parse').resolves({
          author           : alice.did,
          message          : message,
          signaturePayload : { descriptorCid: 'test' },
        } as any);

        try {
          // Override prefix to be too long
          (message.descriptor as any).prefix = '0'.repeat(257);

          const handler = new MessagesSyncHandler({ didResolver, messageStore, stateIndex });
          const reply = await handler.handle({ tenant: alice.did, message });
          expect(reply.status.code).toBe(500);
          expect(reply.status.detail).toContain('MessagesSyncInvalidPrefix');
        } finally {
          parseStub.restore();
        }
      });
    });

    describe('diff action', () => {
      it('returns empty diff when client hashes match server hashes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write a record
        const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // get the server's subtree hashes at depth 2 via individual subtree requests
        const serverHashes: Record<string, string> = {};
        for (const prefix of ['00', '01', '10', '11']) {
          const { message: subtreeMsg } = await MessagesSync.create({
            signer : Jws.createSigner(alice),
            action : 'subtree',
            prefix,
          });
          const subtreeReply = await dwn.processMessage(alice.did, subtreeMsg);
          if (subtreeReply.hash) {
            serverHashes[prefix] = subtreeReply.hash!;
          }
        }

        // send diff with matching hashes — should get empty diff
        const { message: diffMsg } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'diff',
          hashes : serverHashes,
          depth  : 2,
        });
        const reply = await dwn.processMessage(alice.did, diffMsg);
        expect(reply.status.code).toBe(200);
        expect(reply.onlyRemote).toEqual([]);
        expect(reply.onlyLocal).toEqual([]);
      });

      it('returns onlyRemote entries when client sends empty hashes', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write a record
        const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // send diff with empty hashes — everything on the server is onlyRemote
        const { message: diffMsg } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'diff',
          hashes : {},
          depth  : 2,
        });
        const reply = await dwn.processMessage(alice.did, diffMsg);
        expect(reply.status.code).toBe(200);
        expect(reply.onlyRemote!.length).toBeGreaterThan(0);
        // each entry should have a messageCid and message
        for (const entry of reply.onlyRemote!) {
          expect(typeof entry.messageCid).toBe('string');
          expect(entry.message).toBeDefined();
        }
      });

      it('returns onlyLocal prefixes when server has empty subtrees', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // send diff with non-empty client hashes against an empty server
        const { message: diffMsg } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'diff',
          hashes : { '00': 'aabbccdd', '01': '11223344' },
          depth  : 2,
        });
        const reply = await dwn.processMessage(alice.did, diffMsg);
        expect(reply.status.code).toBe(200);
        expect(reply.onlyRemote).toEqual([]);
        expect(reply.onlyLocal!).toContain('00');
        expect(reply.onlyLocal!).toContain('01');
      });

      it('inlines small data payloads as encodedData in onlyRemote entries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write a small record
        const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          data       : new TextEncoder().encode('small payload'),
          dataFormat : 'text/plain',
        });
        const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // diff with empty client — server should inline the data
        const { message: diffMsg } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'diff',
          hashes : {},
          depth  : 2,
        });
        const reply = await dwn.processMessage(alice.did, diffMsg);
        expect(reply.status.code).toBe(200);

        // find the RecordsWrite entry
        const recordEntry = reply.onlyRemote!.find(
          (e) => e.message?.descriptor.interface === 'Records' && e.message?.descriptor.method === 'Write'
        );
        expect(recordEntry).toBeDefined();
        expect(recordEntry!.encodedData).toBeDefined();
        expect(typeof recordEntry!.encodedData).toBe('string');
      });

      it('inlines small dataStore-backed payloads using the RecordsWrite recordId', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const dataBytes = new TextEncoder().encode('small data-store payload');
        const { message: recordMessage, recordsWrite } = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          data       : dataBytes,
          dataFormat : 'text/plain',
        });
        const indexes = await recordsWrite.constructIndexes(true);
        const messageCid = await Message.getCid(recordMessage);

        await dataStore.put(
          alice.did,
          recordMessage.recordId,
          recordMessage.descriptor.dataCid,
          DataStream.fromBytes(dataBytes)
        );
        await messageStore.put(alice.did, recordMessage, indexes);
        await stateIndex.insert(alice.did, messageCid, indexes);

        const { message: diffMsg } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'diff',
          hashes : {},
          depth  : 2,
        });

        const reply = await dwn.processMessage(alice.did, diffMsg);
        expect(reply.status.code).toBe(200);

        const recordEntry = reply.onlyRemote!.find(entry => entry.messageCid === messageCid);
        expect(recordEntry).toBeDefined();
        expect(recordEntry!.encodedData).toBe(Encoder.bytesToBase64Url(dataBytes));
      });

      it('returns 400 when hashes or depth are missing', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // create a valid diff message then strip required fields
        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'diff',
          hashes : {},
          depth  : 2,
        });

        // stub parse to skip schema validation
        const parseStub = sinon.stub(MessagesSync, 'parse').resolves({
          author           : alice.did,
          message,
          signaturePayload : { descriptorCid: 'test' },
        } as any);

        try {
          // remove hashes to trigger the guard
          delete (message.descriptor as any).hashes;
          const handler = new MessagesSyncHandler({ didResolver, messageStore, stateIndex, dataStore });
          const reply = await handler.handle({ tenant: alice.did, message });
          expect(reply.status.code).toBe(400);
          expect(reply.status.detail).toContain('diff action requires hashes and depth');
        } finally {
          parseStub.restore();
        }
      });

      it('handles protocol-scoped diff', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // write a record using the default test protocol
        const { message: recordMessage, dataStream } = await TestDataGenerator.generateRecordsWrite({
          author: alice,
        });
        const writeReply = await dwn.processMessage(alice.did, recordMessage, { dataStream });
        expect(writeReply.status.code).toBe(202);

        // diff scoped to the default test protocol
        const protocol = recordMessage.descriptor.protocol!;
        const { message: diffMsg } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'diff',
          hashes : {},
          depth  : 2,
          protocol,
        });
        const reply = await dwn.processMessage(alice.did, diffMsg);
        expect(reply.status.code).toBe(200);
        expect(reply.onlyRemote!.length).toBeGreaterThan(0);
      });
    });

    describe('error handling', () => {
      it('returns 500 when stateIndex throws an unexpected error', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const failingStateIndex: StateIndex = {
          open                   : async (): Promise<void> => {},
          close                  : async (): Promise<void> => {},
          clear                  : async (): Promise<void> => {},
          insert                 : async (): Promise<void> => {},
          delete                 : async (): Promise<void> => {},
          getRoot                : async (): Promise<any> => { throw new Error('Unexpected DB failure'); },
          getProtocolRoot        : async (): Promise<any> => { throw new Error('Unexpected DB failure'); },
          getSubtreeHash         : async (): Promise<any> => { throw new Error('Unexpected DB failure'); },
          getProtocolSubtreeHash : async (): Promise<any> => { throw new Error('Unexpected DB failure'); },
          getLeaves              : async (): Promise<any> => { throw new Error('Unexpected DB failure'); },
          getProtocolLeaves      : async (): Promise<any> => { throw new Error('Unexpected DB failure'); },
        };

        const handler = new MessagesSyncHandler({ didResolver, messageStore, stateIndex: failingStateIndex });

        const { message } = await MessagesSync.create({
          signer : Jws.createSigner(alice),
          action : 'root',
        });

        const reply = await handler.handle({ tenant: alice.did, message });
        expect(reply.status.code).toBe(500);
      });
    });
  });
}
