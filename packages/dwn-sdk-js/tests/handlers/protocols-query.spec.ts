import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type {
  DataStore,
  MessageStore,
  ProtocolsConfigureMessage,
  ResumableTaskStore,
} from '../../src/index.js';

import sinon from 'sinon';

import { GeneralJwsBuilder } from '../../src/jose/jws/general/builder.js';
import { Message } from '../../src/core/message.js';
import { PermissionGrant } from '../../src/protocols/permission-grant.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { Time } from '../../src/utils/time.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Dwn, DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Jws, PermissionsProtocol, ProtocolsQuery, RecordsWrite } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

export function testProtocolsQueryHandler(): void {
  describe('ProtocolsQueryHandler.handle()', () => {
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

      it('should return protocols matching the query', async () => {
        const alice = await TestDataGenerator.generatePersona();

        // setting up a stub method resolver
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // insert three messages into DB, two with matching protocol
        const protocol1 = await TestDataGenerator.generateProtocolsConfigure({ author: alice });
        const protocol2 = await TestDataGenerator.generateProtocolsConfigure({ author: alice });
        const protocol3 = await TestDataGenerator.generateProtocolsConfigure({ author: alice });

        await dwn.processMessage(alice.did, protocol1.message);
        await dwn.processMessage(alice.did, protocol2.message);
        await dwn.processMessage(alice.did, protocol3.message);

        // testing singular conditional query
        const queryMessageData = await TestDataGenerator.generateProtocolsQuery({
          author : alice,
          filter : { protocol: protocol1.message.descriptor.definition.protocol }
        });

        const reply = await dwn.processMessage(alice.did, queryMessageData.message);

        expect(reply.status.code).toBe(200);
        expect(reply.entries?.length).toBe(1); // only 1 entry should match the query on protocol

        // testing fetch-all query without filter
        const queryMessageData2 = await TestDataGenerator.generateProtocolsQuery({
          author: alice
        });

        const reply2 = await dwn.processMessage(alice.did, queryMessageData2.message);

        expect(reply2.status.code).toBe(200);
        expect(reply2.entries?.length).toBe(3); // expecting all 3 entries written above match the query
      });


      it('should return published protocols matching the query if query is unauthenticated or unauthorized', async () => {
        // scenario:
        // 1. Alice has 3 protocols installed: 1 private + 2 published
        // 2. Unauthenticated ProtocolsQuery should return published ProtocolsConfigure
        // 3. Authenticated ProtocolsQuery by Bob but unauthorized to private ProtocolsConfigures should return published ProtocolsConfigure

        const alice = await TestDataGenerator.generatePersona();
        const bob = await TestDataGenerator.generatePersona();

        TestStubGenerator.stubDidResolver(didResolver, [alice, bob]);

        // insert three messages into DB, two with matching protocol
        const protocol1 = await TestDataGenerator.generateProtocolsConfigure({ author: alice, published: false });
        const protocol2 = await TestDataGenerator.generateProtocolsConfigure({ author: alice, published: true });
        const protocol3 = await TestDataGenerator.generateProtocolsConfigure({ author: alice, published: true });

        await dwn.processMessage(alice.did, protocol1.message);
        await dwn.processMessage(alice.did, protocol2.message);
        await dwn.processMessage(alice.did, protocol3.message);

        // testing unauthenticated conditional query
        const conditionalQuery = await ProtocolsQuery.create({
          filter: { protocol: protocol2.message.descriptor.definition.protocol }
        });

        const conditionalQueryReply = await dwn.processMessage(alice.did, conditionalQuery.message);
        expect(conditionalQueryReply.status.code).toBe(200);
        expect(conditionalQueryReply.entries?.length).toBe(1); // only 1 entry should match the query on protocol

        const protocolConfigured = conditionalQueryReply.entries![0] as ProtocolsConfigureMessage;
        expect(protocolConfigured).toEqual(protocol2.message);

        // testing authenticated but unauthorized conditional query, it should return only matching published ProtocolsConfigures
        const signedConditionalQuery = await ProtocolsQuery.create({
          filter : { protocol: protocol2.message.descriptor.definition.protocol },
          signer : Jws.createSigner(bob)
        });

        const signedConditionalQueryReply = await dwn.processMessage(alice.did, signedConditionalQuery.message);
        expect(signedConditionalQueryReply.status.code).toBe(200);
        expect(signedConditionalQueryReply.entries?.length).toBe(1); // only 1 entry should match the query on protocol

        const protocolConfigured2 = conditionalQueryReply.entries![0] as ProtocolsConfigureMessage;
        expect(protocolConfigured2).toEqual(protocol2.message);

        // testing unauthenticated fetch-all query without filter
        const fetchAllQuery = await ProtocolsQuery.create({
        });

        const fetchAllQueryReply = await dwn.processMessage(alice.did, fetchAllQuery.message);
        expect(fetchAllQueryReply.status.code).toBe(200);
        expect(fetchAllQueryReply.entries?.length).toBe(2);
        expect(fetchAllQueryReply.entries).toContainEqual(protocol2.message);
        expect(fetchAllQueryReply.entries).toContainEqual(protocol3.message);

        // testing authenticated but unauthorized fetch-all query without filter, it should return all matching published ProtocolsConfigures
        const signedFetchAllQuery = await ProtocolsQuery.create({
          signer: Jws.createSigner(bob)
        });

        const signedFetchAllQueryReply = await dwn.processMessage(alice.did, signedFetchAllQuery.message);
        expect(signedFetchAllQueryReply.status.code).toBe(200);
        expect(signedFetchAllQueryReply.entries?.length).toBe(2);
        expect(signedFetchAllQueryReply.entries).toContainEqual(protocol2.message);
        expect(signedFetchAllQueryReply.entries).toContainEqual(protocol3.message);
      });

      it('should return 400 if protocol is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // query for non-normalized protocol
        const protocolsQuery = await TestDataGenerator.generateProtocolsQuery({
          author : alice,
          filter : { protocol: 'example.com/' },
        });

      // overwrite protocol because #create auto-normalizes protocol
      protocolsQuery.message.descriptor.filter!.protocol = 'example.com/';

      // Re-create auth because we altered the descriptor after signing
      protocolsQuery.message.authorization = await Message.createAuthorization({
        descriptor : protocolsQuery.message.descriptor,
        signer     : Jws.createSigner(alice)
      });

      // Send records write message
      const reply = await dwn.processMessage(alice.did, protocolsQuery.message);
      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain(DwnErrorCode.UrlProtocolNotNormalized);
      });

      it('should fail with 400 if signature payload is referencing a different message (`descriptorCid`)', async () => {
        const { author, message, protocolsQuery } = await TestDataGenerator.generateProtocolsQuery();
        const tenant = author.did;

        // replace signature with incorrect `descriptorCid`, even though signature is still valid
        const incorrectDescriptorCid = await TestDataGenerator.randomCborSha256Cid();
        const signaturePayload = { ...protocolsQuery.signaturePayload };
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
        const { message } = await TestDataGenerator.generateProtocolsQuery({ author: alice });

        // use a bad signature to fail authentication
        const badSignature = await TestDataGenerator.randomSignatureString();
        message.authorization!.signature.signatures[0].signature = badSignature;

        const reply = await dwn.processMessage(alice.did, message);
        expect(reply.status.code).toBe(401);
        expect(reply.status.detail).toContain(DwnErrorCode.GeneralJwsVerifierInvalidSignature);
      });

      describe('Grant authorization', () => {
        it('allows an external party to ProtocolsQuery only if they have a valid grant', async () => {
          // scenario:
          // 1. Alice grants Bob the access to ProtocolsQuery on her DWN
          // 2. Verify Bob can perform a ProtocolsQuery
          // 3. Verify that Mallory cannot to use Bob's permission grant to gain access to Alice's DWN
          // 4. Alice revokes Bob's grant
          // 5. Verify Bob cannot perform ProtocolsQuery with the revoked grant
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const mallory = await TestDataGenerator.generateDidKeyPersona();

          // Alice creates a public and private protocol to test query results
          const { message: publicProtocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author    : alice,
            published : true,
          });

          const { status: publicProtocolStatus } = await dwn.processMessage(alice.did, publicProtocolMessage);
          expect(publicProtocolStatus.code).toBe(202);

          const { message: privateProtocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author    : alice,
            published : false,
          });

          const { status: privateProtocolStatus } = await dwn.processMessage(alice.did, privateProtocolMessage);
          expect(privateProtocolStatus.code).toBe(202);

          // 1. Alice grants Bob the access to ProtocolsQuery on her DWN
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // 2. Verify Bob can perform a ProtocolsQuery
          const permissionGrantId = permissionGrant.recordsWrite.message.recordId;
          const protocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author: bob,
            permissionGrantId,
          });
          const protocolsQueryReply = await dwn.processMessage(alice.did, protocolsQuery.message);
          expect(protocolsQueryReply.status.code).toBe(200);
          expect(protocolsQueryReply.entries?.length).toBe(2);

          // 3. Verify that Mallory cannot to use Bob's permission grant to gain access to Alice's DWN
          const malloryProtocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author: mallory,
            permissionGrantId,
          });
          const malloryProtocolsQueryReply = await dwn.processMessage(alice.did, malloryProtocolsQuery.message);
          expect(malloryProtocolsQueryReply.status.code).toBe(401);
          expect(malloryProtocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationNotGrantedToAuthor);

          // 4. Alice revokes Bob's grant
          const revokeWrite = await PermissionsProtocol.createRevocation({
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

          // 5. Verify Bob cannot perform ProtocolsQuery with the revoked grant
          const unauthorizedProtocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author: bob,
            permissionGrantId,
          });
          const unauthorizedProtocolsQueryReply = await dwn.processMessage(alice.did, unauthorizedProtocolsQuery.message);
          expect(unauthorizedProtocolsQueryReply.status.code).toBe(401);
          expect(unauthorizedProtocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantRevoked);
        });

        it('should allow to scope a ProtocolsQuery to a specific protocol', async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // create 2 unpublished protocols, and one published protocol
          const { message: allowedProtocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author    : alice,
            published : false,
          });
          const allowedProtocol = allowedProtocolMessage.descriptor.definition.protocol;
          const { status: allowedStatus } = await dwn.processMessage(alice.did, allowedProtocolMessage);
          expect(allowedStatus.code).toBe(202);


          const { message: notAllowedProtocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author    : alice,
            published : false,
          });
          const notAllowedProtocol = notAllowedProtocolMessage.descriptor.definition.protocol;
          const { status: notAllowedStatus } = await dwn.processMessage(alice.did, notAllowedProtocolMessage);
          expect(notAllowedStatus.code).toBe(202);

          const { message: publishedProtocolMessage } = await TestDataGenerator.generateProtocolsConfigure({
            author    : alice,
            published : true,
          });
          const publishedProtocol = publishedProtocolMessage.descriptor.definition.protocol;
          const { status: publishedStatus } = await dwn.processMessage(alice.did, publishedProtocolMessage);
          expect(publishedStatus.code).toBe(202);


          // Alice grants Bob the access to ProtocolsQuery on her DWN for a specific protocol
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query, protocol: allowedProtocol }
          });

          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);
          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // Bob tries to ProtocolsQuery to Alice's DWN for the allowed protocol
          const protocolsQueryAllowed = await TestDataGenerator.generateProtocolsQuery({
            author : bob,
            filter : {
              protocol: allowedProtocol
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const protocolQueryAllowedReply = await dwn.processMessage(alice.did, protocolsQueryAllowed.message);
          expect(protocolQueryAllowedReply.status.code).toBe(200);
          expect(protocolQueryAllowedReply.entries?.length).toBe(1);
          expect(protocolQueryAllowedReply.entries![0].descriptor.definition.protocol).toEqual(allowedProtocol);

          // Bob tries to ProtocolsQuery to Alice's DWN for a different protocol
          const protocolQueryNotAllowed = await TestDataGenerator.generateProtocolsQuery({
            author : bob,
            filter : {
              protocol: notAllowedProtocol,
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const protocolQueryNotAllowedReply = await dwn.processMessage(alice.did, protocolQueryNotAllowed.message);
          expect(protocolQueryNotAllowedReply.status.code).toBe(200);
          expect(protocolQueryNotAllowedReply.entries?.length).toBe(0);

          // Bob tries to ProtocolsQuery to Alice's DWN for a published protocol with the same grant
          const protocolQueryPublished = await TestDataGenerator.generateProtocolsQuery({
            author : bob,
            filter : {
              protocol: publishedProtocol,
            },
            permissionGrantId: permissionGrant.recordsWrite.message.recordId
          });

          const protocolQueryPublishedReply = await dwn.processMessage(alice.did, protocolQueryPublished.message);
          expect(protocolQueryPublishedReply.status.code).toBe(200);
          expect(protocolQueryPublishedReply.entries?.length).toBe(1);
          expect(protocolQueryPublishedReply.entries![0].descriptor.definition.protocol).toEqual(publishedProtocol);

          // Bob tries to ProtocolsQuery to Alice's DWN with no filters, using the same grant
          const protocolQueryNoFilters = await ProtocolsQuery.create({
            signer            : Jws.createSigner(bob),
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });

          const protocolQueryNoFiltersReply = await dwn.processMessage(alice.did, protocolQueryNoFilters.message);
          expect(protocolQueryNoFiltersReply.status.code).toBe(200);
          expect(protocolQueryNoFiltersReply.entries?.length).toBe(1);
          expect(protocolQueryNoFiltersReply.entries![0].descriptor.definition.protocol).toEqual(publishedProtocol);
        });

        it('rejects with 401 when an external party attempts to ProtocolsQuery if they present an expired grant', async () => {
          // scenario: Alice grants Bob access to ProtocolsQuery, but when Bob invokes the grant it has expired
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Alice gives Bob a permission grant with scope ProtocolsQuery and an expiry time
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateGranted : Time.getCurrentTimestamp(),
            dateExpires : Time.getCurrentTimestamp(), // expires immediately
            scope       : { interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const permissionGrantWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Bob does ProtocolsQuery after the grant has expired
          const protocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author            : bob,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const protocolsQueryReply = await dwn.processMessage(alice.did, protocolsQuery.message);
          expect(protocolsQueryReply.status.code).toBe(401);
          expect(protocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantExpired);
        });

        it('rejects with 401 when an external party attempts to ProtocolsQuery if the grant is not yet active', async () => {
          // scenario: Alice grants Bob access to ProtocolsQuery, but Bob's message has a timestamp just before the grant is active

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Use an explicit offset instead of Time.minimalSleep() to avoid
          // flaky failures when wall-clock timestamps collide on fast CI runners.
          const protocolsQueryTimestamp = Time.getCurrentTimestamp();
          const dateGranted = Time.createOffsetTimestamp({ seconds: 1 }, protocolsQueryTimestamp);

          // Alice gives Bob a permission grant with scope ProtocolsQuery
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateGranted,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }), // 24 hours
            scope       : { interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const permissionGrantWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(permissionGrantWriteReply.status.code).toBe(202);

          // Bob does ProtocolsQuery but his message has timestamp before the grant is active
          const protocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author            : bob,
            messageTimestamp  : protocolsQueryTimestamp,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const protocolsQueryReply = await dwn.processMessage(alice.did, protocolsQuery.message);
          expect(protocolsQueryReply.status.code).toBe(401);
          expect(protocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantNotYetActive);
        });

        it('rejects with 401 when an external party attempts to ProtocolsQuery using a grant that has a different scope', async () => {
          // scenario: Alice grants Bob access to RecordsRead, then Bob tries to invoke the grant with ProtocolsQuery

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Alice gives Bob a permission grant with scope RecordsRead
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : bob.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: 'https://example.com/protocol/test' }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          const grantRecordsWriteReply = await dwn.processMessage(alice.did, permissionGrant.recordsWrite.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // Bob tries to ProtocolsQuery
          const protocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author            : bob,
            permissionGrantId : permissionGrant.recordsWrite.message.recordId,
          });
          const protocolsQueryReply = await dwn.processMessage(alice.did, protocolsQuery.message);
          expect(protocolsQueryReply.status.code).toBe(401);
          expect(protocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationInterfaceMismatch);
        });

        it('rejects with 401 if the permission grant cannot be found', async () => {
          // scenario: Bob uses a permissionGrantId to ProtocolsQuery, but no permission grant can be found.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          // Bob tries to ProtocolsQuery
          const protocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author            : bob,
            permissionGrantId : await TestDataGenerator.randomCborSha256Cid(),
          });
          const protocolsQueryReply = await dwn.processMessage(alice.did, protocolsQuery.message);
          expect(protocolsQueryReply.status.code).toBe(401);
          expect(protocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationGrantMissing);
        });

        it('rejects with 401 if the permission grant has not been grantedFor the tenant', async () => {
          // Scenario:
          // 1. Alice gives Carol a permission grant with scope ProtocolsQuery
          // 2. Bob (for unknown reason, thus this is a super edge case) stores the grant in his DWN
          // 3. Verify that Carol cannot use permission grant to gain access to Bob's DWN
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();
          const carol = await TestDataGenerator.generateDidKeyPersona();

          // 1. Alice gives Carol a permission grant with scope ProtocolsQuery
          const permissionGrant = await PermissionsProtocol.createGrant({
            signer      : Jws.createSigner(alice),
            grantedTo   : carol.did,
            dateExpires : Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 }),
            scope       : { interface: DwnInterfaceName.Protocols, method: DwnMethodName.Query }
          });
          const dataStream = DataStream.fromBytes(permissionGrant.permissionGrantBytes);

          // 2. Bob (for unknown reason, thus this is a super edge case) stores the grant in his DWN
          const bobWrappedGrant = await RecordsWrite.parse(permissionGrant.recordsWrite.message);
          await bobWrappedGrant.signAsOwner(Jws.createSigner(bob));

          const grantRecordsWriteReply = await dwn.processMessage(bob.did, bobWrappedGrant.message, { dataStream });
          expect(grantRecordsWriteReply.status.code).toBe(202);

          // 3. Verify that Carol cannot use permission grant to gain access to Bob's DWN
          const permissionGrantId = permissionGrant.recordsWrite.message.recordId;
          const protocolsQuery = await TestDataGenerator.generateProtocolsQuery({
            author: carol,
            permissionGrantId,
          });
          const protocolsQueryReply = await dwn.processMessage(bob.did, protocolsQuery.message);
          expect(protocolsQueryReply.status.code).toBe(401);
          expect(protocolsQueryReply.status.detail).toContain(DwnErrorCode.GrantAuthorizationNotGrantedForTenant);
        });
      });
    });
  });
}