import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type {
  DataStore,
  MessageStore,
  ModulesConfigureMessage,
  ResumableTaskStore,
} from '../../src/index.js';

import sinon from 'sinon';

import { GeneralJwsBuilder } from '../../src/jose/jws/general/builder.js';
import { Message } from '../../src/core/message.js';
import { PermissionGrant } from '../../src/modules/permission-grant.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { Time } from '../../src/utils/time.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Jws, ModulesQuery, PermissionsModule, RecordsWrite } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testModulesQueryHandler(): void {
  describe('ModulesQueryHandler.handle()', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    describe('functional tests', () => {

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
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

      it('should return modules matching the query', async () => {
        const alice = await TestDataGenerator.generatePersona();

        // setting up a stub method resolver
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // insert three messages into DB, two with matching module
        const module1 = await TestDataGenerator.generateModulesConfigure({ author: alice });
        const module2 = await TestDataGenerator.generateModulesConfigure({ author: alice });
        const module3 = await TestDataGenerator.generateModulesConfigure({ author: alice });

        await dwn.processMessage(alice.did, module1.message);
        await dwn.processMessage(alice.did, module2.message);
        await dwn.processMessage(alice.did, module3.message);

        // testing singular conditional query
        const queryMessageData = await TestDataGenerator.generateModulesQuery({
          author : alice,
          filter : { module: module1.message.descriptor.definition.module }
        });

        const reply = await dwn.processMessage(alice.did, queryMessageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries).toHaveLength(1); // only 1 entry should match the query on module

        // testing fetch-all query without filter
        const queryMessageData2 = await TestDataGenerator.generateModulesQuery({
          author: alice
        });

        const reply2 = await dwn.processMessage(alice.did, queryMessageData2.message);

        expect(reply2.status.code).toBe(200);
        expect(reply2.entries).toHaveLength(3); // expecting all 3 entries written above match the query
      });


      it('should return published modules matching the query if query is unauthenticated or unauthorized', async () => {
        // scenario:
        // 1. Alice has 3 modules installed: 1 private + 2 published
        // 2. Unauthenticated ModulesQuery should return published ModulesConfigure
        // 3. Authenticated ModulesQuery by Bob but unauthorized to private ModulesConfigures should return published ModulesConfigure

        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();

        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

        // insert three messages into DB, two with matching module
        const module1 = await TestDataGenerator.generateModulesConfigure({ author: alice, published: false });
        const module2 = await TestDataGenerator.generateModulesConfigure({ author: alice, published: true });
        const module3 = await TestDataGenerator.generateModulesConfigure({ author: alice, published: true });

        await dwn.processMessage(alice.did, module1.message);
        await dwn.processMessage(alice.did, module2.message);
        await dwn.processMessage(alice.did, module3.message);

        // testing unauthenticated conditional query
        const conditionalQuery = await ModulesQuery.create({
          filter: { module: module2.message.descriptor.definition.module }
        });

        const conditionalQueryReply = await dwn.processMessage(alice.did, conditionalQuery.message);
        expect(conditionalQueryReply.status.code).toBe(200);
        expect(conditionalQueryReply.entries).toHaveLength(1); // only 1 entry should match the query on module

        const moduleConfigured = conditionalQueryReply.entries![0] as ModulesConfigureMessage;
        expect(moduleConfigured).toEqual(module2.message);

        // testing authenticated but unauthorized conditional query, it should return only matching published ModulesConfigures
        const signedConditionalQuery = await ModulesQuery.create({
          filter : { module: module2.message.descriptor.definition.module },
          signer : Jws.createSigner(bob)
        });

        const signedConditionalQueryReply = await dwn.processMessage(alice.did, signedConditionalQuery.message);
        expect(signedConditionalQueryReply.status.code).toBe(200);
        expect(signedConditionalQueryReply.entries).toHaveLength(1); // only 1 entry should match the query on module

        const moduleConfigured2 = conditionalQueryReply.entries![0] as ModulesConfigureMessage;
        expect(moduleConfigured2).toEqual(module2.message);

        // testing unauthenticated fetch-all query without filter
        const fetchAllQuery = await ModulesQuery.create({
        });

        const fetchAllQueryReply = await dwn.processMessage(alice.did, fetchAllQuery.message);
        expect(fetchAllQueryReply.status.code).toBe(200);
        expect(fetchAllQueryReply.entries).toHaveLength(2);
        expect(fetchAllQueryReply.entries).toContainEqual(module2.message);
        expect(fetchAllQueryReply.entries).toContainEqual(module3.message);

        // testing authenticated but unauthorized fetch-all query without filter, it should return all matching published ModulesConfigures
        const signedFetchAllQuery = await ModulesQuery.create({
          signer: Jws.createSigner(bob)
        });

        const signedFetchAllQueryReply = await dwn.processMessage(alice.did, signedFetchAllQuery.message);
        expect(signedFetchAllQueryReply.status.code).toBe(200);
        expect(signedFetchAllQueryReply.entries).toHaveLength(2);
        expect(signedFetchAllQueryReply.entries).toContainEqual(module2.message);
        expect(signedFetchAllQueryReply.entries).toContainEqual(module3.message);
      });

      it('should return 400 if module is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // query for non-normalized module
        const modulesQuery = await TestDataGenerator.generateModulesQuery({
          author : alice,
          filter : { module: 'example.com/' },
        });

      // overwrite module because #create auto-normalizes module
      modulesQuery.message.descriptor.filter!.module = 'example.com/';

      // Re-create auth because we altered the descriptor after signing
      modulesQuery.message.authorization = await Message.createAuthorization({
        descriptor : modulesQuery.message.descriptor,
        signer     : Jws.createSigner(alice)
      });

      // Send records write message
      const reply = await dwn.processMessage(alice.did, modulesQuery.message);
      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain(DwnErrorCode.UrlModuleNotNormalized);
      });

      it('should fail with 400 if signature payload is referencing a different message (`descriptorCid`)', async () => {
        const { author, message, modulesQuery } = await TestDataGenerator.generateModulesQuery();
        const tenant = author.did;

        // replace signature with incorrect `descriptorCid`, even though signature is still valid
        const incorrectDescriptorCid = await TestDataGenerator.randomCborSha256Cid();
        const signaturePayload = { ...modulesQuery.signaturePayload };
        signaturePayload.descriptorCid = incorrectDescriptorCid;
        const signaturePayloadBytes = Encoder.objectToBytes(signaturePayload);
        const signer = Jws.createSigner(author);
        const jwsBuilder = await GeneralJwsBuilder.create(signaturePayloadBytes, [signer]);
        message.authorization = { signature: jwsBuilder.getJws() };

        const reply = await dwn.processMessage(tenant, message);

        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(`${incorrectDescriptorCid} does not match expected CID`);
      });

      it('should return 401 if auth fails', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const { message } = await TestDataGenerator.generateModulesQuery({ author: alice });

        // use a bad signature to fail authentication
        const badSignature = await TestDataGenerator.randomSignatureString();
        message.authorization!.signature.signatures[0].signature = badSignature;

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(401);
        expect(reply.status.detail).toContain(DwnErrorCode.GeneralJwsVerifierInvalidSignature);
      });

      describe('Grant authorization', () => {
        it('allows an external party to ModulesQuery only if they have a valid grant', async () => {
          // scenario:
          // 1. Alice grants Bob the access to ModulesQuery on her DWN
          // 2. Verify Bob can perform a ModulesQuery
          // 3. Verify that Mallory cannot to use Bob's permission grant to gain access to Alice's DWN
          // 4. Alice revokes Bob's grant
          // 5. Verify Bob cannot perform ModulesQuery with the revoked grant
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const mallory = await TestDataGenerator.generateDidKeyPersona();

          // Alice creates a public and private module to test query results
          const { message: publicModuleMessage } = await TestDataGenerator.generateModulesConfigure({
            author    : alice,
            published : true,
          });

          const { status: publicModuleStatus } = await dwn.processMessage(alice.did, publicModuleMessage);
          expect(publicModuleStatus.code).toBe(202);

          const { message: privateModuleMessage } = await TestDataGenerator.generateModulesConfigure({
            author    : alice,
            published : false,
          });

          const { status: privateModuleStatus } = await dwn.processMessage(alice.did, privateModuleMessage);
          expect(privateModuleStatus.code).toBe(202);

          // 1. Alice grants Bob the access to ModulesQuery on her DWN
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Modules, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // 2. Verify Bob can perform a ModulesQuery
          const permissionGrantId = permissionGrant.recordsWrite.message.recordId;
          const modulesQuery = await TestDataGenerator.generateModulesQuery({
            author: bob,
            permissionGrantId,
          });
          const modulesQueryReply = await dwn.processMessage(alice.did, modulesQuery.message);
          expect(modulesQueryReply.status.code).toBe(200);
          expect(modulesQueryReply.entries).toHaveLength(2);

          // 3. Verify that Mallory cannot to use Bob's permission grant to gain access to Alice's DWN
          const malloryModulesQuery = await TestDataGenerator.generateModulesQuery({
            author: mallory,
            permissionGrantId,
          });
          const malloryModulesQueryReply = await dwn.processMessage(alice.did, malloryModulesQuery.message);
          expect(malloryModulesQueryReply.status.code).toBe(401);
          expect(malloryModulesQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationNotGrantedToAuthor);

          // 4. Alice revokes Bob's grant
          const revokeWrite = await PermissionsModule.createRevocation({
            signer      : Jws.createSigner(alice),
            grant       : PermissionGrant.parse(permissionGrant.dataEncodedMessage),
            dateRevoked : Time.getCurrentTimestamp()
          });

          const revokeWriteReply = await dwn.processMessage(
            alice.did,
            revokeWrite.recordsWrite.message,
            { dataStream: DataStream.fromBytes(revokeWrite.permissionRevocationBytes) }
          );
          expect(revokeWriteReply.status.code).toBe(202);

          // 5. Verify Bob cannot perform ModulesQuery with the revoked grant
          const unauthorizedModulesQuery = await TestDataGenerator.generateModulesQuery({
            author: bob,
            permissionGrantId,
          });
          const unauthorizedModulesQueryReply = await dwn.processMessage(alice.did, unauthorizedModulesQuery.message);
          expect(unauthorizedModulesQueryReply.status.code).toBe(401);
          expect(unauthorizedModulesQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantRevoked);
        });

        it('should allow to scope a ModulesQuery to a specific module', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // create 2 unpublished modules, and one published module
          const { message: allowedModuleMessage } = await TestDataGenerator.generateModulesConfigure({
            author    : alice,
            published : false,
          });
          const allowedModule = allowedModuleMessage.descriptor.definition.module;
          const { status: allowedStatus } = await dwn.processMessage(alice.did, allowedModuleMessage);
          expect(allowedStatus.code).toBe(202);


          const { message: notAllowedModuleMessage } = await TestDataGenerator.generateModulesConfigure({
            author    : alice,
            published : false,
          });
          const notAllowedModule = notAllowedModuleMessage.descriptor.definition.module;
          const { status: notAllowedStatus } = await dwn.processMessage(alice.did, notAllowedModuleMessage);
          expect(notAllowedStatus.code).toBe(202);

          const { message: publishedModuleMessage } = await TestDataGenerator.generateModulesConfigure({
            author    : alice,
            published : true,
          });
          const publishedModule = publishedModuleMessage.descriptor.definition.module;
          const { status: publishedStatus } = await dwn.processMessage(alice.did, publishedModuleMessage);
          expect(publishedStatus.code).toBe(202);


          // Alice grants Bob the access to ModulesQuery on her DWN for a specific module
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Modules, method: DwnMethodName.Query, module: allowedModule }
          });

          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // Bob tries to ModulesQuery to Alice's DWN for the allowed module
          const modulesQueryAllowed = await TestDataGenerator.generateModulesQuery({
            author : bob,
            filter : {
              module: allowedModule
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const moduleQueryAllowedReply = await dwn.processMessage(alice.did, modulesQueryAllowed.message);
          expect(moduleQueryAllowedReply.status.code).toBe(200);
          expect(moduleQueryAllowedReply.entries).toHaveLength(1);
          expect(moduleQueryAllowedReply.entries![0].descriptor.definition.module).toEqual(allowedModule);

          // Bob tries to ModulesQuery to Alice's DWN for a different module
          const moduleQueryNotAllowed = await TestDataGenerator.generateModulesQuery({
            author : bob,
            filter : {
              module: notAllowedModule,
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const moduleQueryNotAllowedReply = await dwn.processMessage(alice.did, moduleQueryNotAllowed.message);
          expect(moduleQueryNotAllowedReply.status.code).toBe(200);
          expect(moduleQueryNotAllowedReply.entries).toHaveLength(0);

          // Bob tries to ModulesQuery to Alice's DWN for a published module with the same grant
          const moduleQueryPublished = await TestDataGenerator.generateModulesQuery({
            author : bob,
            filter : {
              module: publishedModule,
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const moduleQueryPublishedReply = await dwn.processMessage(alice.did, moduleQueryPublished.message);
          expect(moduleQueryPublishedReply.status.code).toBe(200);
          expect(moduleQueryPublishedReply.entries).toHaveLength(1);
          expect(moduleQueryPublishedReply.entries![0].descriptor.definition.module).toEqual(publishedModule);

          // Bob tries to ModulesQuery to Alice's DWN with no filters, using the same grant
          const moduleQueryNoFilters = await ModulesQuery.create({
            signer            : Jws.createSigner(bob),
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });

          const moduleQueryNoFiltersReply = await dwn.processMessage(alice.did, moduleQueryNoFilters.message);
          expect(moduleQueryNoFiltersReply.status.code).toBe(200);
          expect(moduleQueryNoFiltersReply.entries).toHaveLength(1);
          expect(moduleQueryNoFiltersReply.entries![0].descriptor.definition.module).toEqual(publishedModule);
        });

        it('rejects with 401 when an external party attempts to ModulesQuery if they present an expired grant', async () => {
          // scenario: Alice grants Bob access to ModulesQuery, but when Bob invokes the grant it has expired
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Alice gives Bob a permission grant with scope ModulesQuery and an expiry time
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateGranted : Time.getCurrentTimestamp(),
            dateExpires : Time.getCurrentTimestamp(), // expires immediately
            scope       : { interface: DwnInterfaceName.Modules, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const permissionGrantWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Bob does ModulesQuery after the grant has expired
          const modulesQuery = await TestDataGenerator.generateModulesQuery({
            author            : bob,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const modulesQueryReply = await dwn.processMessage(alice.did, modulesQuery.message);
          expect(modulesQueryReply.status.code).toBe(401);
          expect(modulesQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantExpired);
        });

        it('rejects with 401 when an external party attempts to ModulesQuery if the grant is not yet active', async () => {
          // scenario: Alice grants Bob access to ModulesQuery, but Bob's message has a timestamp just before the grant is active

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Use an explicit offset instead of Time.minimalSleep() to avoid
          // flaky failures when wall-clock timestamps collide on fast CI runners.
          const modulesQueryTimestamp = Time.getCurrentTimestamp();
          const dateGranted = Time.createOffsetTimestamp({ seconds: 1 }, modulesQueryTimestamp);

          // Alice gives Bob a permission grant with scope ModulesQuery
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateGranted,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : { interface: DwnInterfaceName.Modules, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const permissionGrantWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Bob does ModulesQuery but his message has timestamp before the grant is active
          const modulesQuery = await TestDataGenerator.generateModulesQuery({
            author            : bob,
            messageTimestamp  : modulesQueryTimestamp,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const modulesQueryReply = await dwn.processMessage(alice.did, modulesQuery.message);
          expect(modulesQueryReply.status.code).toBe(401);
          expect(modulesQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantNotYetActive);
        });

        it('rejects with 401 when an external party attempts to ModulesQuery using a grant that has a different scope', async () => {
          // scenario: Alice grants Bob access to RecordsRead, then Bob tries to invoke the grant with ModulesQuery

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Alice gives Bob a permission grant with scope RecordsRead
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, module: 'https://example.com/module/test' }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // Bob tries to ModulesQuery
          const modulesQuery = await TestDataGenerator.generateModulesQuery({
            author            : bob,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const modulesQueryReply = await dwn.processMessage(alice.did, modulesQuery.message);
          expect(modulesQueryReply.status.code).toBe(401);
          expect(modulesQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationInterfaceMismatch);
        });

        it('rejects with 401 if the permission grant cannot be found', async () => {
          // scenario: Bob uses a permissionGrantId to ModulesQuery, but no permission grant can be found.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Bob tries to ModulesQuery
          const modulesQuery = await TestDataGenerator.generateModulesQuery({
            author            : bob,
            permissionGrantId : await TestDataGenerator.randomCborSha256Cid(),
          });
          const modulesQueryReply = await dwn.processMessage(alice.did, modulesQuery.message);
          expect(modulesQueryReply.status.code).toBe(401);
          expect(modulesQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantMissing);
        });

        it('rejects with 401 if the permission grant has not been grantedFor the tenant', async () => {
          // Scenario:
          // 1. Alice gives Carol a permission grant with scope ModulesQuery
          // 2. Bob (for unknown reason, thus this is a super edge case) stores the grant in his DWN
          // 3. Verify that Carol cannot use permission grant to gain access to Bob's DWN
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const carol = await TestDataGenerator.generateDidKeyPersona();

          // 1. Alice gives Carol a permission grant with scope ModulesQuery
          const permissionGrant = await PermissionsModule.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : carol.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Modules, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          // 2. Bob (for unknown reason, thus this is a super edge case) stores the grant in his DWN
          const bobWrappedGrant = await RecordsWrite.parse(permissionGrant.recordsWrite.message);
          await bobWrappedGrant.signAsOwner(Jws.createSigner(bob));

          const grantRecordsWriteReply = await dwn.processMessage(bob.did, bobWrappedGrant.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // 3. Verify that Carol cannot use permission grant to gain access to Bob's DWN
          const permissionGrantId = permissionGrant.recordsWrite.message.recordId;
          const modulesQuery = await TestDataGenerator.generateModulesQuery({
            author: carol,
            permissionGrantId,
          });
          const modulesQueryReply = await dwn.processMessage(bob.did, modulesQuery.message);
          expect(modulesQueryReply.status.code).toBe(401);
          expect(modulesQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationNotGrantedForTenant);
        });
      });
    });
  });
}