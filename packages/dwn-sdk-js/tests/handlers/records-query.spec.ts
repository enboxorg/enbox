import type { DidResolver } from '@enbox/dids';
import type { DataStore, EventLog, GenericMessage, MessageStore, ProtocolDefinition, ProtocolRuleSet, RecordsWriteMessage, ResumableTaskStore } from '../../src/index.js';
import type { RecordsQueryReply, RecordsQueryReplyEntry, RecordsWriteDescriptor } from '../../src/types/records-types.js';

import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import freeForAll from '../vectors/protocol-definitions/free-for-all.json' with { type: 'json' };
import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' with { type: 'json' };
import nestedProtocol from '../vectors/protocol-definitions/nested.json' with { type: 'json' };
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' with { type: 'json' };

import { ArrayUtility } from '../../src/utils/array.js';
import { DataStream } from '../../src/utils/data-stream.js';
import { DateSort } from '../../src/types/records-types.js';
import { DwnConstant } from '../../src/core/dwn-constant.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../../src/types/encryption-types.js';
import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { PermissionsProtocol } from '../../src/protocols/permissions.js';
import { RecordsQuery } from '../../src/interfaces/records-query.js';
import { RecordsQueryHandler } from '../../src/handlers/records-query.js';
import { RecordsWriteHandler } from '../../src/handlers/records-write.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { CoreProtocolRegistry, Dwn, ProtocolsConfigure, RecordsWrite, Time } from '../../src/index.js';
import { createAudienceControlWrite, createDeliveryControlWrite, installEncryptedProtocol, processControlWrite } from '../utils/encryption-control-test-utils.js';
import { DataStoreLevel, MessageStoreLevel } from '../../src/store/level.js';
import { defaultTestProtocolDefinition, TestDataGenerator } from '../utils/test-data-generator.js';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from '../../src/enums/dwn-interface-method.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH } from '../../src/core/constants.js';

import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';

export function testRecordsQueryHandler(): void {
  describe('RecordsQueryHandler.handle()', () => {

    beforeEach(() => {
      sinon.restore(); // wipe all previous stubs/spies/mocks/fakes
    });

    describe('functional tests', () => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let dataStore: DataStore;
      let resumableTaskStore: ResumableTaskStore;
      let eventLog: EventLog;
      let dwn: Dwn;

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      beforeAll(async () => {
        didResolver = new UniversalResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        resumableTaskStore = stores.resumableTaskStore;
        eventLog = TestEventLog.get();
        eventLog = TestEventLog.get();

        dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, resumableTaskStore });
      });

      beforeEach(async () => {
        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await resumableTaskStore.clear();
      });

      afterAll(async () => {
        await dwn.close();
      });

      it('should reject when published is set to false with a dateSort set to sorting by `PublishedAscending` or `PublishedDescending`', async () => {
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        const query = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { published: false } });

        //control
        let reply = await dwn.processMessage(alice.did, query.message);
        expect(reply.status.code).toBe(200);

        // modify dateSort to publishedAscending
        query.message.descriptor.dateSort = DateSort.PublishedAscending;
        reply = await dwn.processMessage(alice.did, query.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain('queries must not filter for `published:false` and sort');

        // modify dateSort to publishedDescending
        query.message.descriptor.dateSort = DateSort.PublishedDescending;
        reply = await dwn.processMessage(alice.did, query.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain('queries must not filter for `published:false` and sort');
      });

      it('should return recordId, descriptor, authorization and attestation', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const dataFormat = 'myAwesomeDataFormat';

        const write = await TestDataGenerator.generateRecordsWrite({ author: alice, attesters: [bob], dataFormat });
        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        const query = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { dataFormat } });
        const reply = await dwn.processMessage(alice.did, query.message);

        expect(reply.entries?.length).toBe(1);
        const entry = reply.entries![0];
        expect(entry.authorization).toEqual(write.message.authorization);
        expect(entry.attestation).toEqual(write.message.attestation);
        expect(entry.descriptor).toEqual(write.message.descriptor);
        expect(entry.recordId).toBe(write.message.recordId);
      });

      it('should return records matching the query', async () => {
      // insert three messages into DB, two with matching protocol
        const alice = await TestDataGenerator.generatePersona();
        const dataFormat = 'myAwesomeDataFormat';
        const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, dataFormat, schema: 'schema1' });
        const write3 = await TestDataGenerator.generateRecordsWrite({ author: alice, dataFormat, schema: 'schema2' });

        // setting up a stub resolver
        const mockResolution = TestDataGenerator.createDidResolutionResult(alice);;
        sinon.stub(didResolver, 'resolve').resolves(mockResolution);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // testing singular conditional query
        const messageData = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { dataFormat } });

        const reply = await dwn.processMessage(alice.did, messageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(2); // only 2 entries should match the query on protocol

        // testing multi-conditional query, reuse data generated above for bob
        const messageData2 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            dataFormat,
            schema: 'schema1'
          }
        });

        const reply2 = await dwn.processMessage(alice.did, messageData2.message);

        expect(reply2.status.code).toBe(200);
        expect(reply2.entries?.length).toBe(1); // only 1 entry should match the query
      });

      it('should allow exact-tuple audience control queries without broad enumeration', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-query-audience.xyz',
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

        const exactQuery = await RecordsQuery.create({
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
        const exactReply = await dwn.processMessage(alice.did, exactQuery.message);
        expect(exactReply.status.code).toBe(200);
        expect(exactReply.entries?.map(entry => entry.recordId)).toEqual([audience.recordsWrite.message.recordId]);

        const broadQuery = await RecordsQuery.create({
          filter : { protocol: protocolDefinition.protocol },
          signer : Jws.createSigner(bob),
        });
        const broadReply = await dwn.processMessage(alice.did, broadQuery.message);
        expect(broadReply.status.code).toBe(200);
        expect(broadReply.entries?.map(entry => entry.recordId)).not.toContain(audience.recordsWrite.message.recordId);
      });

      it('should allow grant-backed audience control enumeration', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-query-grant-enumeration.xyz',
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

        const grant = await TestDataGenerator.generateGrantCreate({
          author    : alice,
          grantedTo : bob,
          scope     : {
            interface : DwnInterfaceName.Records,
            method    : DwnMethodName.Read,
            protocol  : protocolDefinition.protocol,
          },
        });
        expect((await dwn.processMessage(alice.did, grant.message, { dataStream: grant.dataStream })).status.code).toBe(202);

        const query = await RecordsQuery.create({
          filter            : { protocol: protocolDefinition.protocol },
          permissionGrantId : grant.message.recordId,
          signer            : Jws.createSigner(bob),
        });
        const reply = await dwn.processMessage(alice.did, query.message);
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.map(entry => entry.recordId)).toContain(audience.recordsWrite.message.recordId);
      });

      it('should hide stale audience control records from delegated broad queries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-query-stale-audience.xyz',
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

        const query = await RecordsQuery.create({
          delegatedGrant : grant.dataEncodedMessage,
          filter         : { protocol: protocolDefinition.protocol },
          signer         : Jws.createSigner(bob),
        });
        const reply = await dwn.processMessage(alice.did, query.message);
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.map(entry => entry.recordId)).not.toContain(audience.recordsWrite.message.recordId);
      });

      it('should return delivery control records only to the recipient', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition: ProtocolDefinition = {
          protocol  : 'http://encryption-control-query-delivery.xyz',
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

        const bobQuery = await RecordsQuery.create({
          filter : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer : Jws.createSigner(bob),
        });
        const bobReply = await dwn.processMessage(alice.did, bobQuery.message);
        expect(bobReply.status.code).toBe(200);
        expect(bobReply.entries?.map(entry => entry.recordId)).toContain(delivery.recordsWrite.message.recordId);

        const carolQuery = await RecordsQuery.create({
          filter : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer : Jws.createSigner(carol),
        });
        const carolReply = await dwn.processMessage(alice.did, carolQuery.message);
        expect(carolReply.status.code).toBe(200);
        expect(carolReply.entries?.map(entry => entry.recordId)).not.toContain(delivery.recordsWrite.message.recordId);

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

        const delegatedCarolQuery = await RecordsQuery.create({
          delegatedGrant : carolGrant.dataEncodedMessage,
          filter         : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          signer         : Jws.createSigner(carol),
        });
        const delegatedCarolReply = await dwn.processMessage(alice.did, delegatedCarolQuery.message);
        expect(delegatedCarolReply.status.code).toBe(200);
        expect(delegatedCarolReply.entries?.map(entry => entry.recordId)).not.toContain(delivery.recordsWrite.message.recordId);

        const carolRoleRecord = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          data         : Encoder.stringToBytes('carol is a member'),
          dataFormat   : 'application/json',
          protocol     : protocolDefinition.protocol,
          protocolPath : 'member',
          recipient    : carol.did,
          schema       : 'http://member-schema',
        });
        expect((await dwn.processMessage(alice.did, carolRoleRecord.message, { dataStream: carolRoleRecord.dataStream })).status.code).toBe(202);

        const carolDelivery = await createDeliveryControlWrite({
          author             : alice,
          keyId              : audience.keyId,
          protocol           : protocolDefinition.protocol,
          recipient          : carol.did,
          recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
          rolePath           : 'member',
          roleRuleSet,
        });
        await processControlWrite(dwn, alice.did, carolDelivery);

        const pagedDelegatedCarolQuery = await RecordsQuery.create({
          dateSort       : DateSort.CreatedAscending,
          delegatedGrant : carolGrant.dataEncodedMessage,
          filter         : { protocol: protocolDefinition.protocol, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
          pagination     : { limit: 1 },
          signer         : Jws.createSigner(carol),
        });
        const pagedDelegatedCarolReply = await dwn.processMessage(alice.did, pagedDelegatedCarolQuery.message);
        expect(pagedDelegatedCarolReply.status.code).toBe(200);
        expect(pagedDelegatedCarolReply.entries?.map(entry => entry.recordId)).toEqual([carolDelivery.recordsWrite.message.recordId]);
      });

      it('should return `encodedData` if data size is within the spec threshold', async () => {
        const data = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded); // within/on threshold
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write= await TestDataGenerator.generateRecordsWrite({ author: alice, data });

        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        const messageData = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { recordId: write.message.recordId } });
        const reply = await dwn.processMessage(alice.did, messageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(1);
        expect(reply.entries![0].encodedData).toBe(Encoder.bytesToBase64Url(data));
      });

      it('should not return `encodedData` if data size is greater then spec threshold', async () => {
        const data = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1); // exceeding threshold
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write= await TestDataGenerator.generateRecordsWrite({ author: alice, data });

        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        const messageData = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { recordId: write.message.recordId } });
        const reply = await dwn.processMessage(alice.did, messageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(1);
        expect(reply.entries![0].encodedData).toBeUndefined();
      });

      it('should include `initialWrite` property if RecordsWrite is not initial write', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write = await TestDataGenerator.generateRecordsWrite({ author: alice, published: false });

        const writeReply = await dwn.processMessage(alice.did, write.message, { dataStream: write.dataStream });
        expect(writeReply.status.code).toBe(202);

        // write an update to the record
        const write2 = await RecordsWrite.createFrom({ recordsWriteMessage: write.message, published: true, signer: Jws.createSigner(alice) });
        const write2Reply = await dwn.processMessage(alice.did, write2.message);
        expect(write2Reply.status.code).toBe(202);

        // make sure result returned now has `initialWrite` property
        const messageData = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { recordId: write.message.recordId } });
        const reply = await dwn.processMessage(alice.did, messageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(1);
        expect(reply.entries![0].initialWrite).toBeDefined();
        expect(reply.entries![0].initialWrite?.recordId).toBe(write.message.recordId);

      });

      it('should be able to query by attester', async () => {
      // scenario: 2 records authored by alice, 1st attested by alice, 2nd attested by bob
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const recordsWrite1 = await TestDataGenerator.generateRecordsWrite({ author: alice, attesters: [alice] });
        const recordsWrite2 = await TestDataGenerator.generateRecordsWrite({ author: alice, attesters: [bob] });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, recordsWrite1.message, { dataStream: recordsWrite1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, recordsWrite2.message, { dataStream: recordsWrite2.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);

        // testing attester filter
        const recordsQuery1 = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { attester: alice.did } });
        const reply1 = await dwn.processMessage(alice.did, recordsQuery1.message);
        expect(reply1.entries?.length).toBe(1);
        const reply1Attester = Jws.getSignerDid(reply1.entries![0].attestation!.signatures[0]);
        expect(reply1Attester).toBe(alice.did);

        // testing attester + another filter
        const recordsQuery2 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { attester: bob.did, schema: recordsWrite2.message.descriptor.schema }
        });
        const reply2 = await dwn.processMessage(alice.did, recordsQuery2.message);
        expect(reply2.entries?.length).toBe(1);
        const reply2Attester = Jws.getSignerDid(reply2.entries![0].attestation!.signatures[0]);
        expect(reply2Attester).toBe(bob.did);

        // testing attester filter that yields no results
        const carol = await TestDataGenerator.generateDidKeyPersona();
        const recordsQuery3 = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { attester: carol.did } });
        const reply3 = await dwn.processMessage(alice.did, recordsQuery3.message);
        expect(reply3.entries?.length).toBe(0);
      });

      it('should be able to query by author', async () => {
        // scenario alice and bob both author records into alice's DWN.
        // alice is able to filter for records authored by bob.
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition = freeForAll;

        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        const aliceAuthorWrite = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : protocolDefinition.protocol,
          schema       : protocolDefinition.types.post.schema,
          dataFormat   : protocolDefinition.types.post.dataFormats[0],
          protocolPath : 'post'
        });
        const aliceAuthorReply = await dwn.processMessage(alice.did, aliceAuthorWrite.message, { dataStream: aliceAuthorWrite.dataStream });
        expect(aliceAuthorReply.status.code).toBe(202);

        const bobAuthorWrite = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          protocol     : protocolDefinition.protocol,
          schema       : protocolDefinition.types.post.schema,
          dataFormat   : protocolDefinition.types.post.dataFormats[0],
          protocolPath : 'post'
        });
        const bobAuthorReply = await dwn.processMessage(alice.did, bobAuthorWrite.message, { dataStream: bobAuthorWrite.dataStream });
        expect(bobAuthorReply.status.code).toBe(202);

        // alice queries with an empty filter, gets both
        let recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        let queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(2);

        // filter for bob as author
        recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            author       : bob.did,
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(1);
        expect(queryReply.entries![0].recordId).toBe(bobAuthorWrite.message.recordId);

        // empty array for author should return all same as undefined author field
        recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            author       : [],
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(2);

        // query for both authors explicitly
        recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            author       : [alice.did, bob.did],
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(2);
      });

      it('should be able to query by recipient', async () => {
        // scenario alice authors records for bob and carol into alice's DWN.
        // bob and carol are able to filter for records for them.
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        const protocolDefinition = freeForAll;

        const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition
        });
        const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
        expect(protocolsConfigureReply.status.code).toBe(202);

        const aliceToBob = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : bob.did,
          protocol     : protocolDefinition.protocol,
          schema       : protocolDefinition.types.post.schema,
          dataFormat   : protocolDefinition.types.post.dataFormats[0],
          protocolPath : 'post'
        });
        const aliceToBobReply = await dwn.processMessage(alice.did, aliceToBob.message, { dataStream: aliceToBob.dataStream });
        expect(aliceToBobReply.status.code).toBe(202);

        const aliceToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : carol.did,
          protocol     : protocolDefinition.protocol,
          schema       : protocolDefinition.types.post.schema,
          dataFormat   : protocolDefinition.types.post.dataFormats[0],
          protocolPath : 'post'
        });
        const aliceToCarolReply = await dwn.processMessage(alice.did, aliceToCarol.message, { dataStream: aliceToCarol.dataStream });
        expect(aliceToCarolReply.status.code).toBe(202);

        // alice queries with an empty filter, gets both
        let recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        let queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(2);

        // filter for bob as recipient
        recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(1);
        expect(queryReply.entries![0].recordId).toBe(aliceToBob.message.recordId);

        // filter for carol as recipient
        recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            recipient    : carol.did,
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(1);
        expect(queryReply.entries![0].recordId).toBe(aliceToCarol.message.recordId);

        // empty array for recipient should return all same as undefined recipient field
        recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            recipient    : [],
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(2);

        // query for both recipients explicitly
        recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            recipient    : [bob.did, carol.did],
            protocol     : protocolDefinition.protocol,
            schema       : protocolDefinition.types.post.schema,
            dataFormat   : protocolDefinition.types.post.dataFormats[0],
            protocolPath : 'post'
          }
        });
        queryReply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(2);
      });

      it('should be able to query for published records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // create a published record
        const publishedWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, published: true, schema: 'post' });
        const publishedWriteReply = await dwn.processMessage(alice.did, publishedWrite.message, { dataStream: publishedWrite.dataStream });
        expect(publishedWriteReply.status.code).toBe(202);

        // create an unpublished record
        const draftWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'post' });
        const draftWriteReply = await dwn.processMessage(alice.did, draftWrite.message, { dataStream: draftWrite.dataStream });
        expect(draftWriteReply.status.code).toBe(202);

        // query for only published records
        const publishedPostQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { schema: 'post', published: true } });
        let publishedPostReply = await dwn.processMessage(alice.did, publishedPostQuery.message);
        expect(publishedPostReply.status.code).toBe(200);
        expect(publishedPostReply.entries?.length).toBe(1);
        expect(publishedPostReply.entries![0].recordId).toBe(publishedWrite.message.recordId);

        // make an query for published records from non owner
        const notOwnerPostQuery = await TestDataGenerator.generateRecordsQuery({ author: bob, filter: { schema: 'post', published: true } });
        let notOwnerPublishedPostReply = await dwn.processMessage(alice.did, notOwnerPostQuery.message);
        expect(notOwnerPublishedPostReply.status.code).toBe(200);
        expect(notOwnerPublishedPostReply.entries?.length).toBe(1);
        expect(notOwnerPublishedPostReply.entries![0].recordId).toBe(publishedWrite.message.recordId);

        // anonymous query for published records
        const anonymousPostQuery = await RecordsQuery.create({ filter: { schema: 'post', published: true } });
        let anonymousPublishedPostReply = await dwn.processMessage(alice.did, anonymousPostQuery.message);
        expect(anonymousPublishedPostReply.status.code).toBe(200);
        expect(anonymousPublishedPostReply.entries?.length).toBe(1);
        expect(anonymousPublishedPostReply.entries![0].recordId).toBe(publishedWrite.message.recordId);

        // publish the unpublished record
        const publishedDraftWrite = await RecordsWrite.createFrom({
          recordsWriteMessage : draftWrite.message,
          published           : true,
          signer              : Jws.createSigner(alice)
        });
        const publishedDraftReply = await dwn.processMessage(alice.did, publishedDraftWrite.message);
        expect(publishedDraftReply.status.code).toBe(202);

        // issue the same query for published records
        publishedPostReply = await dwn.processMessage(alice.did, publishedPostQuery.message);
        expect(publishedPostReply.status.code).toBe(200);
        expect(publishedPostReply.entries?.length).toBe(2);
        const returnedRecordIds = publishedPostReply.entries?.map(e => e.recordId);

        // ensure that both records now exist in results
        expect(returnedRecordIds).toEqual(expect.arrayContaining([ publishedWrite.message.recordId, draftWrite.message.recordId ]));

        // query after publishing from non owner
        notOwnerPublishedPostReply = await dwn.processMessage(alice.did, anonymousPostQuery.message);
        expect(notOwnerPublishedPostReply.status.code).toBe(200);
        expect(notOwnerPublishedPostReply.entries?.length).toBe(2);
        const nonOwnerReturnedRecordIds = notOwnerPublishedPostReply.entries?.map(e => e.recordId);
        expect(nonOwnerReturnedRecordIds).toEqual(expect.arrayContaining([ publishedWrite.message.recordId, draftWrite.message.recordId ]));

        // anonymous query after publishing
        anonymousPublishedPostReply = await dwn.processMessage(alice.did, anonymousPostQuery.message);
        expect(anonymousPublishedPostReply.status.code).toBe(200);
        expect(anonymousPublishedPostReply.entries?.length).toBe(2);
        const anonymousReturnedRecordIds = anonymousPublishedPostReply.entries?.map(e => e.recordId);
        expect(anonymousReturnedRecordIds).toEqual(expect.arrayContaining([ publishedWrite.message.recordId, draftWrite.message.recordId ]));
      });

      it('should be able to query for unpublished records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // create a published record
        const publishedWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, published: true, schema: 'post' });
        const publishedWriteReply = await dwn.processMessage(alice.did, publishedWrite.message, { dataStream: publishedWrite.dataStream });
        expect(publishedWriteReply.status.code).toBe(202);

        // create an unpublished record
        const draftWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'post' });
        const draftWriteReply = await dwn.processMessage(alice.did, draftWrite.message, { dataStream: draftWrite.dataStream });
        expect(draftWriteReply.status.code).toBe(202);

        // query for only unpublished records
        const unpublishedPostQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { schema: 'post', published: false } });
        let unpublishedPostReply = await dwn.processMessage(alice.did, unpublishedPostQuery.message);
        expect(unpublishedPostReply.status.code).toBe(200);
        expect(unpublishedPostReply.entries?.length).toBe(1);
        expect(unpublishedPostReply.entries![0].recordId).toBe(draftWrite.message.recordId);

        // publish the unpublished record
        const publishedDraftWrite = await RecordsWrite.createFrom({
          recordsWriteMessage : draftWrite.message,
          published           : true,
          signer              : Jws.createSigner(alice)
        });
        const publishedDraftReply = await dwn.processMessage(alice.did, publishedDraftWrite.message);
        expect(publishedDraftReply.status.code).toBe(202);

        // issue the same query for unpublished records
        unpublishedPostReply = await dwn.processMessage(alice.did, unpublishedPostQuery.message);
        expect(unpublishedPostReply.status.code).toBe(200);
        expect(unpublishedPostReply.entries?.length).toBe(0);
      });

      it('should not be able to query for unpublished records if unauthorized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // create a published record
        const publishedWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, published: true, schema: 'post' });
        const publishedWriteReply = await dwn.processMessage(alice.did, publishedWrite.message, { dataStream: publishedWrite.dataStream });
        expect(publishedWriteReply.status.code).toBe(202);

        // create an unpublished record
        const draftWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'post' });
        const draftWriteReply = await dwn.processMessage(alice.did, draftWrite.message, { dataStream: draftWrite.dataStream });
        expect(draftWriteReply.status.code).toBe(202);

        // bob queries for unpublished records returns zero
        const unpublishedNotOwner = await TestDataGenerator.generateRecordsQuery({ author: bob, filter: { schema: 'post', published: false } });
        let notOwnerPostReply = await dwn.processMessage(alice.did, unpublishedNotOwner.message);
        expect(notOwnerPostReply.status.code).toBe(200);
        expect(notOwnerPostReply.entries?.length).toBe(0);

        // publish the unpublished record
        const publishedDraftWrite = await RecordsWrite.createFrom({
          recordsWriteMessage : draftWrite.message,
          published           : true,
          signer              : Jws.createSigner(alice)
        });
        const publishedDraftReply = await dwn.processMessage(alice.did, publishedDraftWrite.message);
        expect(publishedDraftReply.status.code).toBe(202);

        // without published filter
        let publishedNotOwner = await TestDataGenerator.generateRecordsQuery({ author: bob, filter: { schema: 'post' } });
        let publishedNotOwnerReply = await dwn.processMessage(alice.did, publishedNotOwner.message);
        expect(publishedNotOwnerReply.status.code).toBe(200);
        expect(publishedNotOwnerReply.entries?.length).toBe(2);

        // with explicit published true
        publishedNotOwner = await TestDataGenerator.generateRecordsQuery({ author: bob, filter: { schema: 'post', published: true } });
        publishedNotOwnerReply = await dwn.processMessage(alice.did, publishedNotOwner.message);
        expect(publishedNotOwnerReply.status.code).toBe(200);
        expect(publishedNotOwnerReply.entries?.length).toBe(2);

        // with explicit published false after publishing should still return nothing
        notOwnerPostReply = await dwn.processMessage(alice.did, unpublishedNotOwner.message);
        expect(notOwnerPostReply.status.code).toBe(200);
        expect(notOwnerPostReply.entries?.length).toBe(0);
      });

      it('should query unpublished records authorized by permissionGrantId', async () => {
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
            protocol     : defaultTestProtocolDefinition.protocol,
            protocolPath : 'testRecord',
          }
        });
        const grantReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, {
          dataStream: DataStream.fromBytes(permissionGrant.permissionGrantBytes)
        });
        expect(grantReply.status.code).toBe(202);

        const query = await TestDataGenerator.generateRecordsQuery({
          author : bob,
          filter : {
            protocol     : defaultTestProtocolDefinition.protocol,
            protocolPath : 'testRecord',
            published    : false,
          },
          permissionGrantId: permissionGrant.recordsWrite.message.recordId,
        });

        const reply = await dwn.processMessage(alice.did, query.message);
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.map(entry => entry.recordId)).toEqual([unpublished.recordId]);
      });

      it('should reject permissionGrantId queries with filters outside the grant scope', async () => {
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
            protocol     : defaultTestProtocolDefinition.protocol,
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
          const query = await TestDataGenerator.generateRecordsQuery({
            author            : bob,
            filter,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });

          const reply = await dwn.processMessage(alice.did, query.message);
          expect(reply.status.code).toBe(401);
          expect(reply.status.detail).toContain(DwnErrorCode.RecordsGrantAuthorizationQueryOrSubscribeProtocolScopeMismatch);
        }
      });

      it('should be able to query for a record by a dataCid', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // create a record
        const writeRecord = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const writeRecordReply = await dwn.processMessage(alice.did, writeRecord.message, { dataStream: writeRecord.dataStream });
        expect(writeRecordReply.status.code).toBe(202);
        const recordDataCid = writeRecord.message.descriptor.dataCid;

        // query for the record by it's dataCid
        const dataCidQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { dataCid: recordDataCid } });
        const dataCidQueryReply = await dwn.processMessage(alice.did, dataCidQuery.message);
        expect(dataCidQueryReply.status.code).toBe(200);
        expect(dataCidQueryReply.entries?.length).toBe(1);
        expect(dataCidQueryReply.entries![0].recordId).toBe(writeRecord.message.recordId);
      });

      it('should be able to query with `dataSize` filter (half-open range)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice, data: TestDataGenerator.randomBytes(10) });
        const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, data: TestDataGenerator.randomBytes(50) });
        const write3 = await TestDataGenerator.generateRecordsWrite({ author: alice, data: TestDataGenerator.randomBytes(100) });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // testing gt
        const recordsQuery1 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { gt: 10 } },
        });
        const reply1 = await dwn.processMessage(alice.did, recordsQuery1.message);
        expect(reply1.entries?.length).toBe(2);

        expect(
          reply1.entries?.map((entry) => entry.encodedData)
        ).toEqual(expect.arrayContaining([
          Encoder.bytesToBase64Url(write2.dataBytes!),
          Encoder.bytesToBase64Url(write3.dataBytes!)
        ]));

        // testing lt
        const recordsQuery2 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { lt: 100 } },
        });
        const reply2 = await dwn.processMessage(alice.did, recordsQuery2.message);
        expect(reply2.entries?.length).toBe(2);
        expect(
          reply2.entries?.map((entry) => entry.encodedData)
        ).toEqual(expect.arrayContaining([
          Encoder.bytesToBase64Url(write1.dataBytes!),
          Encoder.bytesToBase64Url(write2.dataBytes!)
        ]));

        // testing gte
        const recordsQuery3 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { gte: 10 } },
        });
        const reply3 = await dwn.processMessage(alice.did, recordsQuery3.message);
        expect(reply3.entries?.length).toBe(3);
        expect(
          reply3.entries?.map((entry) => entry.encodedData)
        ).toEqual(expect.arrayContaining([
          Encoder.bytesToBase64Url(write1.dataBytes!),
          Encoder.bytesToBase64Url(write2.dataBytes!),
          Encoder.bytesToBase64Url(write3.dataBytes!)
        ]));

        // testing lte
        const recordsQuery4 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { lte: 100 } },
        });
        const reply4 = await dwn.processMessage(alice.did, recordsQuery4.message);
        expect(reply4.entries?.length).toBe(3);
        expect(
          reply4.entries?.map((entry) => entry.encodedData)
        ).toEqual(expect.arrayContaining([
          Encoder.bytesToBase64Url(write1.dataBytes!),
          Encoder.bytesToBase64Url(write2.dataBytes!),
          Encoder.bytesToBase64Url(write3.dataBytes!)
        ]));
      });

      it('should be able to range query with `dataSize` filter (open & closed range)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice, data: TestDataGenerator.randomBytes(10) });
        const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, data: TestDataGenerator.randomBytes(50) });
        const write3 = await TestDataGenerator.generateRecordsWrite({ author: alice, data: TestDataGenerator.randomBytes(100) });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // testing range using gt & lt
        const recordsQuery1 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { gt: 10, lt: 60 } },
        });
        const reply1 = await dwn.processMessage(alice.did, recordsQuery1.message);
        expect(reply1.entries?.length).toBe(1);
        expect(reply1.entries![0].recordId).toBe(write2.message.recordId);

        // testing range using gte & lt
        const recordsQuery2 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { gte: 10, lt: 60 } },
        });
        const reply2 = await dwn.processMessage(alice.did, recordsQuery2.message);
        expect(reply2.entries?.length).toBe(2);
        const reply2RecordIds = reply2.entries?.map(e => e.recordId);
        expect(reply2RecordIds).toEqual(expect.arrayContaining([ write1.message.recordId, write2.message.recordId ]));

        // testing range using gt & lte
        const recordsQuery3 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { gt: 50, lte: 100 } },
        });
        const reply3 = await dwn.processMessage(alice.did, recordsQuery3.message);
        expect(reply3.entries?.length).toBe(1);
        expect(reply3.entries![0].recordId).toBe(write3.message.recordId);

        // testing range using gte & lte
        const recordsQuery4 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { dataSize: { gte: 10, lte: 100 } },
        });
        const reply4 = await dwn.processMessage(alice.did, recordsQuery4.message);
        expect(reply4.entries?.length).toBe(3);
        const reply4RecordIds = reply4.entries?.map(e => e.recordId);
        expect(reply4RecordIds).toEqual(expect.arrayContaining([ write1.message.recordId, write2.message.recordId, write3.message.recordId ]));
      });

      it('should be able to range query by `dateCreated`', async () => {
        // scenario: 3 records authored by alice, created on first of 2021, 2022, and 2023 respectively
        // only the first 2 records share the same schema
        const firstDayOf2021 = Time.createTimestamp({ year: 2021, month: 1, day: 1 });
        const firstDayOf2022 = Time.createTimestamp({ year: 2022, month: 1, day: 1 });
        const firstDayOf2023 = Time.createTimestamp({ year: 2023, month: 1, day: 1 });
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write1 = await TestDataGenerator.generateRecordsWrite({ author: alice, dateCreated: firstDayOf2021, messageTimestamp: firstDayOf2021 });
        const write2 = await TestDataGenerator.generateRecordsWrite({ author: alice, dateCreated: firstDayOf2022, messageTimestamp: firstDayOf2022 });
        const write3 = await TestDataGenerator.generateRecordsWrite({ author: alice, dateCreated: firstDayOf2023, messageTimestamp: firstDayOf2023 });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // testing `from` range
        const lastDayOf2021 = Time.createTimestamp({ year: 2021, month: 12, day: 31 });
        const recordsQuery1 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateCreated: { from: lastDayOf2021 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply1 = await dwn.processMessage(alice.did, recordsQuery1.message);
        expect(reply1.entries?.length).toBe(2);
        expect(reply1.entries![0].encodedData).toBe(Encoder.bytesToBase64Url(write2.dataBytes!));
        expect(reply1.entries![1].encodedData).toBe(Encoder.bytesToBase64Url(write3.dataBytes!));

        // testing `to` range
        const lastDayOf2022 = Time.createTimestamp({ year: 2022, month: 12, day: 31 });
        const recordsQuery2 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateCreated: { to: lastDayOf2022 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply2 = await dwn.processMessage(alice.did, recordsQuery2.message);
        expect(reply2.entries?.length).toBe(2);
        expect(reply2.entries![0].encodedData).toBe(Encoder.bytesToBase64Url(write1.dataBytes!));
        expect(reply2.entries![1].encodedData).toBe(Encoder.bytesToBase64Url(write2.dataBytes!));

        // testing `from` and `to` range
        const lastDayOf2023 = Time.createTimestamp({ year: 2023, month: 12, day: 31 });
        const recordsQuery3 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateCreated: { from: lastDayOf2022, to: lastDayOf2023 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply3 = await dwn.processMessage(alice.did, recordsQuery3.message);
        expect(reply3.entries?.length).toBe(1);
        expect(reply3.entries![0].encodedData).toBe(Encoder.bytesToBase64Url(write3.dataBytes!));

        // testing edge case where value equals `from` and `to`
        const recordsQuery4 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateCreated: { from: firstDayOf2022, to: firstDayOf2023 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply4 = await dwn.processMessage(alice.did, recordsQuery4.message);
        expect(reply4.entries?.length).toBe(1);
        expect(reply4.entries![0].encodedData).toBe(Encoder.bytesToBase64Url(write2.dataBytes!));
      });

      it('should not return records that were published and then unpublished ', async () => {
        // scenario: 3 records authored by alice, published on first of 2021, 2022, and 2023 respectively
        // then the records are unpublished and tested to not return when filtering for published records

        const firstDayOf2020 = Time.createTimestamp({ year: 2020, month: 1, day: 1 });
        const firstDayOf2021 = Time.createTimestamp({ year: 2021, month: 1, day: 1 });
        const firstDayOf2022 = Time.createTimestamp({ year: 2022, month: 1, day: 1 });
        const firstDayOf2023 = Time.createTimestamp({ year: 2023, month: 1, day: 1 });
        const alice = await TestDataGenerator.generateDidKeyPersona();
        // install protocol at a timestamp before the record timestamps so temporal lookup works for updates
        const protocolsConfigure = await ProtocolsConfigure.create({
          definition       : defaultTestProtocolDefinition,
          signer           : Jws.createSigner(alice),
          messageTimestamp : Time.createTimestamp({ year: 2019, month: 1, day: 1 }),
        });
        const protoReply = await dwn.processMessage(alice.did, protocolsConfigure.message);
        expect(protoReply.status.code).toBe(202);
        const write1 = await TestDataGenerator.generateRecordsWrite({
          author: alice, published: true, dateCreated: firstDayOf2020, datePublished: firstDayOf2021, messageTimestamp: firstDayOf2020
        });
        const write2 = await TestDataGenerator.generateRecordsWrite({
          author: alice, published: true, dateCreated: firstDayOf2020, datePublished: firstDayOf2022, messageTimestamp: firstDayOf2020
        });
        const write3 = await TestDataGenerator.generateRecordsWrite({
          author: alice, published: true, dateCreated: firstDayOf2020, datePublished: firstDayOf2023, messageTimestamp: firstDayOf2020
        });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // confirm range before un-publishing.
        const lastDayOf2021 = Time.createTimestamp({ year: 2021, month: 12, day: 31 });
        const ownerRangeQuery = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { datePublished: { from: lastDayOf2021 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply1 = await dwn.processMessage(alice.did, ownerRangeQuery.message);
        expect(reply1.entries?.length).toBe(2);
        const reply1RecordIds = reply1.entries?.map(e => e.recordId);
        expect(reply1RecordIds).toEqual(expect.arrayContaining([ write2.message.recordId, write3.message.recordId ]));

        // confirm published true filter before un-publishing
        const ownerPublishedQuery = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { published: true },
          dateSort : DateSort.CreatedAscending
        });
        let ownerPublishedReply = await dwn.processMessage(alice.did, ownerPublishedQuery.message);
        expect(ownerPublishedReply.status.code).toBe(200);
        expect(ownerPublishedReply.entries?.length).toBe(3);
        const ownerPublishedIds = ownerPublishedReply.entries?.map(e => e.recordId);
        expect(ownerPublishedIds).toEqual(expect.arrayContaining([ write1.message.recordId, write2.message.recordId, write3.message.recordId ]));

        // confirm for anonymous query before un-publishing
        const anonymousRangeQuery = await RecordsQuery.create({
          filter   : { datePublished: { from: lastDayOf2021 } },
          dateSort : DateSort.CreatedAscending
        });

        let anonymousRangeReply = await dwn.processMessage(alice.did, anonymousRangeQuery.message);
        expect(anonymousRangeReply.status.code).toBe(200);
        expect(anonymousRangeReply.entries?.length).toBe(2);
        const anonymousReplyIds = anonymousRangeReply.entries?.map(e => e.recordId);
        expect(anonymousReplyIds).toEqual(expect.arrayContaining([ write2.message.recordId, write3.message.recordId ]));

        // confirm anonymous published true filter before un-publishing
        const anonymousPublishedQuery = await RecordsQuery.create({
          filter   : { published: true },
          dateSort : DateSort.CreatedAscending
        });
        let anonymousPublishedReply = await dwn.processMessage(alice.did, anonymousPublishedQuery.message);
        expect(anonymousPublishedReply.status.code).toBe(200);
        expect(anonymousPublishedReply.entries?.length).toBe(3);
        const anonymousPublishedIds = anonymousPublishedReply.entries?.map(e => e.recordId);
        expect(anonymousPublishedIds).toEqual(expect.arrayContaining([ write1.message.recordId, write2.message.recordId, write3.message.recordId ]));

        //unpublish records
        const write1Unpublish = await RecordsWrite.createFrom({
          signer              : Jws.createSigner(alice),
          recordsWriteMessage : write1.message,
          published           : false
        });
        const write2Unpublish = await RecordsWrite.createFrom({
          signer              : Jws.createSigner(alice),
          recordsWriteMessage : write2.message,
          published           : false
        });
        const write3Unpublish = await RecordsWrite.createFrom({
          signer              : Jws.createSigner(alice),
          recordsWriteMessage : write3.message,
          published           : false
        });
        const unpublished1Response = await dwn.processMessage(alice.did, write1Unpublish.message);
        const unpublished2Response = await dwn.processMessage(alice.did, write2Unpublish.message);
        const unpublished3Response = await dwn.processMessage(alice.did, write3Unpublish.message);
        expect(unpublished1Response.status.code).toBe(202);
        expect(unpublished2Response.status.code).toBe(202);
        expect(unpublished3Response.status.code).toBe(202);

        // try datePublished range query as an anonymous user after unpublish
        anonymousRangeReply = await dwn.processMessage(alice.did, anonymousRangeQuery.message);
        expect(anonymousRangeReply.status.code).toBe(200);
        expect(anonymousRangeReply.entries?.length).toBe(0);

        // try published:true filter as an anonymous user after unpublish
        anonymousPublishedReply = await dwn.processMessage(alice.did, anonymousPublishedQuery.message);
        expect(anonymousPublishedReply.status.code).toBe(200);
        expect(anonymousPublishedReply.entries?.length).toBe(0);

        // try datePublished range query as owner after unpublish
        const ownerRangeReply = await dwn.processMessage(alice.did, ownerRangeQuery.message);
        expect(ownerRangeReply.status.code).toBe(200);
        expect(ownerRangeReply.entries?.length).toBe(0);

        // try published:true filter as owner after unpublish
        ownerPublishedReply = await dwn.processMessage(alice.did, ownerPublishedQuery.message);
        expect(ownerPublishedReply.status.code).toBe(200);
        expect(ownerPublishedReply.entries?.length).toBe(0);
      });

      it('should be able to range query by `datePublished`', async () => {
        // scenario: 3 records authored by alice, published on first of 2021, 2022, and 2023 respectively
        // all 3 records are created on first of 2020

        const firstDayOf2020 = Time.createTimestamp({ year: 2020, month: 1, day: 1 });
        const firstDayOf2021 = Time.createTimestamp({ year: 2021, month: 1, day: 1 });
        const firstDayOf2022 = Time.createTimestamp({ year: 2022, month: 1, day: 1 });
        const firstDayOf2023 = Time.createTimestamp({ year: 2023, month: 1, day: 1 });
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const write1 = await TestDataGenerator.generateRecordsWrite({
          author: alice, published: true, dateCreated: firstDayOf2020, datePublished: firstDayOf2021, messageTimestamp: firstDayOf2020
        });
        const write2 = await TestDataGenerator.generateRecordsWrite({
          author: alice, published: true, dateCreated: firstDayOf2020, datePublished: firstDayOf2022, messageTimestamp: firstDayOf2020
        });
        const write3 = await TestDataGenerator.generateRecordsWrite({
          author: alice, published: true, dateCreated: firstDayOf2020, datePublished: firstDayOf2023, messageTimestamp: firstDayOf2020
        });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // testing `from` range
        const lastDayOf2021 = Time.createTimestamp({ year: 2021, month: 12, day: 31 });
        const recordsQuery1 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { datePublished: { from: lastDayOf2021 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply1 = await dwn.processMessage(alice.did, recordsQuery1.message);
        expect(reply1.entries?.length).toBe(2);
        const reply1RecordIds = reply1.entries?.map(e => e.recordId);
        expect(reply1RecordIds).toEqual(expect.arrayContaining([ write2.message.recordId, write3.message.recordId ]));

        // testing `to` range
        const lastDayOf2022 = Time.createTimestamp({ year: 2022, month: 12, day: 31 });
        const recordsQuery2 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { datePublished: { to: lastDayOf2022 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply2 = await dwn.processMessage(alice.did, recordsQuery2.message);
        expect(reply2.entries?.length).toBe(2);
        const reply2RecordIds = reply2.entries?.map(e => e.recordId);
        expect(reply2RecordIds).toEqual(expect.arrayContaining([ write1.message.recordId, write2.message.recordId ]));

        // testing `from` and `to` range
        const lastDayOf2023 = Time.createTimestamp({ year: 2023, month: 12, day: 31 });
        const recordsQuery3 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { datePublished: { from: lastDayOf2022, to: lastDayOf2023 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply3 = await dwn.processMessage(alice.did, recordsQuery3.message);
        expect(reply3.entries?.length).toBe(1);
        expect(reply3.entries![0].recordId).toBe(write3.message.recordId);

        // testing edge case where value equals `from` and `to`
        const recordsQuery4 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { datePublished: { from: firstDayOf2022, to: firstDayOf2023 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply4 = await dwn.processMessage(alice.did, recordsQuery4.message);
        expect(reply4.entries?.length).toBe(1);
        expect(reply4.entries![0].recordId).toBe(write2.message.recordId);

        // check for anonymous range query
        const anonymousRecordQuery = await RecordsQuery.create({
          filter   : { datePublished: { from: lastDayOf2021 } },
          dateSort : DateSort.CreatedAscending
        });

        const anonymousReply = await dwn.processMessage(alice.did, anonymousRecordQuery.message);
        expect(anonymousReply.status.code).toBe(200);
        expect(anonymousReply.entries?.length).toBe(2);
        const anonymousReplyIds = anonymousReply.entries?.map(e => e.recordId);
        expect(anonymousReplyIds).toEqual(expect.arrayContaining([ write2.message.recordId, write3.message.recordId ]));

        // check for non owner range query
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const nonOwnerRange = await TestDataGenerator.generateRecordsQuery({
          author   : bob,
          filter   : { datePublished: { from: lastDayOf2021 } },
          dateSort : DateSort.CreatedAscending
        });

        const nonOwnerReply = await dwn.processMessage(alice.did, nonOwnerRange.message);
        expect(nonOwnerReply.status.code).toBe(200);
        expect(nonOwnerReply.entries?.length).toBe(2);
        const nonOwnerReplyIds = nonOwnerReply.entries?.map(e => e.recordId);
        expect(nonOwnerReplyIds).toEqual(expect.arrayContaining([ write2.message.recordId, write3.message.recordId ]));
      });

      it('should be able to range query by `dateUpdated`', async () => {
        // scenario: alice creates 3 records on the first day of 2020.
        // alice then updates these records to published on first of 2021, 2022, and 2023 respectively
        // this should update the messageTimestamp on the respective messages

        const firstDayOf2020 = Time.createTimestamp({ year: 2020, month: 1, day: 1 });
        const firstDayOf2021 = Time.createTimestamp({ year: 2021, month: 1, day: 1 });
        const firstDayOf2022 = Time.createTimestamp({ year: 2022, month: 1, day: 1 });
        const firstDayOf2023 = Time.createTimestamp({ year: 2023, month: 1, day: 1 });
        const alice = await TestDataGenerator.generateDidKeyPersona();
        // install protocol at a timestamp before the record timestamps so temporal lookup works for updates
        const protocolsConfigure = await ProtocolsConfigure.create({
          definition       : defaultTestProtocolDefinition,
          signer           : Jws.createSigner(alice),
          messageTimestamp : Time.createTimestamp({ year: 2019, month: 1, day: 1 }),
        });
        const protoReply = await dwn.processMessage(alice.did, protocolsConfigure.message);
        expect(protoReply.status.code).toBe(202);

        const write1 = await TestDataGenerator.generateRecordsWrite({
          author: alice, dateCreated: firstDayOf2020, messageTimestamp: firstDayOf2020
        });
        const write2 = await TestDataGenerator.generateRecordsWrite({
          author: alice, dateCreated: firstDayOf2020, messageTimestamp: firstDayOf2020
        });
        const write3 = await TestDataGenerator.generateRecordsWrite({
          author: alice, dateCreated: firstDayOf2020, messageTimestamp: firstDayOf2020
        });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // update to published
        const write1Update = await RecordsWrite.createFrom({
          recordsWriteMessage : write1.message,
          published           : true,
          messageTimestamp    : firstDayOf2021,
          datePublished       : firstDayOf2021,
          signer              : Jws.createSigner(alice)
        });

        const write2Update = await RecordsWrite.createFrom({
          recordsWriteMessage : write2.message,
          published           : true,
          messageTimestamp    : firstDayOf2022,
          datePublished       : firstDayOf2022,
          signer              : Jws.createSigner(alice)
        });

        const write3Update = await RecordsWrite.createFrom({
          recordsWriteMessage : write3.message,
          published           : true,
          messageTimestamp    : firstDayOf2023,
          datePublished       : firstDayOf2023,
          signer              : Jws.createSigner(alice)
        });
        const writeReplyUpdate1 = await dwn.processMessage(alice.did, write1Update.message);
        const writeReplyUpdate2 = await dwn.processMessage(alice.did, write2Update.message);
        const writeReplyUpdate3 = await dwn.processMessage(alice.did, write3Update.message);
        expect(writeReplyUpdate1.status.code).toBe(202);
        expect(writeReplyUpdate2.status.code).toBe(202);
        expect(writeReplyUpdate3.status.code).toBe(202);

        // testing `from` range
        const lastDayOf2021 = Time.createTimestamp({ year: 2021, month: 12, day: 31 });
        const recordsQuery1 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateUpdated: { from: lastDayOf2021 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply1 = await dwn.processMessage(alice.did, recordsQuery1.message);
        expect(reply1.entries?.length).toBe(2);
        const reply1RecordIds = reply1.entries?.map(e => e.recordId);
        expect(reply1RecordIds).toEqual(expect.arrayContaining([ write2.message.recordId, write3.message.recordId ]));

        // testing `to` range
        const lastDayOf2022 = Time.createTimestamp({ year: 2022, month: 12, day: 31 });
        const recordsQuery2 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateUpdated: { to: lastDayOf2022 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply2 = await dwn.processMessage(alice.did, recordsQuery2.message);
        expect(reply2.entries?.length).toBe(2);
        const reply2RecordIds = reply2.entries?.map(e => e.recordId);
        expect(reply2RecordIds).toEqual(expect.arrayContaining([ write1.message.recordId, write2.message.recordId ]));

        // testing `from` and `to` range
        const lastDayOf2023 = Time.createTimestamp({ year: 2023, month: 12, day: 31 });
        const recordsQuery3 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateUpdated: { from: lastDayOf2022, to: lastDayOf2023 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply3 = await dwn.processMessage(alice.did, recordsQuery3.message);
        expect(reply3.entries?.length).toBe(1);
        expect(reply3.entries![0].recordId).toBe(write3.message.recordId);

        // testing edge case where value equals `from` and `to`
        const recordsQuery4 = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { dateUpdated: { from: firstDayOf2022, to: firstDayOf2023 } },
          dateSort : DateSort.CreatedAscending
        });
        const reply4 = await dwn.processMessage(alice.did, recordsQuery4.message);
        expect(reply4.entries?.length).toBe(1);
        expect(reply4.entries![0].recordId).toBe(write2.message.recordId);
      });

      it('should be able use range and exact match queries at the same time', async () => {
        // scenario: 3 records authored by alice, created on first of 2021, 2022, and 2023 respectively
        // only the first 2 records share the same schema
        const firstDayOf2021 = Time.createTimestamp({ year: 2021, month: 1, day: 1 });
        const firstDayOf2022 = Time.createTimestamp({ year: 2022, month: 1, day: 1 });
        const firstDayOf2023 = Time.createTimestamp({ year: 2023, month: 1, day: 1 });
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const schema = '2021And2022Schema';
        const write1 = await TestDataGenerator.generateRecordsWrite({
          author: alice, dateCreated: firstDayOf2021, messageTimestamp: firstDayOf2021, schema
        });
        const write2 = await TestDataGenerator.generateRecordsWrite({
          author: alice, dateCreated: firstDayOf2022, messageTimestamp: firstDayOf2022, schema
        });
        const write3 = await TestDataGenerator.generateRecordsWrite({
          author: alice, dateCreated: firstDayOf2023, messageTimestamp: firstDayOf2023
        });

        // insert data
        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // testing range criterion with another exact match
        const lastDayOf2021 = Time.createTimestamp({ year: 2021, month: 12, day: 31 });
        const lastDayOf2023 = Time.createTimestamp({ year: 2023, month: 12, day: 31 });
        const recordsQuery5 = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema, // by itself selects the first 2 records
            dateCreated: { from: lastDayOf2021, to: lastDayOf2023 } // by itself selects the last 2 records
          },
          dateSort: DateSort.CreatedAscending
        });
        const reply = await dwn.processMessage(alice.did, recordsQuery5.message);
        expect(reply.entries?.length).toBe(1);
        expect(reply.entries![0].encodedData).toBe(Encoder.bytesToBase64Url(write2.dataBytes!));
      });

      it('should include `authorization` in returned records', async () => {
        const alice = await TestDataGenerator.generatePersona();
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        // setting up a stub method resolver
        const mockResolution = TestDataGenerator.createDidResolutionResult(alice);
        sinon.stub(didResolver, 'resolve').resolves(mockResolution);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        const queryData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: message.descriptor.schema }
        });

        const queryReply = await dwn.processMessage(alice.did, queryData.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(1);
        expect((queryReply.entries![0] as any).authorization).toEqual(message.authorization);
      });

      it('should include `attestation` in returned records', async () => {
      // scenario: alice and bob attest to a message alice authored

        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const { message, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: alice, attesters: [alice] });

        const writeReply = await dwn.processMessage(alice.did, message, { dataStream });
        expect(writeReply.status.code).toBe(202);

        const queryData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: message.descriptor.schema }
        });

        const queryReply = await dwn.processMessage(alice.did, queryData.message);
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(1);

        const recordsWriteMessage = queryReply.entries![0] as any;
        expect(recordsWriteMessage.attestation?.signatures?.length).toBe(1);
      });

      it('should omit records that are not published if `dateSort` sorts on `datePublished`', async () => {
      // setup: 2 records in DWN: 1 published and 1 unpublished
        const alice = await TestDataGenerator.generatePersona();
        const schema = 'aSchema';
        const publishedWriteData = await TestDataGenerator.generateRecordsWrite({
          author: alice, schema, published: true
        });
        const unpublishedWriteData = await TestDataGenerator.generateRecordsWrite({
          author: alice, schema
        });

        // setting up a stub method resolver
        const mockResolution = TestDataGenerator.createDidResolutionResult(alice);;
        sinon.stub(didResolver, 'resolve').resolves(mockResolution);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert data
        const publishedWriteReply = await dwn.processMessage(alice.did, publishedWriteData.message, { dataStream: publishedWriteData.dataStream });
        const unpublishedWriteReply =
          await dwn.processMessage(alice.did, unpublishedWriteData.message, { dataStream: unpublishedWriteData.dataStream });
        expect(publishedWriteReply.status.code).toBe(202);
        expect(unpublishedWriteReply.status.code).toBe(202);

        // test published date ascending sort does not include any records that are not published
        const publishedAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.PublishedAscending,
          filter   : { schema }
        });
        const publishedAscendingQueryReply = await dwn.processMessage(alice.did, publishedAscendingQueryData.message);
        expect(publishedAscendingQueryReply.entries?.length).toBe(1);
        expect(publishedAscendingQueryReply.entries![0].recordId).toBe(publishedWriteData.message.recordId);

        // test published date scending sort does not include any records that are not published
        const publishedDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.PublishedDescending,
          filter   : { schema }
        });
        const publishedDescendingQueryReply = await dwn.processMessage(alice.did, publishedDescendingQueryData.message);
        expect(publishedDescendingQueryReply.entries?.length).toBe(1);
        expect(publishedDescendingQueryReply.entries![0].recordId).toBe(publishedWriteData.message.recordId);
      });

      it('should sort records if `dateSort` is specified with and without a cursor', async () => {
        // insert three messages into DB
        const alice = await TestDataGenerator.generatePersona();
        const schema = 'aSchema';
        const published = true;
        const write1Data = await TestDataGenerator.generateRecordsWrite({ author: alice, schema, published });
        await Time.minimalSleep();
        const write2Data = await TestDataGenerator.generateRecordsWrite({ author: alice, schema, published });
        await Time.minimalSleep();
        const write3Data = await TestDataGenerator.generateRecordsWrite({ author: alice, schema, published });

        // setting up a stub method resolver
        const mockResolution = TestDataGenerator.createDidResolutionResult(alice);;
        sinon.stub(didResolver, 'resolve').resolves(mockResolution);
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // insert data, intentionally out of order
        const writeReply2 = await dwn.processMessage(alice.did, write2Data.message, { dataStream: write2Data.dataStream });
        const writeReply1 = await dwn.processMessage(alice.did, write1Data.message, { dataStream: write1Data.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3Data.message, { dataStream: write3Data.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // createdAscending test
        let createdAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.CreatedAscending,
          filter   : { schema }
        });
        let createdAscendingQueryReply = await dwn.processMessage(alice.did, createdAscendingQueryData.message);
        expect(createdAscendingQueryReply.entries!.length).toBe(3);
        expect(createdAscendingQueryReply.entries?.[0].recordId).toBe(write1Data.message.recordId);
        expect(createdAscendingQueryReply.entries?.[1].recordId).toBe(write2Data.message.recordId);
        expect(createdAscendingQueryReply.entries?.[2].recordId).toBe(write3Data.message.recordId);

        // to test with a cursor we first get a single record
        createdAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.CreatedAscending,
          filter     : { schema },
          pagination : { limit: 1 }
        });
        createdAscendingQueryReply = await dwn.processMessage(alice.did, createdAscendingQueryData.message);
        expect(createdAscendingQueryReply.entries!.length).toBe(1);

        // we then use the single record query's cursor to get the rest of the records
        createdAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.CreatedAscending,
          filter     : { schema },
          pagination : { cursor: createdAscendingQueryReply.cursor }
        });
        createdAscendingQueryReply = await dwn.processMessage(alice.did, createdAscendingQueryData.message);
        expect(createdAscendingQueryReply.entries!.length).toBe(2);
        expect(createdAscendingQueryReply.entries![0].recordId).toBe(write2Data.message.recordId);
        expect(createdAscendingQueryReply.entries![1].recordId).toBe(write3Data.message.recordId);

        // createdDescending test
        let createdDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.CreatedDescending,
          filter   : { schema }
        });
        let createdDescendingQueryReply = await dwn.processMessage(alice.did, createdDescendingQueryData.message);
        expect(createdDescendingQueryReply.entries!.length).toBe(3);
        expect(createdDescendingQueryReply.entries?.[0].recordId).toBe(write3Data.message.recordId);
        expect(createdDescendingQueryReply.entries?.[1].recordId).toBe(write2Data.message.recordId);
        expect(createdDescendingQueryReply.entries?.[2].recordId).toBe(write1Data.message.recordId);

        // to test with a cursor we first get a single record
        createdDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.CreatedDescending,
          filter     : { schema },
          pagination : { limit: 1 }
        });
        createdDescendingQueryReply = await dwn.processMessage(alice.did, createdDescendingQueryData.message);
        expect(createdDescendingQueryReply.entries!.length).toBe(1);

        // we then use the single record query's cursor to get the rest of the records
        createdDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.CreatedDescending,
          filter     : { schema },
          pagination : { cursor: createdDescendingQueryReply.cursor }
        });
        createdDescendingQueryReply = await dwn.processMessage(alice.did, createdDescendingQueryData.message);
        expect(createdDescendingQueryReply.entries!.length).toBe(2);
        expect(createdDescendingQueryReply.entries![0].recordId).toBe(write2Data.message.recordId);
        expect(createdDescendingQueryReply.entries![1].recordId).toBe(write1Data.message.recordId);

        // publishedAscending test
        let publishedAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.PublishedAscending,
          filter   : { schema }
        });
        let publishedAscendingQueryReply = await dwn.processMessage(alice.did, publishedAscendingQueryData.message);
        expect(publishedAscendingQueryReply.entries!.length).toBe(3);
        expect(publishedAscendingQueryReply.entries?.[0].recordId).toBe(write1Data.message.recordId);
        expect(publishedAscendingQueryReply.entries?.[1].recordId).toBe(write2Data.message.recordId);
        expect(publishedAscendingQueryReply.entries?.[2].recordId).toBe(write3Data.message.recordId);

        // to test with a cursor we first get a single record
        publishedAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.PublishedAscending,
          filter     : { schema },
          pagination : { limit: 1 }
        });
        publishedAscendingQueryReply = await dwn.processMessage(alice.did, publishedAscendingQueryData.message);
        expect(publishedAscendingQueryReply.entries!.length).toBe(1);

        publishedAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.PublishedAscending,
          filter     : { schema },
          pagination : { cursor: publishedAscendingQueryReply.cursor }
        });
        publishedAscendingQueryReply = await dwn.processMessage(alice.did, publishedAscendingQueryData.message);
        expect(publishedAscendingQueryReply.entries!.length).toBe(2);
        expect(publishedAscendingQueryReply.entries![0].recordId).toBe(write2Data.message.recordId);
        expect(publishedAscendingQueryReply.entries![1].recordId).toBe(write3Data.message.recordId);

        // publishedDescending test
        let publishedDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.PublishedDescending,
          filter   : { schema }
        });
        let publishedDescendingQueryReply = await dwn.processMessage(alice.did, publishedDescendingQueryData.message);
        expect(publishedDescendingQueryReply.entries!.length).toBe(3);
        expect(publishedDescendingQueryReply.entries?.[0].recordId).toBe(write3Data.message.recordId);
        expect(publishedDescendingQueryReply.entries?.[1].recordId).toBe(write2Data.message.recordId);
        expect(publishedDescendingQueryReply.entries?.[2].recordId).toBe(write1Data.message.recordId);

        publishedDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.PublishedDescending,
          filter     : { schema },
          pagination : { limit: 1 }
        });
        publishedDescendingQueryReply = await dwn.processMessage(alice.did, publishedDescendingQueryData.message);
        expect(publishedDescendingQueryReply.entries!.length).toBe(1);

        publishedDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          dateSort   : DateSort.PublishedDescending,
          filter     : { schema },
          pagination : { cursor: publishedDescendingQueryReply.cursor }
        });
        publishedDescendingQueryReply = await dwn.processMessage(alice.did, publishedDescendingQueryData.message);
        expect(publishedDescendingQueryReply.entries!.length).toBe(2);
        expect(publishedDescendingQueryReply.entries![0].recordId).toBe(write2Data.message.recordId);
        expect(publishedDescendingQueryReply.entries![1].recordId).toBe(write1Data.message.recordId);
      });

      it('should sort records by `updatedAscending` and `updatedDescending`', async () => {
        // insert three messages into DB
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const schema = 'aSchema';
        const write1Data = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });
        await Time.minimalSleep();
        const write2Data = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });
        await Time.minimalSleep();
        const write3Data = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });

        // insert data, intentionally out of order
        const writeReply2 = await dwn.processMessage(alice.did, write2Data.message, { dataStream: write2Data.dataStream });
        const writeReply1 = await dwn.processMessage(alice.did, write1Data.message, { dataStream: write1Data.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3Data.message, { dataStream: write3Data.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // updatedAscending test
        const updatedAscendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.UpdatedAscending,
          filter   : { schema }
        });
        const updatedAscendingQueryReply = await dwn.processMessage(alice.did, updatedAscendingQueryData.message);
        expect(updatedAscendingQueryReply.entries!.length).toBe(3);
        expect(updatedAscendingQueryReply.entries?.[0].recordId).toBe(write1Data.message.recordId);
        expect(updatedAscendingQueryReply.entries?.[1].recordId).toBe(write2Data.message.recordId);
        expect(updatedAscendingQueryReply.entries?.[2].recordId).toBe(write3Data.message.recordId);

        // updatedDescending test
        const updatedDescendingQueryData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.UpdatedDescending,
          filter   : { schema }
        });
        const updatedDescendingQueryReply = await dwn.processMessage(alice.did, updatedDescendingQueryData.message);
        expect(updatedDescendingQueryReply.entries!.length).toBe(3);
        expect(updatedDescendingQueryReply.entries?.[0].recordId).toBe(write3Data.message.recordId);
        expect(updatedDescendingQueryReply.entries?.[1].recordId).toBe(write2Data.message.recordId);
        expect(updatedDescendingQueryReply.entries?.[2].recordId).toBe(write1Data.message.recordId);
      });

      it('should sort by `messageTimestamp` (not `dateCreated`) when using updated sort with genuinely updated records', async () => {
        // scenario: alice creates 3 records on the same day, then updates them in reverse order.
        // updatedAscending should return them in order of their update, not creation.
        const createdTimestamp = Time.createTimestamp({ year: 2020, month: 1, day: 1 });
        const alice = await TestDataGenerator.generateDidKeyPersona();
        // install protocol at a timestamp before the record timestamps so temporal lookup works for updates
        const protocolsConfigure = await ProtocolsConfigure.create({
          definition       : defaultTestProtocolDefinition,
          signer           : Jws.createSigner(alice),
          messageTimestamp : Time.createTimestamp({ year: 2019, month: 1, day: 1 }),
        });
        const protoReply = await dwn.processMessage(alice.did, protocolsConfigure.message);
        expect(protoReply.status.code).toBe(202);
        const schema = 'aSchema';

        const write1 = await TestDataGenerator.generateRecordsWrite({
          author: alice, schema, dateCreated: createdTimestamp, messageTimestamp: createdTimestamp,
        });
        const write2 = await TestDataGenerator.generateRecordsWrite({
          author: alice, schema, dateCreated: createdTimestamp, messageTimestamp: createdTimestamp,
        });
        const write3 = await TestDataGenerator.generateRecordsWrite({
          author: alice, schema, dateCreated: createdTimestamp, messageTimestamp: createdTimestamp,
        });

        const writeReply1 = await dwn.processMessage(alice.did, write1.message, { dataStream: write1.dataStream });
        const writeReply2 = await dwn.processMessage(alice.did, write2.message, { dataStream: write2.dataStream });
        const writeReply3 = await dwn.processMessage(alice.did, write3.message, { dataStream: write3.dataStream });
        expect(writeReply1.status.code).toBe(202);
        expect(writeReply2.status.code).toBe(202);
        expect(writeReply3.status.code).toBe(202);

        // update in reverse order: write3 first, then write2, then write1
        const update3 = await RecordsWrite.createFrom({
          recordsWriteMessage : write3.message,
          messageTimestamp    : Time.createTimestamp({ year: 2021, month: 1, day: 1 }),
          signer              : Jws.createSigner(alice),
        });
        const update2 = await RecordsWrite.createFrom({
          recordsWriteMessage : write2.message,
          messageTimestamp    : Time.createTimestamp({ year: 2022, month: 1, day: 1 }),
          signer              : Jws.createSigner(alice),
        });
        const update1 = await RecordsWrite.createFrom({
          recordsWriteMessage : write1.message,
          messageTimestamp    : Time.createTimestamp({ year: 2023, month: 1, day: 1 }),
          signer              : Jws.createSigner(alice),
        });

        const updateReply3 = await dwn.processMessage(alice.did, update3.message);
        const updateReply2 = await dwn.processMessage(alice.did, update2.message);
        const updateReply1 = await dwn.processMessage(alice.did, update1.message);
        expect(updateReply3.status.code).toBe(202);
        expect(updateReply2.status.code).toBe(202);
        expect(updateReply1.status.code).toBe(202);

        // updatedAscending should return: write3 (2021), write2 (2022), write1 (2023)
        const updatedAscQuery = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.UpdatedAscending,
          filter   : { schema }
        });
        const updatedAscReply = await dwn.processMessage(alice.did, updatedAscQuery.message);
        expect(updatedAscReply.entries!.length).toBe(3);
        expect(updatedAscReply.entries![0].recordId).toBe(write3.message.recordId);
        expect(updatedAscReply.entries![1].recordId).toBe(write2.message.recordId);
        expect(updatedAscReply.entries![2].recordId).toBe(write1.message.recordId);

        // updatedDescending should return: write1 (2023), write2 (2022), write3 (2021)
        const updatedDescQuery = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          dateSort : DateSort.UpdatedDescending,
          filter   : { schema }
        });
        const updatedDescReply = await dwn.processMessage(alice.did, updatedDescQuery.message);
        expect(updatedDescReply.entries!.length).toBe(3);
        expect(updatedDescReply.entries![0].recordId).toBe(write1.message.recordId);
        expect(updatedDescReply.entries![1].recordId).toBe(write2.message.recordId);
        expect(updatedDescReply.entries![2].recordId).toBe(write3.message.recordId);
      });

      it('should tiebreak using `messageCid` when sorting encounters identical values', async () => {
        // setup: 3 messages with the same `dateCreated` value
        const dateCreated = Time.getCurrentTimestamp();
        const messageTimestamp = dateCreated;
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const schema = 'aSchema';
        const published = true;
        const write1Data = await TestDataGenerator.generateRecordsWrite({ messageTimestamp, dateCreated, author: alice, schema, published });
        const write2Data = await TestDataGenerator.generateRecordsWrite({ messageTimestamp, dateCreated, author: alice, schema, published });
        const write3Data = await TestDataGenerator.generateRecordsWrite({ messageTimestamp, dateCreated, author: alice, schema, published });

        // sort the messages in lexicographical order against `messageCid`
        const [ oldestWrite, middleWrite, newestWrite ] = await ArrayUtility.asyncSort(
          [ write1Data, write2Data, write3Data ],
          (messageDataA, messageDataB) => { return Message.compareCid(messageDataA.message, messageDataB.message); }
        );

        // intentionally write the RecordsWrite of out lexicographical order to avoid the test query below accidentally having the correct order
        const reply2 = await dwn.processMessage(alice.did, middleWrite.message, { dataStream: middleWrite.dataStream });
        expect(reply2.status.code).toBe(202);
        const reply3 = await dwn.processMessage(alice.did, newestWrite.message, { dataStream: newestWrite.dataStream });
        expect(reply3.status.code).toBe(202);
        const reply1 = await dwn.processMessage(alice.did, oldestWrite.message, { dataStream: oldestWrite.dataStream });
        expect(reply1.status.code).toBe(202);

        const queryMessageData = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { schema },
          dateSort : DateSort.CreatedAscending
        });
        const queryReply = await dwn.processMessage(alice.did, queryMessageData.message);

        // verify that messages returned are sorted/tiebreak by `messageCid`
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries?.length).toBe(3);
        expect((queryReply.entries![0]).recordId).toBe(oldestWrite.message.recordId);
        expect((queryReply.entries![1]).recordId).toBe(middleWrite.message.recordId);
        expect((queryReply.entries![2]).recordId).toBe(newestWrite.message.recordId);

        // sort descending should be reversed
        const queryMessageDescending = await TestDataGenerator.generateRecordsQuery({
          author   : alice,
          filter   : { schema },
          dateSort : DateSort.CreatedDescending
        });
        const descendingReply = await dwn.processMessage(alice.did, queryMessageDescending.message);
        expect((descendingReply.entries![0]).recordId).toBe(newestWrite.message.recordId);
        expect((descendingReply.entries![1]).recordId).toBe(middleWrite.message.recordId);
        expect((descendingReply.entries![2]).recordId).toBe(oldestWrite.message.recordId);
      });

      it('should paginate all records in ascending order', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const messages = await Promise.all(Array(12).fill({}).map(_ => TestDataGenerator.generateRecordsWrite({
          author : alice,
          schema : 'https://schema'
        })));
        for (const message of messages) {
          const result = await dwn.processMessage(alice.did, message.message, { dataStream: message.dataStream });
          expect(result.status.code).toBe(202);
        }

        const limit = 5;
        const results: RecordsQueryReplyEntry[] = [];
        let cursor;
        while (true) {
          const pageQuery = await TestDataGenerator.generateRecordsQuery({
            author : alice,
            filter : {
              schema: 'https://schema'
            },
            pagination: {
              limit: limit,
              cursor,
            },
            dateSort: DateSort.CreatedAscending
          });

          const pageReply = await dwn.processMessage(alice.did, pageQuery.message);
          expect(pageReply.status.code).toBe(200);
          cursor = pageReply.cursor;
          expect(pageReply.entries?.length).toBeLessThanOrEqual(limit);
          results.push(...pageReply.entries!);
          if (cursor === undefined) {
            break;
          }
        }
        expect(results.length).toBe(messages.length);
        expect(messages.every(({ message }) => results.map(e => (e as RecordsWriteMessage).recordId).includes(message.recordId)));
      });

      it('should paginate all records in descending order', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        const messages = await Promise.all(Array(12).fill({}).map(_ => TestDataGenerator.generateRecordsWrite({
          author : alice,
          schema : 'https://schema'
        })));
        for (const message of messages) {
          const result = await dwn.processMessage(alice.did, message.message, { dataStream: message.dataStream });
          expect(result.status.code).toBe(202);
        }

        const limit = 5;
        const results: RecordsQueryReplyEntry[] = [];
        let cursor;
        while (true) {
          const pageQuery = await TestDataGenerator.generateRecordsQuery({
            author : alice,
            filter : {
              schema: 'https://schema'
            },
            pagination: {
              limit: limit,
              cursor,
            },
            dateSort: DateSort.CreatedDescending,
          });

          const pageReply = await dwn.processMessage(alice.did, pageQuery.message);
          expect(pageReply.status.code).toBe(200);
          cursor = pageReply.cursor;
          expect(pageReply.entries?.length).toBeLessThanOrEqual(limit);
          results.push(...pageReply.entries!);
          if (cursor === undefined) {
            break;
          }
        }
        expect(results.length).toBe(messages.length);
        expect(messages.every(({ message }) => results.map(e => (e as RecordsWriteMessage).recordId).includes(message.recordId)));
      });

      it('should allow an anonymous unauthenticated query to return published records', async () => {
      // write 2 records into Alice's DB:
      // 1st is unpublished
      // 2nd is published
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const record1Data = await TestDataGenerator.generateRecordsWrite(
          { author: alice, schema: 'https://schema1', published: false }
        );
        const record2Data = await TestDataGenerator.generateRecordsWrite(
          { author: alice, schema: 'https://schema2', published: true }
        );

        const recordsWrite1Reply = await dwn.processMessage(alice.did, record1Data.message, { dataStream: record1Data.dataStream });
        expect(recordsWrite1Reply.status.code).toBe(202);
        const recordsWrite2Reply = await dwn.processMessage(alice.did, record2Data.message, { dataStream: record2Data.dataStream });
        expect(recordsWrite2Reply.status.code).toBe(202);

        // test correctness for anonymous query
        const anonymousQueryMessageData = await TestDataGenerator.generateRecordsQuery({
          anonymous : true,
          filter    : { dateCreated: { from: '2000-01-01T10:20:30.123456Z' } }
        });

        // sanity check
        expect(anonymousQueryMessageData.message.authorization).toBeUndefined();

        const replyToQuery = await dwn.processMessage(alice.did, anonymousQueryMessageData.message);

        expect(replyToQuery.status.code).toBe(200);
        expect(replyToQuery.entries?.length).toBe(1);
        expect((replyToQuery.entries![0].descriptor as RecordsWriteDescriptor).schema).toBe('https://schema2');

        // explicitly for published records
        const anonymousQueryPublished = await TestDataGenerator.generateRecordsQuery({
          anonymous : true,
          filter    : { dateCreated: { from: '2000-01-01T10:20:30.123456Z' }, published: true }
        });
        // sanity check
        expect(anonymousQueryPublished.message.authorization).toBeUndefined();

        // should return the published records
        const publishedReply = await dwn.processMessage(alice.did, anonymousQueryPublished.message);
        expect(publishedReply.status.code).toBe(200);
        expect(publishedReply.entries?.length).toBe(1);
        expect((publishedReply.entries![0].descriptor as RecordsWriteDescriptor).schema).toBe('https://schema2');
      });

      it('should only return published records and unpublished records that are meant for specific recipient(s)', async () => {
        // scenario: Alice installs a free-for-all protocol on her DWN
        // She writes both private and public messages for bob and carol, carol and bob also write public and privet messages for alice and each other
        // Bob, Alice and Carol should only be able to see private messages pertaining to themselves, and any public messages filtered by a recipient
        // Bob, Alice and Carol should be able to filter for ONLY public messages or ONLY private messages

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // install the free-for-all protocol on Alice's DWN
        const protocolConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : freeForAll
        });
        const protocolConfigureReply = await dwn.processMessage(alice.did, protocolConfigure.message);
        expect(protocolConfigureReply.status.code).toBe(202);

        // write private records for bob and carol
        const alicePrivateToBob = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });

        const alicePrivateToBobReply = await dwn.processMessage(alice.did, alicePrivateToBob.message, { dataStream: alicePrivateToBob.dataStream });
        expect(alicePrivateToBobReply.status.code).toBe(202);

        const alicePrivateToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const alicePrivateToCarolReply = await dwn.processMessage(alice.did, alicePrivateToCarol.message, {
          dataStream: alicePrivateToCarol.dataStream
        });
        expect(alicePrivateToCarolReply.status.code).toBe(202);

        // write private records from carol to alice and bob
        const carolPrivateToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const carolPrivateToAliceReply = await dwn.processMessage(alice.did, carolPrivateToAlice.message, {
          dataStream: carolPrivateToAlice.dataStream
        });
        expect(carolPrivateToAliceReply.status.code).toBe(202);

        const carolPrivateToBob = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const carolPrivateToBobReply = await dwn.processMessage(alice.did, carolPrivateToBob.message, {
          dataStream: carolPrivateToBob.dataStream
        });
        expect(carolPrivateToBobReply.status.code).toBe(202);

        // write private records from bob to alice and carol
        const bobPrivateToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });

        const bobPrivateToAliceReply = await dwn.processMessage(alice.did, bobPrivateToAlice.message, {
          dataStream: bobPrivateToAlice.dataStream
        });
        expect(bobPrivateToAliceReply.status.code).toBe(202);

        const bobPrivateToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const bobPrivateToCarolReply = await dwn.processMessage(alice.did, bobPrivateToCarol.message, {
          dataStream: bobPrivateToCarol.dataStream
        });
        expect(bobPrivateToCarolReply.status.code).toBe(202);

        // write public records from alice to bob and carol
        const alicePublicToBob = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const alicePublicToBobReply = await dwn.processMessage(alice.did, alicePublicToBob.message, {
          dataStream: alicePublicToBob.dataStream
        });
        expect(alicePublicToBobReply.status.code).toBe(202);

        const alicePublicToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const alicePublicToCarolReply = await dwn.processMessage(alice.did, alicePublicToCarol.message, {
          dataStream: alicePublicToCarol.dataStream
        });
        expect(alicePublicToCarolReply.status.code).toBe(202);

        // write public records from bob to alice and carol
        const bobPublicToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const bobPublicToAliceReply = await dwn.processMessage(alice.did, bobPublicToAlice.message, {
          dataStream: bobPublicToAlice.dataStream
        });
        expect(bobPublicToAliceReply.status.code).toBe(202);

        const bobPublicToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const bobPublicToCarolReply = await dwn.processMessage(alice.did, bobPublicToCarol.message, {
          dataStream: bobPublicToCarol.dataStream
        });
        expect(bobPublicToCarolReply.status.code).toBe(202);

        // write public records from carol to alice and bob
        const carolPublicToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const carolPublicToAliceReply = await dwn.processMessage(alice.did, carolPublicToAlice.message, {
          dataStream: carolPublicToAlice.dataStream
        });
        expect(carolPublicToAliceReply.status.code).toBe(202);

        const carolPublicToBob = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const carolPublicToBobReply = await dwn.processMessage(alice.did, carolPublicToBob.message, {
          dataStream: carolPublicToBob.dataStream
        });
        expect(carolPublicToBobReply.status.code).toBe(202);

        // bob queries for records with himself and alice as recipients
        const bobQueryMessagesForBobAlice = await TestDataGenerator.generateRecordsQuery({
          author : bob,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', recipient: [bob.did, alice.did] }
        });
        const bobQueryMessagesForBobAliceReply = await dwn.processMessage(alice.did, bobQueryMessagesForBobAlice.message);
        expect(bobQueryMessagesForBobAliceReply.status.code).toBe(200);
        expect(bobQueryMessagesForBobAliceReply.entries?.length).toBe(7);

        // Since Bob is the author if the query, we expect for him to be able to see:
        // Private Messages THAT ANYONE sent to Bob
        // Private Messages THAT ONLY HE sent to Alice
        // Public Messages THAT ANYONE sent to Alice
        // Public Messages THAT ANYONE sent to Bob
        expect(bobQueryMessagesForBobAliceReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          alicePrivateToBob.message.recordId,
          carolPrivateToBob.message.recordId,
          bobPrivateToAlice.message.recordId,
          alicePublicToBob.message.recordId,
          bobPublicToAlice.message.recordId,
          carolPublicToAlice.message.recordId,
          carolPublicToBob.message.recordId,
        ]));

        // carol queries for records with herself as the recipient
        const carolQueryMessagesForCarolAlice = await TestDataGenerator.generateRecordsQuery({
          author : carol,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', recipient: carol.did }
        });
        const carolQueryMessagesForCarolAliceReply = await dwn.processMessage(alice.did, carolQueryMessagesForCarolAlice.message);
        expect(carolQueryMessagesForCarolAliceReply.status.code).toBe(200);
        expect(carolQueryMessagesForCarolAliceReply.entries?.length).toBe(4);

        // Since Carol is the author if the query, we expect for her to be able to see:
        // Private Messages THAT ANYONE sent to Carol
        // Private Messages THAT ONLY SHE sent to Alice
        // Public Messages THAT ANYONE sent to Alice
        // Public Messages THAT ANYONE sent to Carol
        expect(carolQueryMessagesForCarolAliceReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          alicePrivateToCarol.message.recordId,
          bobPrivateToCarol.message.recordId,
          alicePublicToCarol.message.recordId,
          bobPublicToCarol.message.recordId,
        ]));

        // alice queries for ONLY published records with herself and bob as recipients
        const aliceQueryPublished = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', recipient: [alice.did, bob.did], published: true }
        });
        const aliceQueryPublishedReply = await dwn.processMessage(alice.did, aliceQueryPublished.message);
        expect(aliceQueryPublishedReply.status.code).toBe(200);
        expect(aliceQueryPublishedReply.entries?.length).toBe(4);
        expect(aliceQueryPublishedReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          alicePublicToBob.message.recordId,
          carolPublicToBob.message.recordId,
          bobPublicToAlice.message.recordId,
          carolPublicToAlice.message.recordId,
        ]));

        // carol queries for ONLY private records with herself and alice as the recipients
        const carolQueryPrivate = await TestDataGenerator.generateRecordsQuery({
          author : carol,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', recipient: [carol.did, alice.did], published: false }
        });
        const carolQueryPrivateReply = await dwn.processMessage(alice.did, carolQueryPrivate.message);
        expect(carolQueryPrivateReply.status.code).toBe(200);
        expect(carolQueryPrivateReply.entries?.length).toBe(3);
        // Carol can query for private messages she authored to alice, and her own private messages with herself as the recipient
        expect(carolQueryPrivateReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          alicePrivateToCarol.message.recordId,
          bobPrivateToCarol.message.recordId,
          carolPrivateToAlice.message.recordId,
        ]));
      });

      it('should only return published records and unpublished records that are authored by specific author(s)', async () => {
        // scenario: Alice installs a free-for-all protocol on her DWN
        // She writes both private and public messages for bob and carol, carol and bob also write public and privet messages for alice and each other
        // Bob, Alice and Carol should only be able to see private messages pertaining to themselves, and any public messages filtered by an author
        // Bob, Alice and Carol should be able to filter for ONLY public messages or ONLY private messages

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // install the free-for-all protocol on Alice's DWN
        const protocolConfigure = await TestDataGenerator.generateProtocolsConfigure({
          author             : alice,
          protocolDefinition : freeForAll
        });
        const protocolConfigureReply = await dwn.processMessage(alice.did, protocolConfigure.message);
        expect(protocolConfigureReply.status.code).toBe(202);

        // write private records for bob and carol
        const alicePrivateToBob = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });

        const alicePrivateToBobReply = await dwn.processMessage(alice.did, alicePrivateToBob.message, { dataStream: alicePrivateToBob.dataStream });
        expect(alicePrivateToBobReply.status.code).toBe(202);

        const alicePrivateToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const alicePrivateToCarolReply = await dwn.processMessage(alice.did, alicePrivateToCarol.message, {
          dataStream: alicePrivateToCarol.dataStream
        });
        expect(alicePrivateToCarolReply.status.code).toBe(202);

        // write private records from carol to alice and bob
        const carolPrivateToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const carolPrivateToAliceReply = await dwn.processMessage(alice.did, carolPrivateToAlice.message, {
          dataStream: carolPrivateToAlice.dataStream
        });
        expect(carolPrivateToAliceReply.status.code).toBe(202);

        const carolPrivateToBob = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const carolPrivateToBobReply = await dwn.processMessage(alice.did, carolPrivateToBob.message, {
          dataStream: carolPrivateToBob.dataStream
        });
        expect(carolPrivateToBobReply.status.code).toBe(202);

        // write private records from bob to alice and carol
        const bobPrivateToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });

        const bobPrivateToAliceReply = await dwn.processMessage(alice.did, bobPrivateToAlice.message, {
          dataStream: bobPrivateToAlice.dataStream
        });
        expect(bobPrivateToAliceReply.status.code).toBe(202);

        const bobPrivateToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
        });
        const bobPrivateToCarolReply = await dwn.processMessage(alice.did, bobPrivateToCarol.message, {
          dataStream: bobPrivateToCarol.dataStream
        });
        expect(bobPrivateToCarolReply.status.code).toBe(202);

        // write public records from alice to bob and carol
        const alicePublicToBob = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const alicePublicToBobReply = await dwn.processMessage(alice.did, alicePublicToBob.message, {
          dataStream: alicePublicToBob.dataStream
        });
        expect(alicePublicToBobReply.status.code).toBe(202);

        const alicePublicToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const alicePublicToCarolReply = await dwn.processMessage(alice.did, alicePublicToCarol.message, {
          dataStream: alicePublicToCarol.dataStream
        });
        expect(alicePublicToCarolReply.status.code).toBe(202);

        // write public records from bob to alice and carol
        const bobPublicToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const bobPublicToAliceReply = await dwn.processMessage(alice.did, bobPublicToAlice.message, {
          dataStream: bobPublicToAlice.dataStream
        });
        expect(bobPublicToAliceReply.status.code).toBe(202);

        const bobPublicToCarol = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          recipient    : carol.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const bobPublicToCarolReply = await dwn.processMessage(alice.did, bobPublicToCarol.message, {
          dataStream: bobPublicToCarol.dataStream
        });
        expect(bobPublicToCarolReply.status.code).toBe(202);

        // write public records from carol to alice and bob
        const carolPublicToAlice = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : alice.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const carolPublicToAliceReply = await dwn.processMessage(alice.did, carolPublicToAlice.message, {
          dataStream: carolPublicToAlice.dataStream
        });
        expect(carolPublicToAliceReply.status.code).toBe(202);

        const carolPublicToBob = await TestDataGenerator.generateRecordsWrite({
          author       : carol,
          recipient    : bob.did,
          protocol     : freeForAll.protocol,
          protocolPath : 'post',
          schema       : freeForAll.types.post.schema,
          dataFormat   : freeForAll.types.post.dataFormats[0],
          published    : true
        });
        const carolPublicToBobReply = await dwn.processMessage(alice.did, carolPublicToBob.message, {
          dataStream: carolPublicToBob.dataStream
        });
        expect(carolPublicToBobReply.status.code).toBe(202);

        // bob queries for records with himself and alice as authors
        const bobQueryMessagesForBobAlice = await TestDataGenerator.generateRecordsQuery({
          author : bob,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', author: [bob.did, alice.did] }
        });
        const bobQueryMessagesForBobAliceReply = await dwn.processMessage(alice.did, bobQueryMessagesForBobAlice.message);
        expect(bobQueryMessagesForBobAliceReply.status.code).toBe(200);
        expect(bobQueryMessagesForBobAliceReply.entries?.length).toBe(7);

        // Since Bob is the author if the query, we expect for him to be able to see:
        // Private Messages Bob authored TO ANYONE
        // Private Messages Alice authored To Bob
        // Public Messages Alice authored
        // Public Messages Bob authored
        expect(bobQueryMessagesForBobAliceReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          alicePrivateToBob.message.recordId,
          bobPrivateToAlice.message.recordId,
          bobPrivateToCarol.message.recordId,
          alicePublicToBob.message.recordId,
          alicePublicToCarol.message.recordId,
          bobPublicToAlice.message.recordId,
          bobPublicToCarol.message.recordId
        ]));

        // carol queries for records with herself as the author
        const carolQueryMessagesForCarolAlice = await TestDataGenerator.generateRecordsQuery({
          author : carol,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', author: carol.did }
        });
        const carolQueryMessagesForCarolAliceReply = await dwn.processMessage(alice.did, carolQueryMessagesForCarolAlice.message);
        expect(carolQueryMessagesForCarolAliceReply.status.code).toBe(200);
        expect(carolQueryMessagesForCarolAliceReply.entries?.length).toBe(4);

        // Since Carol is the author if the query, we expect for her to be able to see:
        // All messages that Carol sent to anyone, private or public
        expect(carolQueryMessagesForCarolAliceReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          carolPrivateToAlice.message.recordId,
          carolPrivateToBob.message.recordId,
          carolPublicToAlice.message.recordId,
          carolPublicToBob.message.recordId
        ]));

        // alice queries for ONLY published records with herself and bob as authors
        const aliceQueryPublished = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', author: [alice.did, bob.did], published: true }
        });
        const aliceQueryPublishedReply = await dwn.processMessage(alice.did, aliceQueryPublished.message);
        expect(aliceQueryPublishedReply.status.code).toBe(200);
        expect(aliceQueryPublishedReply.entries?.length).toBe(4);
        expect(aliceQueryPublishedReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          alicePublicToBob.message.recordId,
          alicePublicToCarol.message.recordId,
          bobPublicToAlice.message.recordId,
          bobPublicToCarol.message.recordId
        ]));

        // carol queries for ONLY private records with herself and alice as the authors
        const carolQueryPrivate = await TestDataGenerator.generateRecordsQuery({
          author : carol,
          filter : { protocol: freeForAll.protocol, protocolPath: 'post', author: [carol.did, alice.did], published: false }
        });
        const carolQueryPrivateReply = await dwn.processMessage(alice.did, carolQueryPrivate.message);
        expect(carolQueryPrivateReply.status.code).toBe(200);
        expect(carolQueryPrivateReply.entries?.length).toBe(3);
        expect(carolQueryPrivateReply.entries!.map(e => e.recordId)).toEqual(expect.arrayContaining([
          alicePrivateToCarol.message.recordId,
          carolPrivateToAlice.message.recordId,
          carolPrivateToBob.message.recordId
        ]));
      });

      it('should paginate correctly for fetchRecordsAsNonOwner()', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const schema = 'schema1';

        // published messages bob
        const bobPublishedPromise = Array(5).fill({}).map(_ => TestDataGenerator.generateRecordsWrite({
          author: bob, schema, data: TestDataGenerator.randomBytes(10), published: true,
        }));

        // published messages alice
        const alicePublishedPromise = Array(5).fill({}).map(_ => TestDataGenerator.generateRecordsWrite({
          author: alice, schema, data: TestDataGenerator.randomBytes(10), published: true,
        }));

        // alice non public messages
        const aliceMessagesPromise = Array(5).fill({}).map(_ => TestDataGenerator.generateRecordsWrite({
          author: alice, schema, data: TestDataGenerator.randomBytes(10)
        }));

        // bob non public messages
        const bobMessagesPromise = Array(5).fill({}).map(_ => TestDataGenerator.generateRecordsWrite({
          author: bob, schema, data: TestDataGenerator.randomBytes(10)
        }));

        // non public messages intended for bob
        const aliceMessagesForBobPromise = Array(5).fill({}).map(_ => TestDataGenerator.generateRecordsWrite({
          author: alice, schema, data: TestDataGenerator.randomBytes(10), recipient: bob.did,
        }));

        const messagePromises = [
          ...bobPublishedPromise,
          ...aliceMessagesPromise,
          ...bobMessagesPromise,
          ...alicePublishedPromise,
          ...aliceMessagesForBobPromise,
        ];

        const recordsWriteHandler = new RecordsWriteHandler({
          didResolver, messageStore, dataStore, coreProtocols         : new CoreProtocolRegistry(), eventLog,
          validationStateReader : createTestValidationStateReader({ messageStore, dataStore }),
        });

        const messages: GenericMessage[] = [];
        for await (const { recordsWrite, message, dataBytes } of messagePromises) {
          const indexes = await recordsWrite.constructIndexes(true);
          const processedMessage = await recordsWriteHandler.cloneAndAddEncodedData(message, dataBytes!);
          await messageStore.put(alice.did, processedMessage, indexes);
          messages.push(processedMessage);
        }

        const sortedMessages = await ArrayUtility.asyncSort(
          messages as RecordsWriteMessage[],
          async (a,b) => Message.compareMessageTimestamp(a,b)
        );

        const aliceRetrieved: GenericMessage[] = [];

        // fetch all from alice for sanity, alice should get all of the records
        // page1 alice
        const aliceQueryMessageDataPage1 = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          filter     : { schema },
          dateSort   : DateSort.CreatedAscending,
          pagination : { limit: 10 },
        });

        let results = await dwn.processMessage(alice.did, aliceQueryMessageDataPage1.message) ;
        expect(results.status.code).toBe(200);
        expect(results.entries?.length).toBe(10, 'alice page 1');
        expect(results.cursor, 'alice page 1 cursor').toBeDefined();
        aliceRetrieved.push(...results.entries!);

        // page2 alice
        const aliceQueryMessageDataPage2 = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          filter     : { schema },
          dateSort   : DateSort.CreatedAscending,
          pagination : { limit: 10, cursor: results.cursor },
        });
        results = await dwn.processMessage(alice.did, aliceQueryMessageDataPage2.message) ;
        expect(results.status.code).toBe(200);
        expect(results.entries?.length).toBe(10, 'alice page 2');
        expect(results.cursor, 'alice page 2 cursor').toBeDefined();
        aliceRetrieved.push(...results.entries!);

        // page3 alice
        const aliceQueryMessageDataPage3 = await TestDataGenerator.generateRecordsQuery({
          author     : alice,
          filter     : { schema },
          dateSort   : DateSort.CreatedAscending,
          pagination : { limit: 10, cursor: results.cursor },
        });
        results = await dwn.processMessage(alice.did, aliceQueryMessageDataPage3.message) ;
        expect(results.status.code).toBe(200);
        expect(results.entries?.length).toBe(5, 'alice page 3');
        expect(results.cursor, 'alice page 3 cursor').toBeUndefined();
        aliceRetrieved.push(...results.entries!);

        const compareRecordId = (a: GenericMessage, b:GenericMessage): boolean => {
          return (a as RecordsWriteMessage).recordId === (b as RecordsWriteMessage).recordId;
        };
        expect(sortedMessages.every((m, i) => compareRecordId(aliceRetrieved.at(i)!, m)));

        const bobs = (m: RecordsWriteMessage): boolean => {
          return m.descriptor.recipient === bob.did || m.descriptor.published === true || Message.getSigner(m) === bob.did;
        };

        // all records from alice have been validated
        // now we prepare to test records that only bob should get

        const bobSorted = sortedMessages.filter(m => bobs(m as RecordsWriteMessage));
        const bobRetrieved: GenericMessage[] = [];

        const bobQueryMessagePage1 = await TestDataGenerator.generateRecordsQuery({
          author     : bob,
          filter     : { schema },
          dateSort   : DateSort.CreatedAscending,
          pagination : { limit: 10 },
        });
        results = await dwn.processMessage(alice.did, bobQueryMessagePage1.message) ;
        expect(results.status.code).toBe(200);
        expect(results.entries?.length).toBe(10, 'bob page 1');
        expect(results.cursor, 'bob page 1 cursor').toBeDefined();
        bobRetrieved.push(...results.entries!);

        const bobQueryMessagePage2 = await TestDataGenerator.generateRecordsQuery({
          author     : bob,
          filter     : { schema },
          dateSort   : DateSort.CreatedAscending,
          pagination : { limit: 10, cursor: results.cursor },
        });
        results = await dwn.processMessage(alice.did, bobQueryMessagePage2.message) ;
        expect(results.status.code).toBe(200);
        expect(results.entries?.length).toBe(10, 'bob page 2');
        expect(results.cursor, 'bob page 2 cursor').toBeUndefined();
        bobRetrieved.push(...results.entries!);

        expect(bobSorted.every((m, i) => compareRecordId(bobRetrieved.at(i)!, m)));
      });

      // https://github.com/enboxorg/enbox/issues/170
      it('#170 - should treat records with `published` explicitly set to `false` as unpublished', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        const schema = 'schema1';
        const unpublishedRecordsWrite = await TestDataGenerator.generateRecordsWrite(
          { author: alice, schema, data: Encoder.stringToBytes('1'), published: false } // explicitly setting `published` to `false`
        );

        const result1 = await dwn.processMessage(alice.did, unpublishedRecordsWrite.message, { dataStream: unpublishedRecordsWrite.dataStream });
        expect(result1.status.code).toBe(202);

        // alice should be able to see the unpublished record
        const queryByAlice = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema }
        });
        const replyToAliceQuery = await dwn.processMessage(alice.did, queryByAlice.message);
        expect(replyToAliceQuery.status.code).toBe(200);
        expect(replyToAliceQuery.entries?.length).toBe(1);

        // actual test: bob should not be able to see unpublished record
        const queryByBob = await TestDataGenerator.generateRecordsQuery({
          author : bob,
          filter : { schema }
        });
        const replyToBobQuery = await dwn.processMessage(alice.did, queryByBob.message);
        expect(replyToBobQuery.status.code).toBe(200);
        expect(replyToBobQuery.entries?.length).toBe(0);
      });

      it('should allow DWN owner to use `recipient` as a filter in queries', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        const bobQueryMessageData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { recipient: bob.did } // alice as the DWN owner querying bob's records
        });

        const replyToBobQuery = await dwn.processMessage(alice.did, bobQueryMessageData.message);

        expect(replyToBobQuery.status.code).toBe(200);
      });

      it('should not fetch entries across tenants', async () => {
      // insert three messages into DB, two with matching schema
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
        await TestDataGenerator.installDefaultTestProtocol(dwn, bob);
        const schema = 'myAwesomeSchema';
        const recordsWriteMessage1Data = await TestDataGenerator.generateRecordsWrite({ author: alice, schema });
        const recordsWriteMessage2Data = await TestDataGenerator.generateRecordsWrite({ author: bob, schema });

        const aliceQueryMessageData = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema }
        });

        // insert data into 2 different tenants
        await dwn.processMessage(alice.did, recordsWriteMessage1Data.message, { dataStream: recordsWriteMessage1Data.dataStream });
        await dwn.processMessage(bob.did, recordsWriteMessage2Data.message, { dataStream: recordsWriteMessage2Data.dataStream });

        const reply = await dwn.processMessage(alice.did, aliceQueryMessageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(1);
      });

      it('should return 400 if protocol is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // query for non-normalized protocol
        const recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { protocol: 'example.com/' },
        });

        // overwrite protocol because #create auto-normalizes protocol
        recordsQuery.message.descriptor.filter.protocol = 'example.com/';

        // Re-create auth because we altered the descriptor after signing
        recordsQuery.message.authorization = await Message.createAuthorization({
          descriptor : recordsQuery.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records write message
        const reply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.UrlProtocolNotNormalized);
      });

      it('should return 400 if schema is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // query for non-normalized schema
        const recordsQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'example.com/' },
        });

        // overwrite schema because #create auto-normalizes schema
        recordsQuery.message.descriptor.filter.schema = 'example.com/';

        // Re-create auth because we altered the descriptor after signing
        recordsQuery.message.authorization = await Message.createAuthorization({
          descriptor : recordsQuery.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records write message
        const reply = await dwn.processMessage(alice.did, recordsQuery.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.UrlSchemaNotNormalized);
      });

      it('should return 400 if published is set to false and a datePublished range is provided', async () => {
        const fromDatePublished = Time.getCurrentTimestamp();
        const alice = await TestDataGenerator.generateDidKeyPersona();
        // set to true so create does not fail
        const recordQuery = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { datePublished: { from: fromDatePublished }, published: true }
        });

        // set to false
        recordQuery.message.descriptor.filter.published = false;
        const queryResponse = await dwn.processMessage(alice.did, recordQuery.message);
        expect(queryResponse.status.code).toBe(400);
        expect(queryResponse.status.detail).toContain('descriptor/filter/published: must be equal to one of the allowed values');
      });

      it('should return 401 for anonymous queries that filter explicitly for unpublished records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

        // create an unpublished record
        const draftWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'post' });
        const draftWriteReply = await dwn.processMessage(alice.did, draftWrite.message, { dataStream: draftWrite.dataStream });
        expect(draftWriteReply.status.code).toBe(202);

        // validate that alice can query
        const unpublishedPostQuery = await TestDataGenerator.generateRecordsQuery({ author: alice, filter: { schema: 'post', published: false } });
        const unpublishedPostReply = await dwn.processMessage(alice.did, unpublishedPostQuery.message);
        expect(unpublishedPostReply.status.code).toBe(200);
        expect(unpublishedPostReply.entries?.length).toBe(1);
        expect(unpublishedPostReply.entries![0].recordId).toBe(draftWrite.message.recordId);

        // anonymous query for unpublished records
        const unpublishedAnonymous = await RecordsQuery.create({ filter: { schema: 'post', published: false } });
        const anonymousPostReply = await dwn.processMessage(alice.did, unpublishedAnonymous.message);
        expect(anonymousPostReply.status.code).toBe(401);
        expect(anonymousPostReply.status.detail).toContain('Missing JWS');
      });

      describe('protocol based queries', () => {
        it('should return message scoped to the given `contextId`', async () => {
          // scenario:
          // 0. Alice installs a nested protocol foo -> bar -> baz
          // 1. Alice writes 2 foos, 2 bars under foo1, and 2 bazes under bar1
          // 2. Alice should be able to query for all messages under foo1
          // 3. Alice should be able to query for all messages under bar1
          // 4. Alice should be able to query for all messages under baz1

          const alice = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = nestedProtocol as ProtocolDefinition;

          // 0. Alice installs a nested protocol foo -> bar -> baz
          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // 1. Alice writes 2 foos, 2 bars under foo1, and 2 bazes under bar1

          // write 2 foos
          const fooOptions = {
            author       : alice,
            protocol     : nestedProtocol.protocol,
            protocolPath : 'foo',
            schema       : nestedProtocol.types.foo.schema,
            dataFormat   : nestedProtocol.types.foo.dataFormats[0],
          };

          const foo1 = await TestDataGenerator.generateRecordsWrite(fooOptions);
          const foo1WriteResponse = await dwn.processMessage(alice.did, foo1.message, { dataStream: foo1.dataStream });
          expect(foo1WriteResponse.status.code).toBe(202);

          const foo2 = await TestDataGenerator.generateRecordsWrite(fooOptions);
          const foo2WriteResponse = await dwn.processMessage(alice.did, foo2.message, { dataStream: foo2.dataStream });
          expect(foo2WriteResponse.status.code).toBe(202);

          // write 2 bars under foo1
          const barOptions = {
            author          : alice,
            protocol        : nestedProtocol.protocol,
            protocolPath    : 'foo/bar',
            schema          : nestedProtocol.types.bar.schema,
            dataFormat      : nestedProtocol.types.bar.dataFormats[0],
            parentContextId : foo1.message.contextId
          };

          const bar1 = await TestDataGenerator.generateRecordsWrite(barOptions);
          const bar1WriteResponse = await dwn.processMessage(alice.did, bar1.message, { dataStream: bar1.dataStream });
          expect(bar1WriteResponse.status.code).toBe(202);

          const bar2 = await TestDataGenerator.generateRecordsWrite(barOptions);
          const bar2WriteResponse = await dwn.processMessage(alice.did, bar2.message, { dataStream: bar2.dataStream });
          expect(bar2WriteResponse.status.code).toBe(202);

          // write 2 bazes under bar1
          const bazOptions = {
            author          : alice,
            protocol        : nestedProtocol.protocol,
            protocolPath    : 'foo/bar/baz',
            schema          : nestedProtocol.types.baz.schema,
            dataFormat      : nestedProtocol.types.baz.dataFormats[0],
            parentContextId : bar1.message.contextId
          };

          const baz1 = await TestDataGenerator.generateRecordsWrite(bazOptions);
          const baz1WriteResponse = await dwn.processMessage(alice.did, baz1.message, { dataStream: baz1.dataStream });
          expect(baz1WriteResponse.status.code).toBe(202);

          const baz2 = await TestDataGenerator.generateRecordsWrite(bazOptions);
          const baz2WriteResponse = await dwn.processMessage(alice.did, baz2.message, { dataStream: baz2.dataStream });
          expect(baz2WriteResponse.status.code).toBe(202);

          // 2. Alice should be able to query for all messages under foo1
          const foo1ContextIdQuery = await TestDataGenerator.generateRecordsQuery({
            author : alice,
            filter : { contextId: foo1.message.contextId }
          });
          const foo1ContextIdQueryReply = await dwn.processMessage(alice.did, foo1ContextIdQuery.message);
          expect(foo1ContextIdQueryReply.status.code).toBe(200);
          expect(foo1ContextIdQueryReply.entries?.length).toBe(5);
          expect(foo1ContextIdQueryReply.entries!.map((entry) => entry.recordId)).toEqual(expect.arrayContaining([
            foo1.message.recordId,
            bar1.message.recordId,
            bar2.message.recordId,
            baz1.message.recordId,
            baz2.message.recordId
          ]));

          // 3. Alice should be able to query for all messages under bar1
          const bar1ContextIdQuery = await TestDataGenerator.generateRecordsQuery({
            author : alice,
            filter : { contextId: bar1.message.contextId }
          });
          const bar1ContextIdQueryReply = await dwn.processMessage(alice.did, bar1ContextIdQuery.message);
          expect(bar1ContextIdQueryReply.status.code).toBe(200);
          expect(bar1ContextIdQueryReply.entries?.length).toBe(3);
          expect(bar1ContextIdQueryReply.entries!.map((entry) => entry.recordId)).toEqual(expect.arrayContaining([
            bar1.message.recordId,
            baz1.message.recordId,
            baz2.message.recordId
          ]));

          // 4. Alice should be able to query for all messages under baz1
          const baz1ContextIdQuery = await TestDataGenerator.generateRecordsQuery({
            author : alice,
            filter : { contextId: baz1.message.contextId }
          });
          const baz1ContextIdQueryReply = await dwn.processMessage(alice.did, baz1ContextIdQuery.message);
          expect(baz1ContextIdQueryReply.status.code).toBe(200);
          expect(baz1ContextIdQueryReply.entries?.length).toBe(1);
          expect(baz1ContextIdQueryReply.entries!.map((entry) => entry.recordId)).toEqual(expect.arrayContaining([ baz1.message.recordId ]));
        });

        it('does not try protocol authorization if protocolRole is not invoked', async () => {
          // scenario: Alice creates a thread and writes some chat messages. Alice addresses
          //           only one chat message to Bob. Bob queries by protocol URI without invoking a protocolRole,
          //           and he is able to receive the message addressed to him.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          // Alice writes one 'chat' record addressed to Bob
          const chatRecordForBob = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/chat',
            published       : false,
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
          });
          const chatRecordForBobReply = await dwn.processMessage(alice.did, chatRecordForBob.message, { dataStream: chatRecordForBob.dataStream });
          expect(chatRecordForBobReply.status.code).toBe(202);

          // Alice writes two 'chat' records NOT addressed to Bob
          for (let i = 0; i < 2; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              published       : false,
              parentContextId : threadRecord.message.contextId,
              data            : new TextEncoder().encode('Bob cannot read this'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
          }

          // Bob queries without invoking any protocolRole
          const chatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol: protocolDefinition.protocol,
            },
          });
          const chatQueryReply = await dwn.processMessage(alice.did, chatQuery.message);
          expect(chatQueryReply.status.code).toBe(200);
          expect(chatQueryReply.entries?.length).toBe(1);
          expect(chatQueryReply.entries![0].recordId).toBe(chatRecordForBob.message.recordId);

          // bob queries without invoking any protocolRole and filters for unpublished records
          const unpublishedChatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              published : false,
              protocol  : protocolDefinition.protocol,
            },
          });
          const unpublishedChatReply = await dwn.processMessage(alice.did, unpublishedChatQuery.message);
          expect(unpublishedChatReply.status.code).toBe(200);
          expect(unpublishedChatReply.entries?.length).toBe(1);
          expect(unpublishedChatReply.entries![0].recordId).toBe(chatRecordForBob.message.recordId);

        });

        it('allows root-level role authorized queries', async () => {
          // scenario: Alice creates a thread and writes some chat messages writes a chat message. Bob invokes his
          //           thread member role in order to query the chat messages.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const friendRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'friend',
            data         : new TextEncoder().encode('Bob is my friend'),
          });
          const friendRoleReply = await dwn.processMessage(alice.did, friendRoleRecord.message, { dataStream: friendRoleRecord.dataStream });
          expect(friendRoleReply.status.code).toBe(202);

          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              published    : false,
              data         : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // Bob invokes his friendRole to query that records
          const chatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
            },
            protocolRole: 'friend',
          });
          const chatQueryReply = await dwn.processMessage(alice.did, chatQuery.message);
          expect(chatQueryReply.status.code).toBe(200);
          expect(chatQueryReply.entries?.length).toBe(3);
          expect(chatQueryReply.entries!.map((record) => record.recordId)).toEqual(expect.arrayContaining(chatRecordIds));

          // Bob invokes his friendRole along with an explicit filter for unpublished records
          const unpublishedChatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              published    : false,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
            },
            protocolRole: 'friend',
          });
          const unpublishedChatReply = await dwn.processMessage(alice.did, unpublishedChatQuery.message);
          expect(unpublishedChatReply.status.code).toBe(200);
          expect(unpublishedChatReply.entries?.length).toBe(3);
          expect(unpublishedChatReply.entries!.map((record) => record.recordId)).toEqual(expect.arrayContaining(chatRecordIds));
        });

        it('can authorize queries using a context role.', async () => {
          // scenario: Alice writes some chat messages. Bob invokes his friend role in order to query the chat messages.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          // Alice writes a 'participant' role record with Bob as recipient
          const participantRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/participant',
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob is my friend'),
          });
          const participantRoleReply =
            await dwn.processMessage(alice.did, participantRoleRecord.message, { dataStream: participantRoleRecord.dataStream });
          expect(participantRoleReply.status.code).toBe(202);

          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              published       : false,
              parentContextId : threadRecord.message.contextId,
              data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // Bob invokes his friendRole to query that records
          const chatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/chat',
              contextId    : threadRecord.message.contextId,
            },
            protocolRole: 'thread/participant',
          });
          const chatQueryReply = await dwn.processMessage(alice.did, chatQuery.message) as RecordsQueryReply;
          expect(chatQueryReply.status.code).toBe(200);
          expect(chatQueryReply.entries?.length).toBe(3);
          expect(chatQueryReply.entries!.map((record) => record.recordId)).toEqual(expect.arrayContaining(chatRecordIds));
        });

        it('does not execute protocol queries where protocolPath is missing from the filter', async () => {
          // scenario: Alice gives Bob a root-level role and writes some chat messages. Bob invokes his root-level role to query those messages,
          //           but his query filter does not include protocolPath.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const friendRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'friend',
            data         : new TextEncoder().encode('Bob is my friend'),
          });
          const friendRoleReply = await dwn.processMessage(alice.did, friendRoleRecord.message, { dataStream: friendRoleRecord.dataStream });
          expect(friendRoleReply.status.code).toBe(202);

          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              published    : false,
              data         : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // Bob invokes his friendRole to query but does not have `protocolPath` in the filter
          const chatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol: protocolDefinition.protocol,
              // protocolPath deliberately omitted
            },
            protocolRole: 'friend',
          });
          const chatQueryReply = await dwn.processMessage(alice.did, chatQuery.message) as RecordsQueryReply;
          expect(chatQueryReply.status.code).toBe(400);
          expect(chatQueryReply.status.detail).toContain(DwnErrorCode.RecordsQueryFilterMissingRequiredProperties);
        });

        it('does not execute context role authorized queries where contextId is missing from the filter', async () => {
          // scenario: Alice writes some chat messages and gives Bob a role allowing him to access them. But Bob's filter
          //           does not contain a contextId so the query fails.
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const participantRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/participant',
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob is my friend'),
          });
          const participantRoleReply =
            await dwn.processMessage(alice.did, participantRoleRecord.message, { dataStream: participantRoleRecord.dataStream });
          expect(participantRoleReply.status.code).toBe(202);

          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              published       : false,
              parentContextId : threadRecord.message.contextId,
              data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // Bob invokes his thread participant role to query
          const chatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/chat',
              // contextId deliberately omitted
            },
            protocolRole: 'thread/participant',
          });
          const chatQueryReply = await dwn.processMessage(alice.did, chatQuery.message) as RecordsQueryReply;
          expect(chatQueryReply.status.code).toBe(400);
          expect(chatQueryReply.status.detail).toContain(DwnErrorCode.RecordsQueryNestedProtocolPathContextIdInvalid);
        });

        it('rejects root-filter queries that invoke a nested role without a contextId', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          const threadQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread',
            },
            protocolRole: 'thread/participant',
          });

          const threadQueryReply = await dwn.processMessage(alice.did, threadQuery.message) as RecordsQueryReply;
          expect(threadQueryReply.status.code).toBe(401);
          expect(threadQueryReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMissingContextId);
        });

        it('should reject root-level role authorized queries if a matching root-level role record is not found for the message author', async () => {
          // scenario: Alice creates a thread and writes some chat messages writes a chat message.
          //           Bob invokes a root-level role but fails because he does not actually have a role.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              published    : false,
              data         : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // Bob invokes his friendRole to query that records
          const chatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
            },
            protocolRole: 'friend',
          });
          const chatQueryReply = await dwn.processMessage(alice.did, chatQuery.message) as RecordsQueryReply;
          expect(chatQueryReply.status.code).toBe(401);
          expect(chatQueryReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
        });

        it('should reject context role authorized queries if a matching context role record is not found for the message author', async () => {

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).toBe(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).toBe(202);

          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              published       : false,
              parentContextId : threadRecord.message.contextId,
              data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).toBe(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // Bob invokes his friendRole to query that records
          const chatQuery = await TestDataGenerator.generateRecordsQuery({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/chat',
              contextId    : threadRecord.message.contextId,
            },
            protocolRole: 'thread/participant',
          });
          const chatQueryReply = await dwn.processMessage(alice.did, chatQuery.message) as RecordsQueryReply;
          expect(chatQueryReply.status.code).toBe(401);
          expect(chatQueryReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
        });

        describe('who-based query/subscribe action rules', () => {
          // Protocol with who-based read/query/subscribe rules for both recipient and author
          const whoQueryProtocol: ProtocolDefinition = {
            published : true,
            protocol  : 'http://who-query-test.xyz',
            types     : {
              message: {
                dataFormats: ['text/plain'],
              },
            },
            structure: {
              message: {
                $actions: [
                  { who: 'anyone', can: ['create'] },
                  { who: 'author', of: 'message', can: ['read'] },
                  { who: 'recipient', of: 'message', can: ['read'] },
                ],
              },
            },
          };

          it('recipient can query records addressed to them via who-based rule', async () => {
            // scenario: Alice writes messages to Bob and Carol on her DWN.
            //           Bob queries — sees only his messages. Carol queries — sees only hers.
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const carol = await TestDataGenerator.generateDidKeyPersona();

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : whoQueryProtocol,
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice writes 2 messages for Bob
            const bobRecordIds: string[] = [];
            for (let i = 0; i < 2; i++) {
              const msg = await TestDataGenerator.generateRecordsWrite({
                author       : alice,
                recipient    : bob.did,
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
                published    : false,
                dataFormat   : 'text/plain',
                data         : new TextEncoder().encode(`message for bob ${i}`),
              });
              const reply = await dwn.processMessage(alice.did, msg.message, { dataStream: msg.dataStream });
              expect(reply.status.code).toBe(202);
              bobRecordIds.push(msg.message.recordId);
            }

            // Alice writes 1 message for Carol
            const carolMsg = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : carol.did,
              protocol     : whoQueryProtocol.protocol,
              protocolPath : 'message',
              published    : false,
              dataFormat   : 'text/plain',
              data         : new TextEncoder().encode('message for carol'),
            });
            const carolWriteReply = await dwn.processMessage(alice.did, carolMsg.message, { dataStream: carolMsg.dataStream });
            expect(carolWriteReply.status.code).toBe(202);

            // Bob queries — should see exactly his 2 messages
            const bobQuery = await TestDataGenerator.generateRecordsQuery({
              author : bob,
              filter : {
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
              },
            });
            const bobQueryReply = await dwn.processMessage(alice.did, bobQuery.message) as RecordsQueryReply;
            expect(bobQueryReply.status.code).toBe(200);
            expect(bobQueryReply.entries?.length).toBe(2);
            expect(bobQueryReply.entries!.map((e) => e.recordId)).toEqual(expect.arrayContaining(bobRecordIds));

            // Carol queries — should see exactly her 1 message
            const carolQuery = await TestDataGenerator.generateRecordsQuery({
              author : carol,
              filter : {
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
              },
            });
            const carolQueryReply = await dwn.processMessage(alice.did, carolQuery.message) as RecordsQueryReply;
            expect(carolQueryReply.status.code).toBe(200);
            expect(carolQueryReply.entries?.length).toBe(1);
            expect(carolQueryReply.entries![0].recordId).toBe(carolMsg.message.recordId);
          });

          it('author can query their own records via who-based rule', async () => {
            // scenario: Bob writes a message to Alice's DWN. Bob queries Alice's DWN
            //           and sees the message he authored. Carol does not see it.
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const carol = await TestDataGenerator.generateDidKeyPersona();

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : whoQueryProtocol,
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Bob writes a message to Alice's DWN (anyone can create)
            const bobMsg = await TestDataGenerator.generateRecordsWrite({
              author       : bob,
              recipient    : alice.did,
              protocol     : whoQueryProtocol.protocol,
              protocolPath : 'message',
              published    : false,
              dataFormat   : 'text/plain',
              data         : new TextEncoder().encode('message from bob'),
            });
            const bobWriteReply = await dwn.processMessage(alice.did, bobMsg.message, { dataStream: bobMsg.dataStream });
            expect(bobWriteReply.status.code).toBe(202);

            // Bob queries — should see the message he authored
            const bobQuery = await TestDataGenerator.generateRecordsQuery({
              author : bob,
              filter : {
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
              },
            });
            const bobQueryReply = await dwn.processMessage(alice.did, bobQuery.message) as RecordsQueryReply;
            expect(bobQueryReply.status.code).toBe(200);
            expect(bobQueryReply.entries?.length).toBe(1);
            expect(bobQueryReply.entries![0].recordId).toBe(bobMsg.message.recordId);

            // Carol queries — should see nothing (she is neither author nor recipient)
            const carolQuery = await TestDataGenerator.generateRecordsQuery({
              author : carol,
              filter : {
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
              },
            });
            const carolQueryReply = await dwn.processMessage(alice.did, carolQuery.message) as RecordsQueryReply;
            expect(carolQueryReply.status.code).toBe(200);
            expect(carolQueryReply.entries?.length).toBe(0);
          });

          it('unauthorized party cannot see any unpublished records via query', async () => {
            // scenario: Alice writes unpublished messages. Dave (not author, not recipient)
            //           queries and gets an empty result — no records leak.
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const dave = await TestDataGenerator.generateDidKeyPersona();

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : whoQueryProtocol,
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice writes messages to Bob
            for (let i = 0; i < 3; i++) {
              const msg = await TestDataGenerator.generateRecordsWrite({
                author       : alice,
                recipient    : bob.did,
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
                published    : false,
                dataFormat   : 'text/plain',
                data         : new TextEncoder().encode(`secret message ${i}`),
              });
              const reply = await dwn.processMessage(alice.did, msg.message, { dataStream: msg.dataStream });
              expect(reply.status.code).toBe(202);
            }

            // Dave queries — he is neither author nor recipient of any record
            const daveQuery = await TestDataGenerator.generateRecordsQuery({
              author : dave,
              filter : {
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
              },
            });
            const daveQueryReply = await dwn.processMessage(alice.did, daveQuery.message) as RecordsQueryReply;
            expect(daveQueryReply.status.code).toBe(200);
            expect(daveQueryReply.entries?.length).toBe(0);

            // Dave queries with explicit unpublished filter — still sees nothing
            const daveUnpubQuery = await TestDataGenerator.generateRecordsQuery({
              author : dave,
              filter : {
                protocol     : whoQueryProtocol.protocol,
                protocolPath : 'message',
                published    : false,
              },
            });
            const daveUnpubReply = await dwn.processMessage(alice.did, daveUnpubQuery.message) as RecordsQueryReply;
            expect(daveUnpubReply.status.code).toBe(200);
            expect(daveUnpubReply.entries?.length).toBe(0);
          });

          it('who-based query rules do not grant role-like broad access', async () => {
            // scenario: Protocol has who-based query rules. A non-participant tries to invoke
            //           a protocolRole to get broader access. This should be rejected with 401
            //           because no matching role record exists.
            const alice = await TestDataGenerator.generateDidKeyPersona();
            const bob = await TestDataGenerator.generateDidKeyPersona();
            const dave = await TestDataGenerator.generateDidKeyPersona();

            // Protocol with both a role AND who-based rules
            const mixedProtocol: ProtocolDefinition = {
              published : true,
              protocol  : 'http://mixed-role-who.xyz',
              types     : {
                thread      : {},
                participant : {},
                chat        : { dataFormats: ['text/plain'] },
              },
              structure: {
                thread: {
                  participant: {
                    $role: true,
                  },
                  chat: {
                    $actions: [
                      { who: 'anyone', can: ['create'] },
                      { who: 'recipient', of: 'thread/chat', can: ['read'] },
                      { role: 'thread/participant', can: ['read'] },
                    ],
                  },
                },
              },
            };

            const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
              author             : alice,
              protocolDefinition : mixedProtocol,
            });
            const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
            expect(protocolsConfigureReply.status.code).toBe(202);

            // Alice creates a thread
            const threadRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              protocol     : mixedProtocol.protocol,
              protocolPath : 'thread',
            });
            const threadReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
            expect(threadReply.status.code).toBe(202);

            // Alice adds Bob as participant (role)
            const participantRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : bob.did,
              protocol        : mixedProtocol.protocol,
              protocolPath    : 'thread/participant',
              parentContextId : threadRecord.message.contextId,
            });
            const participantReply = await dwn.processMessage(alice.did, participantRecord.message, { dataStream: participantRecord.dataStream });
            expect(participantReply.status.code).toBe(202);

            // Alice writes chat messages
            for (let i = 0; i < 3; i++) {
              const chatRecord = await TestDataGenerator.generateRecordsWrite({
                author          : alice,
                recipient       : alice.did,
                protocol        : mixedProtocol.protocol,
                protocolPath    : 'thread/chat',
                parentContextId : threadRecord.message.contextId,
                published       : false,
                dataFormat      : 'text/plain',
                data            : new TextEncoder().encode(`chat message ${i}`),
              });
              const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
              expect(chatReply.status.code).toBe(202);
            }

            // Bob (who IS a participant) can query with his role — should succeed
            const bobRoleQuery = await TestDataGenerator.generateRecordsQuery({
              author : bob,
              filter : {
                protocol     : mixedProtocol.protocol,
                protocolPath : 'thread/chat',
                contextId    : threadRecord.message.contextId,
              },
              protocolRole: 'thread/participant',
            });
            const bobRoleQueryReply = await dwn.processMessage(alice.did, bobRoleQuery.message) as RecordsQueryReply;
            expect(bobRoleQueryReply.status.code).toBe(200);
            expect(bobRoleQueryReply.entries?.length).toBe(3);

            // Dave (who is NOT a participant) tries to invoke the role — should be rejected
            const daveRoleQuery = await TestDataGenerator.generateRecordsQuery({
              author : dave,
              filter : {
                protocol     : mixedProtocol.protocol,
                protocolPath : 'thread/chat',
                contextId    : threadRecord.message.contextId,
              },
              protocolRole: 'thread/participant',
            });
            const daveRoleQueryReply = await dwn.processMessage(alice.did, daveRoleQuery.message) as RecordsQueryReply;
            expect(daveRoleQueryReply.status.code).toBe(401);
            expect(daveRoleQueryReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);

            // Dave without a role still gets an empty result, not an error, when the nested query pins a single parent context.
            const daveNoRoleQuery = await TestDataGenerator.generateRecordsQuery({
              author : dave,
              filter : {
                contextId    : threadRecord.message.contextId,
                protocol     : mixedProtocol.protocol,
                protocolPath : 'thread/chat',
              },
            });
            const daveNoRoleQueryReply = await dwn.processMessage(alice.did, daveNoRoleQuery.message) as RecordsQueryReply;
            expect(daveNoRoleQueryReply.status.code).toBe(200);
            expect(daveNoRoleQueryReply.entries?.length).toBe(0);
          });
        });
      });
    });

    it('should return 401 if signature check fails', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsQuery();
      const tenant = author!.did;

      // setting up a stub did resolver & message store
      // intentionally not supplying the public key so a different public key is generated to simulate invalid signature
      const mismatchingPersona = await TestDataGenerator.generatePersona({ did: author!.did, keyId: author!.keyId });
      const didResolver = TestStubGenerator.createDidResolverStub(mismatchingPersona);
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const dataStoreStub = sinon.createStubInstance(DataStoreLevel);

      const recordsQueryHandler = new RecordsQueryHandler({
        didResolver, messageStore          : messageStoreStub, dataStore             : dataStoreStub,
        validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub, dataStore: dataStoreStub }),
      });
      const reply = await recordsQueryHandler.handle({ tenant, message });

      expect(reply.status.code).toBe(401);
    });

    it('should return 400 if fail parsing the message', async () => {
      const { author, message } = await TestDataGenerator.generateRecordsQuery();
      const tenant = author!.did;

      // setting up a stub method resolver & message store
      const didResolver = TestStubGenerator.createDidResolverStub(author!);
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const dataStoreStub = sinon.createStubInstance(DataStoreLevel);
      const recordsQueryHandler = new RecordsQueryHandler({
        didResolver, messageStore          : messageStoreStub, dataStore             : dataStoreStub,
        validationStateReader : createTestValidationStateReader({ messageStore: messageStoreStub, dataStore: dataStoreStub }),
      });

      // stub the `parse()` function to throw an error
      sinon.stub(RecordsQuery, 'parse').throws('anyError');
      const reply = await recordsQueryHandler.handle({ tenant, message });

      expect(reply.status.code).toBe(400);
    });
  });
}
