import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { DataStore, MessageStore, ModuleDefinition, ModuleRuleSet, ResumableTaskStore } from '../../src/index.js';

import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../../src/types/encryption-types.js';
import freeForAll from '../vectors/module-definitions/free-for-all.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { PermissionsModule } from '../../src/modules/permissions.js';
import { RecordsCount } from '../../src/interfaces/records-count.js';
import { RecordsQuery } from '../../src/interfaces/records-query.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import threadRoleModuleDefinition from '../vectors/module-definitions/thread-role.json' with { type: 'json' };
import { createAudienceControlWrite, createDeliveryControlWrite, grantModulePathWriteAccess, installEncryptedModule, processControlWrite } from '../utils/encryption-control-test-utils.js';
import { defaultTestModuleDefinition, TestDataGenerator } from '../utils/test-data-generator.js';
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
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

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

      it('should keep broad module counts on the indexed count path when no audience records exist', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const moduleDefinition: ModuleDefinition = {
          module    : 'http://encryption-control-count-indexed-broad.xyz',
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
        const moduleConfigure = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        expect((await dwn.processMessage(alice.did, moduleConfigure.message)).status.code).toBe(202);

        const write = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          dataFormat : 'application/json',
          module     : moduleDefinition.module,
          modulePath : 'message',
          schema     : 'http://message-schema',
        });
        expect((await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream })).status.code).toBe(202);

        const querySpy = sinon.spy(messageStore, 'query');
        const count = await RecordsCount.create({
          filter : { module: moduleDefinition.module },
          signer : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, count.message);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(1);
        expect(querySpy.called).toBe(false);
      });

      it('should allow anonymous count of published records', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

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

      it('should match Query visibility for anonymous and owner-delegated reads', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const delegate = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

        const publishedWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, published: true });
        const unpublishedWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, published: false });
        expect((await dwn.processMessage(
          alice.did, publishedWrite.message, { dataStream: publishedWrite.dataStream }
        )).status.code).toBe(202);
        expect((await dwn.processMessage(
          alice.did, unpublishedWrite.message, { dataStream: unpublishedWrite.dataStream }
        )).status.code).toBe(202);

        const delegatedGrant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : delegate,
          delegated : true,
          scope     : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            module    : defaultTestModuleDefinition.module,
          },
        });
        expect((await dwn.processMessage(
          alice.did, delegatedGrant.message, { dataStream: delegatedGrant.dataStream }
        )).status.code).toBe(202);

        const filter = { module: defaultTestModuleDefinition.module };
        const anonymousCount = await RecordsCount.create({ filter });
        const anonymousQuery = await RecordsQuery.create({ filter });
        const delegatedCount = await RecordsCount.create({
          delegatedGrant : delegatedGrant.dataEncodedMessage,
          filter,
          signer         : Jws.createSigner(delegate),
        });
        const delegatedQuery = await RecordsQuery.create({
          delegatedGrant : delegatedGrant.dataEncodedMessage,
          filter,
          signer         : Jws.createSigner(delegate),
        });

        const anonymousCountReply = await dwn.processMessage(alice.did, anonymousCount.message);
        const anonymousQueryReply = await dwn.processMessage(alice.did, anonymousQuery.message);
        const delegatedCountReply = await dwn.processMessage(alice.did, delegatedCount.message);
        const delegatedQueryReply = await dwn.processMessage(alice.did, delegatedQuery.message);

        expect(anonymousCountReply.status.code).toBe(200);
        expect(anonymousQueryReply.status.code).toBe(200);
        expect(anonymousQueryReply.entries?.map(entry => entry.recordId)).toEqual([publishedWrite.message.recordId]);
        expect(anonymousCountReply.count).toBe(anonymousQueryReply.entries?.length);
        expect(anonymousCountReply.count).toBe(1);
        expect(delegatedCountReply.status.code).toBe(200);
        expect(delegatedQueryReply.status.code).toBe(200);
        expect(delegatedQueryReply.entries?.map(entry => entry.recordId)).toEqual(expect.arrayContaining([
          publishedWrite.message.recordId,
          unpublishedWrite.message.recordId,
        ]));
        expect(delegatedCountReply.count).toBe(delegatedQueryReply.entries?.length);
        expect(delegatedCountReply.count).toBe(2);
      });

      it('should return 0 for anonymous count when no published records exist', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

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
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

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

        const moduleDefinition: ModuleDefinition = {
          module    : 'http://encryption-control-count-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedModule(dwn, alice, moduleDefinition);
        const audience = await createAudienceControlWrite({
          author      : alice,
          module      : moduleDefinition.module,
          rolePath    : 'member',
          roleRuleSet : encryptedDefinition.structure.member as ModuleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const exactCount = await RecordsCount.create({
          filter: {
            module     : moduleDefinition.module,
            modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags       : {
              module    : moduleDefinition.module,
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
          filter : { module: moduleDefinition.module },
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

        const moduleDefinition: ModuleDefinition = {
          module    : 'http://encryption-control-count-current-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role: true,
            },
          },
        };
        const encryptedDefinition = await installEncryptedModule(dwn, alice, moduleDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ModuleRuleSet;
        const bobGrantId = await grantModulePathWriteAccess({
          dwn,
          grantee    : bob,
          module     : moduleDefinition.module,
          modulePath : 'member',
          tenant     : alice,
        });
        const carolGrantId = await grantModulePathWriteAccess({
          dwn,
          grantee    : carol,
          module     : moduleDefinition.module,
          modulePath : 'member',
          tenant     : alice,
        });
        const nonTenantAudience = await createAudienceControlWrite({
          author            : bob,
          dateCreated       : Time.createOffsetTimestamp({ seconds: 1 }),
          permissionGrantId : bobGrantId,
          module            : moduleDefinition.module,
          rolePath          : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, nonTenantAudience);

        const otherNonTenantAudience = await createAudienceControlWrite({
          author            : carol,
          dateCreated       : Time.createOffsetTimestamp({ seconds: 2 }),
          permissionGrantId : carolGrantId,
          module            : moduleDefinition.module,
          rolePath          : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, otherNonTenantAudience);

        const tenantAudience = await createAudienceControlWrite({
          author      : alice,
          dateCreated : Time.createOffsetTimestamp({ seconds: 3 }),
          module      : moduleDefinition.module,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, tenantAudience);

        const tupleCount = await RecordsCount.create({
          filter: {
            module     : moduleDefinition.module,
            modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags       : {
              module    : moduleDefinition.module,
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
            module     : moduleDefinition.module,
            modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags       : {
              module    : moduleDefinition.module,
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

        const moduleReadGrant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : bob,
          delegated : true,
          scope     : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            module    : moduleDefinition.module,
          },
        });
        expect((await dwn.processMessage(alice.did, moduleReadGrant.message, { dataStream: moduleReadGrant.dataStream })).status.code).toBe(202);

        const delegatedModuleCount = await RecordsCount.create({
          delegatedGrant : moduleReadGrant.dataEncodedMessage,
          filter         : { module: moduleDefinition.module },
          signer         : Jws.createSigner(bob),
        });
        const delegatedModuleReply = await dwn.processMessage(alice.did, delegatedModuleCount.message);
        expect(delegatedModuleReply.status.code).toBe(200);
        expect(delegatedModuleReply.count).toBe(1);
      });

      it('should not count a current audience record that does not match an enumeration filter', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const moduleDefinition: ModuleDefinition = {
          module    : 'http://encryption-control-count-current-range-filter.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: {
              $role: true,
            },
          },
        };
        const encryptedDefinition = await installEncryptedModule(dwn, alice, moduleDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ModuleRuleSet;
        const bobGrantId = await grantModulePathWriteAccess({
          dwn,
          grantee    : bob,
          module     : moduleDefinition.module,
          modulePath : 'member',
          tenant     : alice,
        });
        const loserDateCreated = Time.createOffsetTimestamp({ seconds: 2 });
        const currentAudience = await createAudienceControlWrite({
          author      : alice,
          dateCreated : Time.createOffsetTimestamp({ seconds: 1 }),
          module      : moduleDefinition.module,
          rolePath    : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, currentAudience);

        const loserAudience = await createAudienceControlWrite({
          author            : bob,
          dateCreated       : loserDateCreated,
          permissionGrantId : bobGrantId,
          module            : moduleDefinition.module,
          rolePath          : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, loserAudience);

        const rangeFilter = {
          module      : moduleDefinition.module,
          modulePath  : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          dateCreated : { from: loserDateCreated },
          tags        : {
            module    : moduleDefinition.module,
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

        const moduleDefinition: ModuleDefinition = {
          module    : 'http://encryption-control-count-stale-audience.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedModule(dwn, alice, moduleDefinition);
        const audience = await createAudienceControlWrite({
          author      : alice,
          module      : moduleDefinition.module,
          rolePath    : 'member',
          roleRuleSet : encryptedDefinition.structure.member as ModuleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        await installEncryptedModule(dwn, alice, {
          ...moduleDefinition,
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
            module    : moduleDefinition.module,
          },
        });
        expect((await dwn.processMessage(alice.did, grant.message, { dataStream: grant.dataStream })).status.code).toBe(202);

        const count = await RecordsCount.create({
          delegatedGrant : grant.dataEncodedMessage,
          filter         : { module: moduleDefinition.module },
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

        const moduleDefinition: ModuleDefinition = {
          module    : 'http://encryption-control-count-delivery.xyz',
          published : false,
          types     : {
            member: { schema: 'http://member-schema', dataFormats: ['application/json'] },
          },
          structure: {
            member: { $role: true },
          },
        };
        const encryptedDefinition = await installEncryptedModule(dwn, alice, moduleDefinition);
        const roleRuleSet = encryptedDefinition.structure.member as ModuleRuleSet;
        const audience = await createAudienceControlWrite({
          author   : alice,
          module   : moduleDefinition.module,
          rolePath : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, audience);

        const roleRecord = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          data       : Encoder.stringToBytes('bob is a member'),
          dataFormat : 'application/json',
          module     : moduleDefinition.module,
          modulePath : 'member',
          recipient  : bob.did,
          schema     : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, roleRecord.message, { dataStream: roleRecord.dataStream })).status.code).toBe(202);

        const delivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          module             : moduleDefinition.module,
          recipient          : bob.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, delivery);

        const bobCount = await RecordsCount.create({
          filter : { module: moduleDefinition.module, modulePath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer : Jws.createSigner(bob),
        });
        const bobReply = await dwn.processMessage(alice.did, bobCount.message);
        expect(bobReply.status.code).toBe(200);
        expect(bobReply.count).toBe(1);

        const carolCount = await RecordsCount.create({
          filter : { module: moduleDefinition.module, modulePath: ENCRYPTION_CONTROL_DELIVERY_PATH },
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
            module    : moduleDefinition.module,
          },
        });
        expect((await dwn.processMessage(alice.did, carolGrant.message, { dataStream: carolGrant.dataStream })).status.code).toBe(202);

        const delegatedCarolCount = await RecordsCount.create({
          delegatedGrant : carolGrant.dataEncodedMessage,
          filter         : { module: moduleDefinition.module, modulePath: ENCRYPTION_CONTROL_DELIVERY_PATH },
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
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

        const { message: unpublished, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeReply = await dwn.processMessage(alice.did, unpublished, { dataStream });
        expect(writeReply.status.code).toBe(202);

        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface  : DwnInterfaceName.Records,
            method     : DwnMethodName.Read,
            module     : 'http://test-module.xyz',
            modulePath : 'testRecord',
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        const { message } = await TestDataGenerator.generateRecordsCount({
          author : bob,
          filter : {
            module     : 'http://test-module.xyz',
            modulePath : 'testRecord',
            published  : false,
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
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

        const permissionGrant = await PermissionsModule.createGrant({
          signer      : Jws.createSigner(alice),
          grantedTo   : bob.did,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
          scope       : {
            interface  : DwnInterfaceName.Records,
            method     : DwnMethodName.Read,
            module     : 'http://test-module.xyz',
            modulePath : 'testRecord',
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        for (const filter of [
          { published: false },
          { module: 'http://other-module.xyz', modulePath: 'testRecord', published: false },
        ]) {
          const { message } = await TestDataGenerator.generateRecordsCount({
            author            : bob,
            filter,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const reply = await dwn.processMessage(alice.did, message);
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationQueryOrSubscribeModuleScopeMismatch);
        }
      });

      it('should only count published records for non-owner with published filter', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestModule(dwn, alice);

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

      it('should count module records with role-based authorization', async () => {
        // Scenario: Alice installs a thread module, Bob is a thread participant,
        // Bob uses his role to count chat messages.
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

        const moduleDefinition = threadRoleModuleDefinition as ModuleDefinition;
        const module = moduleDefinition.module;

        // alice installs module
        const { message: moduleConfig } = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        const configReply = await dwn.processMessage(alice.did, moduleConfig);
        expect(configReply.status.code).toBe(202);

        // alice creates a thread
        const { message: threadWrite, dataStream: threadStream } = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module,
          modulePath : 'thread',
        });
        const threadReply = await dwn.processMessage(alice.did, threadWrite, { dataStream: threadStream });
        expect(threadReply.status.code).toBe(202);

        // alice adds bob as a participant
        const { message: participantWrite, dataStream: participantStream } = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module,
          modulePath      : 'thread/participant',
          parentContextId : threadWrite.contextId,
        });
        const participantReply = await dwn.processMessage(alice.did, participantWrite, { dataStream: participantStream });
        expect(participantReply.status.code).toBe(202);

        // alice writes 3 chat messages
        for (let i = 0; i < 3; i++) {
          const { message: chatWrite, dataStream: chatStream } = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            module,
            modulePath      : 'thread/chat',
            parentContextId : threadWrite.contextId,
          });
          const chatReply = await dwn.processMessage(alice.did, chatWrite, { dataStream: chatStream });
          expect(chatReply.status.code).toBe(202);
        }

        // bob counts chat messages using his participant role
        const { message: countMessage } = await TestDataGenerator.generateRecordsCount({
          author     : bob,
          filter     : { module, modulePath: 'thread/chat', contextId: threadWrite.contextId },
          moduleRole : 'thread/participant',
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

      it('should reject role-authorized count without modulePath in filter', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // create a count message with moduleRole but no modulePath in the filter
        const { message } = await TestDataGenerator.generateRecordsCount({
          author     : alice,
          filter     : { module: 'http://example.com/module' },
          moduleRole : 'thread/participant',
        });

        // the handler calls parse() which should reject this
        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(400);
      });

      it('should count all records with a free-for-all module', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

        const moduleDefinition = freeForAll as ModuleDefinition;
        const module = moduleDefinition.module;

        // alice installs module
        const { message: moduleConfig } = await TestDataGenerator.generateModulesConfigure({
          author: alice,
          moduleDefinition,
        });
        const configReply = await dwn.processMessage(alice.did, moduleConfig);
        expect(configReply.status.code).toBe(202);

        // bob writes 2 posts
        for (let i = 0; i < 2; i++) {
          const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({
            author     : bob,
            module,
            modulePath : 'post',
            schema     : moduleDefinition.types.post.schema,
            dataFormat : moduleDefinition.types.post.dataFormats![0],
          });
          const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
          expect(writeReply.status.code).toBe(202);
        }

        // alice (owner) counts all module posts
        const { message: countMessage } = await TestDataGenerator.generateRecordsCount({
          author : alice,
          filter : { module, modulePath: 'post' }
        });
        const reply = await dwn.processMessage(alice.did, countMessage);

        expect(reply.status.code).toBe(200);
        expect(reply.count).toBe(2);
      });
    });
  });
}
