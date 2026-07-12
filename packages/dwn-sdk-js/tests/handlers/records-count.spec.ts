import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ProtocolDefinition, ProtocolRuleSet, ResumableTaskStore } from '../../src/index.js';

import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../../src/types/encryption-types.js';
import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { PermissionsProtocol } from '../../src/protocols/permissions.js';
import { RecordsCount } from '../../src/interfaces/records-count.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };
import { createAudienceControlWrite, createDeliveryControlWrite, installEncryptedProtocol, processControlWrite } from '../utils/encryption-control-test-utils.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Time } from '../../src/index.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH } from '../../src/core/constants.js';

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

      it('should omit an updated record with no initial write from Count just as Query does', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://missing-initial-write-count.example';
        const healthyWrite1 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });
        expect((await dwn.processMessage(alice.did, healthyWrite1.message, { dataStream: healthyWrite1.dataStream })).status.code).toBe(202);

        const incompleteWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });
        expect((await dwn.processMessage(alice.did, incompleteWrite.message, { dataStream: incompleteWrite.dataStream })).status.code).toBe(202);
        const incompleteUpdate = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : incompleteWrite.recordsWrite,
        });
        expect((await dwn.processMessage(alice.did, incompleteUpdate.message, { dataStream: incompleteUpdate.dataStream })).status.code).toBe(202);
        await messageStore.delete(alice.did, await Message.getCid(incompleteWrite.message));

        const healthyWrite2 = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });
        expect((await dwn.processMessage(alice.did, healthyWrite2.message, { dataStream: healthyWrite2.dataStream })).status.code).toBe(202);

        const warnSpy = sinon.stub(console, 'warn');
        const count = await TestDataGenerator.generateRecordsCount({ author: alice, filter: { schema } });
        const countReply = await dwn.processMessage(alice.did, count.message);
        const query = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { schema } });
        const queryReply = await dwn.processMessage(alice.did, query.message);

        expect(countReply.status.code).toBe(200);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries!.map(entry => entry.recordId).sort()).toEqual([
          healthyWrite1.message.recordId,
          healthyWrite2.message.recordId,
        ].sort());
        expect(countReply.count).toBe(queryReply.entries!.length);
        expect(countReply.count).toBe(2);
        expect(warnSpy.getCalls().some(call =>
          String(call.args[0]).includes(DwnErrorCode.RecordsWriteGetInitialWriteNotFound) &&
          String(call.args[0]).includes('RecordsCount') &&
          String(call.args[0]).includes(incompleteWrite.message.recordId)
        )).toBe(true);
      });

      it('should count one logical record while its initial write and update are both marked latest', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const schema = 'http://two-latest-writes-count.example';
        const initialWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });
        expect((await dwn.processMessage(alice.did, initialWrite.message, { dataStream: initialWrite.dataStream })).status.code).toBe(202);

        const update = await TestDataGenerator.generateFromRecordsWrite({
          author        : alice,
          existingWrite : initialWrite.recordsWrite,
        });
        await messageStore.put(alice.did, update.message, await update.recordsWrite.constructIndexes(true));

        const count = await TestDataGenerator.generateRecordsCount({ author: alice, filter: { schema } });
        const reply = await dwn.processMessage(alice.did, count.message);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(1);
      });

      it('should keep broad protocol counts correct when no audience records exist', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-count-indexed-broad.xyz',
          published : false,
          types     : {
            message: { schema: 'http://message-schema', dataFormats: ['application/json'] },
          },
          structure: {
            message: {
              $actions: [{ who: 'anyone', can: ['create', 'read'] }],
            },
          },
        };
        const protocolConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        expect((await dwn.processMessage(alice.did, protocolConfigure.message)).status.code).toBe(202);

        const write = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          dataFormat   : 'application/json',
          protocol     : protocolDefinition.protocol,
          protocolPath : 'message',
          schema       : 'http://message-schema',
        });
        expect((await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream })).status.code).toBe(202);

        const count = await RecordsCount.create({
          filter : { protocol: protocolDefinition.protocol },
          signer : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, count.message);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(1);
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

      it('should count exact-tuple audience control records without broad enumeration', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-count-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const audience = await createAudienceControlWrite({
          author      : alice,
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet : encryptedDefinition.structure.member as ProtocolRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const exactCount = await RecordsCount.create({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags         : {
              protocol  : protocolDefinition.protocol,
              rolePath  : 'member',
              contextId : '',
            },
          },
          signer: Jws.createSigner(bob),
        });
        const exactReply = await dwn.processMessage(alice.did, exactCount.message);
        expect(exactReply.status.code).toBe(200);
        expect(exactReply.count).toBe(1);

        const broadCount = await RecordsCount.create({
          filter : { protocol: protocolDefinition.protocol },
          signer : Jws.createSigner(bob),
        });
        const broadReply = await dwn.processMessage(alice.did, broadCount.message);
        expect(broadReply.status.code).toBe(200);
        expect(broadReply.count).toBe(0);
      });

      it('should count only the current audience record during tuple enumeration', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-count-current-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role    : true,
              $actions : [{ who: 'anyone', can: ['create'] }],
            },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;
        const nonTenantAudience = await createAudienceControlWrite({
          author      : bob,
          dateCreated : Time.createOffsetTimestamp({ seconds: 1 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, nonTenantAudience);

        const otherNonTenantAudience = await createAudienceControlWrite({
          author      : carol,
          dateCreated : Time.createOffsetTimestamp({ seconds: 2 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, otherNonTenantAudience);

        const tenantAudience = await createAudienceControlWrite({
          author      : alice,
          dateCreated : Time.createOffsetTimestamp({ seconds: 3 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, tenantAudience);

        const tupleCount = await RecordsCount.create({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags         : {
              protocol  : protocolDefinition.protocol,
              rolePath  : 'member',
              contextId : '',
            },
          },
          signer: Jws.createSigner(alice),
        });
        const tupleReply = await dwn.processMessage(alice.did, tupleCount.message);
        expect(tupleReply.status.code).toBe(200);
        expect(tupleReply.count).toBe(1);

        const exactLoserCount = await RecordsCount.create({
          filter: {
            protocol     : protocolDefinition.protocol,
            protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags         : {
              protocol  : protocolDefinition.protocol,
              rolePath  : 'member',
              contextId : '',
              keyId     : nonTenantAudience.keyId,
            },
          },
          signer: Jws.createSigner(bob),
        });
        const exactLoserReply = await dwn.processMessage(alice.did, exactLoserCount.message);
        expect(exactLoserReply.status.code).toBe(200);
        expect(exactLoserReply.count).toBe(1);

        const protocolReadGrant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : bob,
          delegated : true,
          scope     : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            protocol  : protocolDefinition.protocol,
          },
        });
        expect((await dwn.processMessage(alice.did, protocolReadGrant.message, { dataStream: protocolReadGrant.dataStream })).status.code).toBe(202);

        const delegatedProtocolCount = await RecordsCount.create({
          delegatedGrant : protocolReadGrant.dataEncodedMessage,
          filter         : { protocol: protocolDefinition.protocol },
          signer         : Jws.createSigner(bob),
        });
        const delegatedProtocolReply = await dwn.processMessage(alice.did, delegatedProtocolCount.message);
        expect(delegatedProtocolReply.status.code).toBe(200);
        expect(delegatedProtocolReply.count).toBe(1);
      });

      it('should not count a current audience record that does not match an enumeration filter', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-count-current-range-filter.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role    : true,
              $actions : [{ who: 'anyone', can: ['create'] }],
            },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;
        const loserDateCreated = Time.createOffsetTimestamp({ seconds: 2 });
        const currentAudience = await createAudienceControlWrite({
          author      : alice,
          dateCreated : Time.createOffsetTimestamp({ seconds: 1 }),
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, currentAudience);

        const loserAudience = await createAudienceControlWrite({
          author      : bob,
          dateCreated : loserDateCreated,
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, loserAudience);

        const rangeFilter = {
          protocol     : protocolDefinition.protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          dateCreated  : { from: loserDateCreated },
          tags         : {
            protocol  : protocolDefinition.protocol,
            rolePath  : 'member',
            contextId : '',
          },
        };
        const rangeCount = await RecordsCount.create({
          filter : rangeFilter,
          signer : Jws.createSigner(alice),
        });
        const rangeReply = await dwn.processMessage(alice.did, rangeCount.message);
        expect(rangeReply.status.code).toBe(200);
        expect(rangeReply.count).toBe(0);

        const exactLoserCount = await RecordsCount.create({
          filter: {
            ...rangeFilter,
            tags: {
              ...rangeFilter.tags,
              keyId: loserAudience.keyId,
            },
          },
          signer: Jws.createSigner(alice),
        });
        const exactLoserReply = await dwn.processMessage(alice.did, exactLoserCount.message);
        expect(exactLoserReply.status.code).toBe(200);
        expect(exactLoserReply.count).toBe(1);
      });

      it('should hide stale audience control records from delegated broad counts', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-count-stale-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const audience = await createAudienceControlWrite({
          author      : alice,
          protocol    : protocolDefinition.protocol,
          rolePath    : 'member',
          roleRuleSet : encryptedDefinition.structure.member as ProtocolRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        await installEncryptedProtocol(dwn, alice, {
          ...protocolDefinition,
          structure: {
            member: {},
          },
        });

        const grant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : bob,
          delegated : true,
          scope     : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            protocol  : protocolDefinition.protocol,
          },
        });
        expect((await dwn.processMessage(alice.did, grant.message, { dataStream: grant.dataStream })).status.code).toBe(202);

        const count = await RecordsCount.create({
          delegatedGrant : grant.dataEncodedMessage,
          filter         : { protocol: protocolDefinition.protocol },
          signer         : Jws.createSigner(bob),
        });
        const reply = await dwn.processMessage(alice.did, count.message);
        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(0);
      });

      it('should count delivery control records only for the recipient', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-count-delivery.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedProtocol(dwn, alice, protocolDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ProtocolRuleSet;
        const audience = await createAudienceControlWrite({
          author   : alice,
          protocol : protocolDefinition.protocol,
          rolePath : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const roleRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          data         : Encoder.stringToBytes('bob is a member'),
          dataFormat   : 'application/json',
          protocol     : protocolDefinition.protocol,
          protocolPath : 'member',
          recipient    : bob.did,
          schema       : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, roleRecord.message, { dataStream: roleRecord.dataStream })).status.code).toBe(202);

        const delivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          protocol           : protocolDefinition.protocol,
          recipient          : bob.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, delivery);

        const bobCount = await RecordsCount.create({
          filter : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer : Jws.createSigner(bob),
        });
        const bobReply = await dwn.processMessage(alice.did, bobCount.message);
        expect(bobReply.status.code).toBe(200);
        expect(bobReply.count).toBe(1);

        const carolCount = await RecordsCount.create({
          filter : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer : Jws.createSigner(carol),
        });
        const carolReply = await dwn.processMessage(alice.did, carolCount.message);
        expect(carolReply.status.code).toBe(200);
        expect(carolReply.count).toBe(0);

        const carolGrant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : carol,
          delegated : true,
          scope     : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            protocol  : protocolDefinition.protocol,
          },
        });
        expect((await dwn.processMessage(alice.did, carolGrant.message, { dataStream: carolGrant.dataStream })).status.code).toBe(202);

        const delegatedCarolCount = await RecordsCount.create({
          delegatedGrant : carolGrant.dataEncodedMessage,
          filter         : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer         : Jws.createSigner(carol),
        });
        const delegatedCarolReply = await dwn.processMessage(alice.did, delegatedCarolCount.message);
        expect(delegatedCarolReply.status.code).toBe(200);
        expect(delegatedCarolReply.count).toBe(0);
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
            method       : DwnMethodName.Read,
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
            method       : DwnMethodName.Read,
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
