import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { Record } from '../src/record.js';
import type { BearerDid, PortableDid } from '@enbox/dids';
import type { DwnProtocolDefinition, EnboxAgent, ProcessDwnRequest } from '@enbox/agent';
import type { LiveQueryError, RecordChange } from '../src/live-query.js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { processConnectedGrants } from '@enbox/auth';
import {
  AgentPermissionsApi, DwnDateSort, DwnInterface, EnboxConnectProtocol,
  EnboxUserAgent, getRecordAuthor, PlatformAgentTestHarness,
} from '@enbox/agent';
import { DwnConstant, DwnInterfaceName, DwnMethodName, Jws, PermissionsProtocol, Poller, Time } from '@enbox/dwn-sdk-js';

import { WalletConnect } from '@enbox/auth';

import emailProtocolDefinition from './fixtures/protocol-definitions/email.json' with { type: 'json' };
import notesProtocolDefinition from './fixtures/protocol-definitions/notes.json' with { type: 'json' };
import photosProtocolDefinition from './fixtures/protocol-definitions/photos.json' with { type: 'json' };

import { DwnApi } from '../src/dwn-api.js';
import { Enbox } from '../src/enbox.js';
import { PermissionGrant } from '../src/permission-grant.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

describe('DwnApi', () => {
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let dwnAlice: DwnApi;
  let dwnBob: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let protocolUri: string;
  let protocolDefinition: DwnProtocolDefinition;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an "alice" Identity to author the DWN messages.
    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    // Create a "bob" Identity to author the DWN messages.
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    bobDid = bob.did;

    // Instantiate DwnApi for both test identities.
    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    dwnBob = new DwnApi({ agent: testHarness.agent, connectedDid: bobDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnStateIndex.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();

    dwnAlice['connectedDid'] = aliceDid.uri;
    dwnBob['connectedDid'] = bobDid.uri;

    delete dwnAlice['delegateDid'];
    delete dwnBob['delegateDid'];

    // give the protocol a random URI on each run
    protocolUri = `http://example.com/protocol/${TestDataGenerator.randomString(15)}`;
    protocolDefinition = {
      ...emailProtocolDefinition,
      protocol: protocolUri
    };
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('as delegateDid', () => {
    let delegateHarness: PlatformAgentTestHarness;
    let delegateDid: PortableDid;
    let delegateDwn: DwnApi;
    let notesProtocol: DwnProtocolDefinition;

    beforeAll(async () => {
      delegateHarness = await PlatformAgentTestHarness.setup({
        agentClass       : EnboxUserAgent,
        agentStores      : 'memory',
        testDataLocation : '__TESTDATA__/delegateDid'
      });

      await delegateHarness.clearStorage();
      await delegateHarness.createAgentDid();
    });

    afterAll(async () => {
      await delegateHarness.clearStorage();
      await delegateHarness.closeStorage();
    });

    beforeEach(async () => {
      sinon.restore();
      await delegateHarness.syncStore.clear();
      await delegateHarness.dwnDataStore.clear();
      await delegateHarness.dwnStateIndex.clear();
      await delegateHarness.dwnMessageStore.clear();
      await delegateHarness.dwnResumableTaskStore.clear();
      await testHarness.agent.permissions.clear();
      delegateHarness.dwnStores.clear();

      // avoid seeing the security warning of no password during connect
      sinon.stub(console, 'warn');

      notesProtocol = {
        published : true,
        protocol  : `http://notes-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema      : 'https://notes-protocol.xyz/schema/note',
            dataFormats : [ 'text/plain', 'application/json' ]
          }
        },
        structure: {
          note: {}
        }
      };

      // Create a "device" JWK to use as the delegateDid
      const delegatedBearerDid = await testHarness.agent.did.create({ store: false, method: 'jwk', });
      delegateDid = await delegatedBearerDid.export();

      const grantRequest = WalletConnect.createPermissionRequestForProtocol({
        definition  : notesProtocol,
        permissions : ['write', 'read', 'delete', 'query', 'subscribe']
      });

      // alice and bob both configure the protocol
      const { status: aliceConfigStatus, protocol: aliceNotesProtocol } =
        await dwnAlice.protocols.configure({ definition: notesProtocol });
      expect(aliceConfigStatus.code).toBe(202);
      const { status: aliceNotesProtocolSend } = await aliceNotesProtocol.send(aliceDid.uri);
      expect(aliceNotesProtocolSend.code).toBe(202);

      const { status: bobConfigStatus, protocol: bobNotesProtocol } = await dwnBob.protocols.configure({ definition: notesProtocol });
      expect(bobConfigStatus.code).toBe(202);
      const { status: bobNotesProtocolSend } = await bobNotesProtocol.send(bobDid.uri);
      expect(bobNotesProtocolSend.code).toBe(202);

      const grants = await EnboxConnectProtocol.createPermissionGrants(
        aliceDid.uri, delegatedBearerDid, testHarness.agent, grantRequest.permissionScopes
      );

      // Import the delegate DID as a full identity (with connectedDid metadata)
      // so the delegate agent can resolve it and sign on behalf of Alice.
      await delegateHarness.agent.identity.import({ portableIdentity: {
        portableDid : delegateDid,
        metadata    : {
          connectedDid : aliceDid.uri,
          name         : 'Default',
          uri          : delegateDid.uri,
          tenant       : delegateHarness.agent.agentDid.uri,
        }
      } });

      // Process the connected grants (stores them in the delegate agent's DWN).
      const connectedProtocols = await processConnectedGrants({
        grants, connectedDid: aliceDid.uri, delegateDid: delegateDid.uri, agent: delegateHarness.agent as EnboxUserAgent,
      });

      // Register sync for Alice's DID and pull the protocol configuration.
      await (delegateHarness.agent as EnboxUserAgent).sync.registerIdentity({
        did     : aliceDid.uri,
        options : {
          delegateDid : delegateDid.uri,
          protocols   : connectedProtocols,
        }
      });
      await (delegateHarness.agent as EnboxUserAgent).sync.sync('pull');

      // Construct the Enbox instance directly with delegate support.
      const enbox = new Enbox({ agent: delegateHarness.agent, connectedDid: aliceDid.uri, delegateDid: delegateDid.uri });
      delegateDwn = (enbox as any)._dwn;
    });

    describe('records', () => {
      it('should create a record with a delegated grant', async () => {
        const { status, record } = await delegateDwn.records.write({
          data         : 'Hello, world!',
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });

        expect(status.code).toBe(202);
        expect(record).toBeDefined();

        // alice is the author, but the signer is the delegateDid
        expect(record.author).toBe(aliceDid.uri);
        const signerDid = Jws.getSignerDid(record.rawMessage.authorization.signature.signatures[0]);
        expect(signerDid).toBe(delegateDid.uri);
        expect(record.rawMessage.authorization.authorDelegatedGrant).toBeDefined();
      });

      it('should read records with a delegated grant', async () => {
        const { status: writeStatus, record } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();
        const { status: sendStatus } = await record.send();
        expect(sendStatus.code).toBe(202);

        const { status: readStatus, record: readRecord } = await delegateDwn.records.read({
          from     : aliceDid.uri,
          protocol : notesProtocol.protocol,
          filter   : {
            recordId: record.id
          }
        });

        expect(readStatus.code).toBe(200);
        expect(readRecord).toBeDefined();
        expect(readRecord.id).toBeDefined();
      });

      it('should query records with a delegated grant', async () => {
        const { status: writeStatus, record } = await delegateDwn.records.write({
          data         : 'Hello, world!',
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();

        const { status: queryStatus, records } = await delegateDwn.records.query({
          filter: {
            protocol     : notesProtocol.protocol,
            protocolPath : 'note'
          }
        });

        expect(queryStatus.code).toBe(200);
        expect(records).toBeDefined();
        expect(records).toHaveLength(1);

        // alice is the author, but the signer is the delegateDid
        expect(records[0].author).toBe(aliceDid.uri);
        const signerDid = Jws.getSignerDid(records[0].rawMessage.authorization.signature.signatures[0]);
        expect(signerDid).toBe(delegateDid.uri);
        expect(records[0].rawMessage.authorization.authorDelegatedGrant).toBeDefined();

        // the record should be the same
        expect(records[0].id).toBe(record.id);
      });

      it('should subscribe to records with a delegated grant', async () => {
        // subscribe to all messages from the protocol
        const subscribeResult = await delegateDwn.records.subscribe({
          filter: {
            protocol: notesProtocol.protocol
          }
        });
        expect(subscribeResult.status.code).toBe(200);
        expect(subscribeResult.liveQuery).toBeDefined();
        const live = subscribeResult.liveQuery!;

        const changes: RecordChange[] = [];
        live.on('change', (change) => { changes.push(change); });

        // write a record
        const writeResult = await delegateDwn.records.write({
          data         : 'Hello, world!',
          recipient    : bobDid.uri,
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeResult.status.code).toBe(202);

        // wait for the create event
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(1);
          expect(changes[0].type).toBe('create');
          expect(changes[0].record.id).toBe(writeResult.record.id);
          expect(changes[0].record.deleted).toBe(false);
        });

        // delete the record using the original writeResult instance of it
        const deleteResult = await writeResult.record.delete();
        expect(deleteResult.status.code).toBe(202);

        // wait for the delete event
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(2);
          expect(changes[1].type).toBe('delete');
          expect(changes[1].record.id).toBe(writeResult.record.id);
        });

        // write another record
        const writeResult2 = await delegateDwn.records.write({
          data         : 'Hello, world!',
          recipient    : bobDid.uri,
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeResult2.status.code).toBe(202);

        // wait for the create event
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(3);
          expect(changes[2].type).toBe('create');
          expect(changes[2].record.id).toBe(writeResult2.record.id);
        });

        await live.close();
      });

      it('should read records as the delegate DID if no grant is found', async () => {
        // alice installs some other protocol
        const { status: aliceConfigStatus, protocol: aliceOtherProtocol } = await dwnAlice.protocols.configure({ definition: {
          ...notesProtocol,
          protocol: `http://other-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`
        } });
        expect(aliceConfigStatus.code).toBe(202);
        const { status: aliceOtherProtocolSend } = await aliceOtherProtocol.send(aliceDid.uri);
        expect(aliceOtherProtocolSend.code).toBe(202);

        // alice writes a note record to the permissioned protocol
        const { status: writeStatus1, record: allowedRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus1.code).toBe(202);
        expect(allowedRecord).toBeDefined();
        const { status: allowedRecordSendStatus } = await allowedRecord.send();
        expect(allowedRecordSendStatus.code).toBe(202);

        // alice writes a public and private note to the other protocol
        const { status: writeStatus2, record: publicRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          published    : true,
          protocol     : aliceOtherProtocol.definition.protocol,
          protocolPath : 'note',
          schema       : aliceOtherProtocol.definition.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus2.code).toBe(202);
        expect(publicRecord).toBeDefined();
        const { status: publicRecordSendStatus } = await publicRecord.send();
        expect(publicRecordSendStatus.code).toBe(202);

        const { status: writeStatus3, record: privateRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : aliceOtherProtocol.definition.protocol,
          protocolPath : 'note',
          schema       : aliceOtherProtocol.definition.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus3.code).toBe(202);
        expect(privateRecord).toBeDefined();
        const { status: privateRecordSendStatus } = await privateRecord.send();
        expect(privateRecordSendStatus.code).toBe(202);


        // sanity: delegateDwn reads from the allowed record from alice's DWN
        const { status: readStatus1, record: allowedRecordReturned } = await delegateDwn.records.read({
          from     : aliceDid.uri,
          protocol : notesProtocol.protocol,
          filter   : {
            recordId: allowedRecord.id
          }
        });
        expect(readStatus1.code).toBe(200);
        expect(allowedRecordReturned).toBeDefined();
        expect(allowedRecordReturned.id).toBe(allowedRecord.id);

        // delegateDwn reads from the other protocol, which no permissions exist
        // only the public record is successfully returned
        const { status: readStatus2, record: publicRecordReturned } = await delegateDwn.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: publicRecord.id
          }
        });
        expect(readStatus2.code).toBe(200);
        expect(publicRecordReturned).toBeDefined();
        expect(publicRecordReturned.id).toBe(publicRecord.id);

        // attempt to read the private record, which should fail
        const { status: readStatus3, record: privateRecordReturned } = await delegateDwn.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: privateRecord.id
          }
        });
        expect(readStatus3.code).toBe(401);
        expect(privateRecordReturned).toBeUndefined();

        // sanity: query as alice to get both records
        const { status: readStatus4, record: privateRecordReturnedAlice } = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: privateRecord.id
          }
        });
        expect(readStatus4.code).toBe(200);
        expect(privateRecordReturnedAlice).toBeDefined();
        expect(privateRecordReturnedAlice.id).toBe(privateRecord.id);
      });

      it('should query records as the delegate DID if no grant is found', async () => {
        // alice installs some other protocol
        const { status: aliceConfigStatus, protocol: aliceOtherProtocol } = await dwnAlice.protocols.configure({ definition: {
          ...notesProtocol,
          protocol: `http://other-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`
        } });
        expect(aliceConfigStatus.code).toBe(202);
        const { status: aliceOtherProtocolSend } = await aliceOtherProtocol.send(aliceDid.uri);
        expect(aliceOtherProtocolSend.code).toBe(202);

        // alice writes a note record to the permissioned protocol
        const { status: writeStatus1, record: allowedRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus1.code).toBe(202);
        expect(allowedRecord).toBeDefined();
        const { status: allowedRecordSendStatus } = await allowedRecord.send();
        expect(allowedRecordSendStatus.code).toBe(202);

        // alice writes a public and private note to the other protocol
        const { status: writeStatus2, record: publicRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          published    : true,
          protocol     : aliceOtherProtocol.definition.protocol,
          protocolPath : 'note',
          schema       : aliceOtherProtocol.definition.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus2.code).toBe(202);
        expect(publicRecord).toBeDefined();
        const { status: publicRecordSendStatus } = await publicRecord.send();
        expect(publicRecordSendStatus.code).toBe(202);

        const { status: writeStatus3, record: privateRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : aliceOtherProtocol.definition.protocol,
          protocolPath : 'note',
          schema       : aliceOtherProtocol.definition.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus3.code).toBe(202);
        expect(privateRecord).toBeDefined();
        const { status: privateRecordSendStatus } = await privateRecord.send();
        expect(privateRecordSendStatus.code).toBe(202);


        // sanity: delegateDwn queries for the allowed record from alice's DWN
        const { status: queryStatus1, records: allowedRecords } = await delegateDwn.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol: notesProtocol.protocol
          }
        });
        expect(queryStatus1.code).toBe(200);
        expect(allowedRecords).toBeDefined();
        expect(allowedRecords).toHaveLength(1);

        // delegateDwn queries for the other protocol, which no permissions exist
        // only the public record is returned
        const { status: queryStatus2, records: publicRecords } = await delegateDwn.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol: aliceOtherProtocol.definition.protocol
          }
        });
        expect(queryStatus2.code).toBe(200);
        expect(publicRecords).toBeDefined();
        expect(publicRecords).toHaveLength(1);
        expect(publicRecords[0].id).toBe(publicRecord.id);

        // sanity: query as alice to get both records
        const { status: queryStatus3, records: allRecords } = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol: aliceOtherProtocol.definition.protocol
          }
        });
        expect(queryStatus3.code).toBe(200);
        expect(allRecords).toBeDefined();
        expect(allRecords).toHaveLength(2);
        expect(allRecords.map(r => r.id)).toEqual(expect.arrayContaining([publicRecord.id, privateRecord.id]));
      });

      it('should subscribe to records as the delegate DID if no grant is found', async () => {
        // alice installs some other protocol
        const { status: aliceConfigStatus, protocol: aliceOtherProtocol } = await dwnAlice.protocols.configure({ definition: {
          ...notesProtocol,
          protocol: `http://other-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`
        } });
        expect(aliceConfigStatus.code).toBe(202);
        const { status: aliceOtherProtocolSend } = await aliceOtherProtocol.send(aliceDid.uri);
        expect(aliceOtherProtocolSend.code).toBe(202);

        // delegatedDwn subscribes to both protocols
        const permissionedNotesChanges: RecordChange[] = [];
        const { liveQuery: permissionedLive } = await delegateDwn.records.subscribe({
          from   : aliceDid.uri,
          filter : {
            protocol: notesProtocol.protocol
          }
        });
        expect(permissionedLive).toBeDefined();
        permissionedLive!.on('change', (change) => { permissionedNotesChanges.push(change); });

        const otherProtocolChanges: RecordChange[] = [];
        const { liveQuery: otherLive } = await delegateDwn.records.subscribe({
          from   : aliceDid.uri,
          filter : {
            protocol: aliceOtherProtocol.definition.protocol
          }
        });
        expect(otherLive).toBeDefined();
        otherLive!.on('change', (change) => { otherProtocolChanges.push(change); });

        // alice subscribes to the other protocol as a sanity
        const aliceOtherProtocolChanges: RecordChange[] = [];
        const { liveQuery: aliceOtherLive } = await dwnAlice.records.subscribe({
          from   : aliceDid.uri,
          filter : {
            protocol: aliceOtherProtocol.definition.protocol
          }
        });
        expect(aliceOtherLive).toBeDefined();
        aliceOtherLive!.on('change', (change) => { aliceOtherProtocolChanges.push(change); });

        // NOTE: write the private record before the public so that it should be received first
        // alice writes a public and private note to the other protocol
        const { status: writeStatus2, record: publicRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          published    : true,
          protocol     : aliceOtherProtocol.definition.protocol,
          protocolPath : 'note',
          schema       : aliceOtherProtocol.definition.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus2.code).toBe(202);
        expect(publicRecord).toBeDefined();
        const { status: publicRecordSendStatus } = await publicRecord.send();
        expect(publicRecordSendStatus.code).toBe(202);

        // alice writes a note record to the permissioned protocol
        const { status: writeStatus1, record: allowedRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : notesProtocol.protocol,
          protocolPath : 'note',
          schema       : notesProtocol.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus1.code).toBe(202);
        expect(allowedRecord).toBeDefined();
        const { status: allowedRecordSendStatus } = await allowedRecord.send();
        expect(allowedRecordSendStatus.code).toBe(202);

        const { status: writeStatus3, record: privateRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : aliceOtherProtocol.definition.protocol,
          protocolPath : 'note',
          schema       : aliceOtherProtocol.definition.types.note.schema,
          dataFormat   : 'text/plain',
        });
        expect(writeStatus3.code).toBe(202);
        expect(privateRecord).toBeDefined();
        const { status: privateRecordSendStatus } = await privateRecord.send();
        expect(privateRecordSendStatus.code).toBe(202);

        // wait for the records to be received
        // alice receives both the public and private records on her subscription
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(aliceOtherProtocolChanges.length).toBe(2);
          expect(aliceOtherProtocolChanges.some(c => c.record.id === publicRecord.id)).toBe(true);
          expect(aliceOtherProtocolChanges.some(c => c.record.id === privateRecord.id)).toBe(true);
        });

        // delegated agent only receives the public record from the other protocol
        await Poller.pollUntilSuccessOrTimeout(async () => {
          // permissionedNotesChanges should have the allowedRecord
          expect(permissionedNotesChanges.length).toBe(1);
          expect(permissionedNotesChanges[0].record.id).toBe(allowedRecord.id);

          // otherProtocolChanges should have only the publicRecord
          expect(otherProtocolChanges.length).toBe(1);
          expect(otherProtocolChanges[0].record.id).toBe(publicRecord.id);
        });

        await permissionedLive!.close();
        await otherLive!.close();
        await aliceOtherLive!.close();
      });
    });

    describe('protocols', () => {
      it('should configure a protocol with a delegated grant', async () => {
        const protocolUri = `http://protocol-configure.xyz/protocol/${TestDataGenerator.randomString(15)}`;

        // attempt to configure the protocol without a grant, it should fail
        try {
          await delegateDwn.protocols.configure({
            definition: {
              ...notesProtocol,
              protocol: protocolUri,
            }
          });
          throw new Error('Expected an error to be thrown.');
        } catch (error: any) {
          expect(error.message).toBe(`CachedPermissions: No permissions found for ProtocolsConfigure: ${protocolUri}`);
        }

        // create a grant for the protocol
        const delegatedBearerDid = await delegateHarness.agent.did.get({ didUri: delegateDid.uri });
        const grants = await EnboxConnectProtocol.createPermissionGrants(aliceDid.uri, delegatedBearerDid, testHarness.agent, [{
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Configure,
          protocol  : protocolUri
        }]);

        await processConnectedGrants({
          grants, connectedDid : aliceDid.uri, delegateDid  : delegateDid.uri,
          agent        : delegateHarness.agent as EnboxUserAgent,
        });

        // now try again after processing the connected grant
        const { status, protocol } = await delegateDwn.protocols.configure({
          definition: {
            ...notesProtocol,
            protocol: protocolUri,
          }
        });
        expect(status.code).toBe(202);
        expect(protocol).toBeDefined();
        expect(protocol.definition.protocol).toBe(protocolUri);
      });

      it('should query for a protocol with a permission grant', async () => {
        // configure a non public protocol
        const nonPublicProtocol = {
          ...notesProtocol,
          protocol  : `http://non-public-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`,
          published : false
        };

        const { status: nonPublicStatus, protocol: nonPublicProtocolResponse } = await dwnAlice.protocols.configure({
          definition: nonPublicProtocol
        });
        expect(nonPublicStatus.code).toBe(202);
        expect(nonPublicProtocolResponse).toBeDefined();
        const nonPublicProtocolSend = await nonPublicProtocolResponse.send(aliceDid.uri);
        expect(nonPublicProtocolSend.status.code).toBe(202);

        // attempt to query the protocol, should not return any results as there are no grants for it
        const { status: nonPublicQueryStatus, protocols: nonPublicProtocols } = await delegateDwn.protocols.query({
          from   : aliceDid.uri,
          filter : {
            protocol: nonPublicProtocol.protocol
          }
        });
        expect(nonPublicQueryStatus.code).toBe(200);
        expect(nonPublicProtocols).toBeDefined();
        expect(nonPublicProtocols).toHaveLength(0);

        // grant the delegate DID access to query the non-public protocol
        const delegatedBearerDid = await delegateHarness.agent.did.get({ didUri: delegateDid.uri });
        const grants = await EnboxConnectProtocol.createPermissionGrants(aliceDid.uri, delegatedBearerDid, testHarness.agent, [{
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Query,
          protocol  : nonPublicProtocol.protocol
        }]);
        await processConnectedGrants({
          grants, connectedDid : aliceDid.uri, delegateDid  : delegateDid.uri,
          agent        : delegateHarness.agent as EnboxUserAgent,
        });

        // now query for the non-public protocol, should return the protocol
        const { status: nonPublicQueryStatus2, protocols: nonPublicProtocols2 } = await delegateDwn.protocols.query({
          from   : aliceDid.uri,
          filter : {
            protocol: nonPublicProtocol.protocol
          }
        });
        expect(nonPublicQueryStatus2.code).toBe(200);
        expect(nonPublicProtocols2).toBeDefined();
        expect(nonPublicProtocols2).toHaveLength(1);
      });

      it('should query for a protocol as the delegate DID if no grant is found', async () => {
        // configure a public protocol without any grants
        const publicProtocol = {
          ...notesProtocol,
          protocol  : `http://public-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`,
          published : true
        };

        const { status: publicStatus, protocol: publicProtocolResponse } = await dwnAlice.protocols.configure({
          definition: publicProtocol
        });
        expect(publicStatus.code).toBe(202);
        expect(publicProtocolResponse).toBeDefined();
        const publicProtocolSend = await publicProtocolResponse.send(aliceDid.uri);
        expect(publicProtocolSend.status.code).toBe(202);

        const { status: publicQueryStatus, protocols: publicProtocols } = await delegateDwn.protocols.query({
          from   : aliceDid.uri,
          filter : {
            protocol: publicProtocol.protocol
          }
        });
        expect(publicQueryStatus.code).toBe(200);
        expect(publicProtocols).toBeDefined();
        expect(publicProtocols).toHaveLength(1);
        expect(publicProtocols[0].definition.protocol).toBe(publicProtocol.protocol);
      });
    });
  });

  describe('protocols.configure()', () => {
    describe('agent', () => {
      it('writes a protocol definition', async () => {
        const response = await dwnAlice.protocols.configure({
          definition: protocolDefinition
        });

        expect(response.status.code).toBe(202);
        expect(response.status.detail).toBe('Accepted');
      });
    });
  });

  describe('protocols.query()', () => {
    describe('agent', () => {
      it('should return protocols matching the query', async () => {
        // Write a protocols configure to the connected agent's DWN.
        const configureResponse = await dwnAlice.protocols.configure({
          definition: protocolDefinition
        });
        expect(configureResponse.status.code).toBe(202);
        expect(configureResponse.status.detail).toBe('Accepted');

        // Query for the protocol just configured.
        const queryResponse = await dwnAlice.protocols.query({
          filter: {
            protocol: protocolDefinition.protocol
          }
        });

        expect(queryResponse.status.code).toBe(200);
        expect(queryResponse.protocols.length).toBe(1);
        expect(queryResponse.protocols[0].definition).toHaveProperty('types');
        expect(queryResponse.protocols[0].definition).toHaveProperty('protocol');
        expect(queryResponse.protocols[0].definition.protocol).toBe(protocolDefinition.protocol);
        expect(queryResponse.protocols[0].definition).toHaveProperty('structure');
      });
    });

    describe('from: did', () => {
      it('should return protocols matching the query', async () => {
        // Write a protocols configure to the connected agent's DWN.
        const configureResponse = await dwnAlice.protocols.configure({
          definition: protocolDefinition
        });
        expect(configureResponse.status.code).toBe(202);
        expect(configureResponse.status.detail).toBe('Accepted');

        // Write the protocol to the remote DWN.
        await configureResponse.protocol.send(aliceDid.uri);

        // Query for the protocol just configured.
        const queryResponse = await dwnAlice.protocols.query({
          from   : aliceDid.uri,
          filter : {
            protocol: protocolDefinition.protocol
          }
        });

        expect(queryResponse.status.code).toBe(200);
        expect(queryResponse.protocols.length).toBe(1);
        expect(queryResponse.protocols[0].definition).toHaveProperty('types');
        expect(queryResponse.protocols[0].definition).toHaveProperty('protocol');
        expect(queryResponse.protocols[0].definition.protocol).toBe(protocolDefinition.protocol);
        expect(queryResponse.protocols[0].definition).toHaveProperty('structure');
      });

      it('returns empty protocols array when no protocols match the filter provided', async () => {
        // Query for a non-existent protocol.
        const response = await dwnAlice.protocols.query({
          from   : aliceDid.uri,
          filter : {
            protocol: 'https://doesnotexist.com/protocol'
          }
        });

        expect(response.status.code).toBe(200);
        expect(response.protocols).toBeDefined();
        expect(response.protocols.length).toBe(0);
      });

      it('returns published protocol definitions for requests from external DID', async () => {
        // Configure a published protocol on Alice's local DWN.
        const publicProtocol = await dwnAlice.protocols.configure({
          definition: { ...protocolDefinition, protocol: 'http://proto-published', published: true }
        });
        expect(publicProtocol.status.code).toBe(202);

        // Configure the published protocol on Alice's remote DWN.
        const sendPublic = await publicProtocol.protocol.send(aliceDid.uri);
        expect(sendPublic.status.code).toBe(202);

        // Attempt to query for the published protocol on Alice's remote DWN authored by Bob.
        const publishedResponse = await dwnBob.protocols.query({
          from   : aliceDid.uri,
          filter : {
            protocol: 'http://proto-published'
          }
        });

        // Verify that one query result is returned.
        expect(publishedResponse.status.code).toBe(200);
        expect(publishedResponse.protocols.length).toBe(1);
        expect(publishedResponse.protocols[0].definition.protocol).toBe('http://proto-published');
      });

      it('does not return unpublished protocol definitions for requests from external DID', async () => {
        // Configure an unpublished protocol on Alice's DWN.
        const notPublicProtocol = await dwnAlice.protocols.configure({
          definition: { ...protocolDefinition, protocol: 'http://proto-not-published', published: false }
        });
        expect(notPublicProtocol.status.code).toBe(202);

        // Configure the unpublished protocol on Alice's remote DWN.
        const sendNotPublic = await notPublicProtocol.protocol.send(aliceDid.uri);
        expect(sendNotPublic.status.code).toBe(202);

        // Attempt to query for the unpublished protocol on Alice's remote DWN authored by Bob.
        const nonPublishedResponse = await dwnBob.protocols.query({
          from   : aliceDid.uri,
          filter : {
            protocol: 'http://proto-not-published'
          }
        });

        // Verify that no query results are returned.
        expect(nonPublishedResponse.status.code).toBe(200);
        expect(nonPublishedResponse.protocols.length).toBe(0);
      });

      it('returns a 401 with an invalid permissions grant', async () => {
        // Attempt to query for a record using Bob's DWN tenant with an invalid grant.
        const response = await dwnAlice.protocols.query({
          from              : bobDid.uri,
          permissionGrantId : 'bafyreiduimprbncdo2oruvjrvmfmwuyz4xx3d5biegqd2qntlryvuuosem',
          filter            : {
            protocol: 'https://doesnotexist.com/protocol'
          }
        });

        expect(response.status.code).toBe(401);
        expect(response.status.detail).toContain('GrantAuthorizationGrantMissing');
        expect(response.protocols).toBeDefined();
        expect(response.protocols.length).toBe(0);
      });
    });
  });

  describe('records.write()', () => {
    beforeEach(async() => {
      // Configure the protocol on both DWNs
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocolDefinition
      });
      expect(aliceProtocolStatus.code).toBe(202);
      expect(aliceProtocol).toBeDefined();
      const { status: aliceProtocolSendStatus } = await aliceProtocol.send(aliceDid.uri);
      expect(aliceProtocolSendStatus.code).toBe(202);
      const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({ definition: protocolDefinition });
      expect(bobProtocolStatus.code).toBe(202);
      expect(bobProtocol).toBeDefined();
      const { status: bobProtocolSendStatus } = await bobProtocol.send(bobDid.uri);
      expect(bobProtocolSendStatus.code).toBe(202);

      // Install free-for-all protocol for tests that write records with arbitrary schema/dataFormat.
      const freeForAllDefinition: DwnProtocolDefinition = {
        protocol  : 'http://free-for-all.xyz',
        published : true,
        types     : { post: {}, other: {} },
        structure : { post: {}, other: {} },
      };
      const { status: aliceFfaStatus, protocol: aliceFfaProtocol } = await dwnAlice.protocols.configure({ definition: freeForAllDefinition });
      expect(aliceFfaStatus.code).toBe(202);
      const { status: aliceFfaSendStatus } = await aliceFfaProtocol.send(aliceDid.uri);
      expect(aliceFfaSendStatus.code).toBe(202);
      const { status: bobFfaStatus, protocol: bobFfaProtocol } = await dwnBob.protocols.configure({ definition: freeForAllDefinition });
      expect(bobFfaStatus.code).toBe(202);
      const { status: bobFfaSendStatus } = await bobFfaProtocol.send(bobDid.uri);
      expect(bobFfaSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('creates a record with string data', async () => {
        const dataString = 'Hello, world!Hello, world!';
        const result = await dwnAlice.records.write({
          data         : dataString,
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
        });

        expect(result.status.code).toBe(202);
        expect(result.status.detail).toBe('Accepted');
        expect(result.record).toBeDefined();
        expect(await result.record.data.text()).toBe(dataString);
      });

      it('creates a record with tags', async () => {
        const result = await dwnAlice.records.write({
          data         : 'some data',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          tags         : {
            foo   : 'bar',
            count : 2,
            bool  : true
          }
        });

        expect(result.status.code).toBe(202);
        expect(result.status.detail).toBe('Accepted');
        expect(result.record).toBeDefined();
        expect(result.record.tags).toBeDefined();
        expect(result.record.tags).toEqual({
          foo   : 'bar',
          count : 2,
          bool  : true
        });

      });

      it('creates a record with JSON data', async () => {
        const dataJson = { hello: 'world!' };
        const result = await dwnAlice.records.write({
          data         : dataJson,
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'application/json'
        });
        expect(result.status.code).toBe(202);
        expect(result.status.detail).toBe('Accepted');
        expect(result.record).toBeDefined();
        expect(await result.record.data.json()).toEqual(dataJson);
      });

      it('creates a role record for another user that they can use to create role-based records', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether role records can be created for outbound participants
         * so they can use them to create records corresponding to the roles they are granted.
         *
         * TEST SETUP STEPS:
         *    1. Configure the photos protocol on Bob and Alice's remote and local DWNs.
         *    2. Alice creates a role-based 'friend' record for Bob, updates it, then sends it to her remote DWN.
         *    3. Bob creates an album record using the role 'friend', adds Alice as a `participant` of the album and sends the records to Alice.
         *    4. Alice fetches the album, and the `participant` record to store it on her local DWN.
         *    5. Alice adds Bob as an `updater` of the album and sends the record to Bob and her own remote node.
         *       This allows bob to edit photos in the album.
         *    6. Alice creates a photo using her participant role and sends it to her own DWN and Bob's DWN.
         *    7. Bob updates the photo using his updater role and sends it to Alice and his own DWN.
         *    8. Alice fetches the photo and stores it on her local DWN.
         */

        // Configure the photos protocol on Alice and Bob's local and remote DWNs.
        const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
          definition: photosProtocolDefinition
        });
        expect(bobProtocolStatus.code).toBe(202);
        const { status: bobRemoteProtocolStatus } = await bobProtocol.send(bobDid.uri);
        expect(bobRemoteProtocolStatus.code).toBe(202);

        const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
          definition: photosProtocolDefinition
        });
        expect(aliceProtocolStatus.code).toBe(202);
        const { status: aliceRemoteProtocolStatus } = await aliceProtocol.send(aliceDid.uri);
        expect(aliceRemoteProtocolStatus.code).toBe(202);

        // Alice creates a role-based 'friend' record, updates it, then sends it to her remote DWN.
        const { status: friendCreateStatus, record: friendRecord } = await dwnAlice.records.write({
          data         : 'test',
          recipient    : bobDid.uri,
          protocol     : photosProtocolDefinition.protocol,
          protocolPath : 'friend',
          schema       : photosProtocolDefinition.types.friend.schema,
          dataFormat   : 'text/plain'
        });
        expect(friendCreateStatus.code).toBe(202);
        const { status: friendRecordUpdateStatus, record: updatedFriendRecord } = await friendRecord.update({ data: 'update' });
        expect(friendRecordUpdateStatus.code).toBe(202);
        const { status: aliceFriendSendStatus } = await updatedFriendRecord.send(aliceDid.uri);
        expect(aliceFriendSendStatus.code).toBe(202);

        // Bob creates an album record using the role 'friend' and sends it to Alice
        const { status: albumCreateStatus, record: albumRecord } = await dwnBob.records.write({
          data         : 'test',
          recipient    : aliceDid.uri,
          protocol     : photosProtocolDefinition.protocol,
          protocolPath : 'album',
          protocolRole : 'friend',
          schema       : photosProtocolDefinition.types.album.schema,
          dataFormat   : 'text/plain'
        });
        expect(albumCreateStatus.code).toBe(202);
        const { status: bobAlbumSendStatus } = await albumRecord.send(bobDid.uri);
        expect(bobAlbumSendStatus.code).toBe(202);
        const { status: aliceAlbumSendStatus } = await albumRecord.send(aliceDid.uri);
        expect(aliceAlbumSendStatus.code).toBe(202);

        // Bob makes Alice a `participant` and sends the record to her and his own remote node.
        const { status: participantCreateStatus, record: participantRecord } = await dwnBob.records.write({
          data            : 'test',
          parentContextId : albumRecord.contextId,
          recipient       : aliceDid.uri,
          protocol        : photosProtocolDefinition.protocol,
          protocolPath    : 'album/participant',
          schema          : photosProtocolDefinition.types.participant.schema,
          dataFormat      : 'text/plain'
        });
        expect(participantCreateStatus.code).toBe(202);
        const { status: bobParticipantSendStatus } = await participantRecord.send(bobDid.uri);
        expect(bobParticipantSendStatus.code).toBe(202);
        const { status: aliceParticipantSendStatus } = await participantRecord.send(aliceDid.uri);
        expect(aliceParticipantSendStatus.code).toBe(202);

        // Alice fetches the album record as well as the participant record that Bob created and stores it on her local node.
        const aliceAlbumReadResult = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: albumRecord.id
          }
        });
        expect(aliceAlbumReadResult.status.code).toBe(200);
        expect(aliceAlbumReadResult.record).toBeDefined();
        const { status: aliceAlbumReadStoreStatus } = await aliceAlbumReadResult.record.store();
        expect(aliceAlbumReadStoreStatus.code).toBe(202);

        const aliceParticipantReadResult = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: participantRecord.id
          }
        });
        expect(aliceParticipantReadResult.status.code).toBe(200);
        expect(aliceParticipantReadResult.record).toBeDefined();
        const { status: aliceParticipantReadStoreStatus } = await aliceParticipantReadResult.record.store();
        expect(aliceParticipantReadStoreStatus.code).toBe(202);

        // Using the participant role, Alice can make Bob an `updater` and send the record to him and her own remote node.
        // Only updater roles can update the photo record after it's been created.
        const { status: updaterCreateStatus, record: updaterRecord } = await dwnAlice.records.write({
          data            : 'test',
          parentContextId : albumRecord.contextId,
          recipient       : bobDid.uri,
          protocol        : photosProtocolDefinition.protocol,
          protocolPath    : 'album/updater',
          protocolRole    : 'album/participant',
          schema          : photosProtocolDefinition.types.updater.schema,
          dataFormat      : 'text/plain'
        });
        expect(updaterCreateStatus.code).toBe(202);
        const { status: bobUpdaterSendStatus } = await updaterRecord.send(bobDid.uri);
        expect(bobUpdaterSendStatus.code).toBe(202);
        const { status: aliceUpdaterSendStatus } = await updaterRecord.send(aliceDid.uri);
        expect(aliceUpdaterSendStatus.code).toBe(202);

        // Alice creates a photo using her participant role and sends it to her own DWN and Bob's DWN.
        const { status: photoCreateStatus, record: photoRecord } = await dwnAlice.records.write({
          data            : 'test',
          parentContextId : albumRecord.contextId,
          protocol        : photosProtocolDefinition.protocol,
          protocolPath    : 'album/photo',
          protocolRole    : 'album/participant',
          schema          : photosProtocolDefinition.types.photo.schema,
          dataFormat      : 'text/plain'
        });
        expect(photoCreateStatus.code).toBe(202);
        const { status:alicePhotoSendStatus } = await photoRecord.send(aliceDid.uri);
        expect(alicePhotoSendStatus.code).toBe(202);
        const { status: bobPhotoSendStatus } = await photoRecord.send(bobDid.uri);
        expect(bobPhotoSendStatus.code).toBe(202);

        // Bob updates the photo using his updater role and sends it to Alice and his own DWN.
        const { status: photoUpdateStatus, record: photoUpdateRecord } = await dwnBob.records.write({
          data            : 'test again',
          store           : false,
          parentContextId : albumRecord.contextId,
          recordId        : photoRecord.id,
          dateCreated     : photoRecord.dateCreated,
          protocol        : photosProtocolDefinition.protocol,
          protocolPath    : 'album/photo',
          protocolRole    : 'album/updater',
          schema          : photosProtocolDefinition.types.photo.schema,
          dataFormat      : 'text/plain'
        });
        expect(photoUpdateStatus.code).toBe(202);
        const { status:alicePhotoUpdateSendStatus } = await photoUpdateRecord.send(aliceDid.uri);
        expect(alicePhotoUpdateSendStatus.code).toBe(202);
        const { status: bobPhotoUpdateSendStatus } = await photoUpdateRecord.send(bobDid.uri);
        expect(bobPhotoUpdateSendStatus.code).toBe(202);

        // Alice fetches the photo and stores it on her local DWN.
        const alicePhotoReadResult = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: photoRecord.id
          }
        });
        expect(alicePhotoReadResult.status.code).toBe(200);
        expect(alicePhotoReadResult.record).toBeDefined();
        const { status: alicePhotoReadStoreStatus } = await alicePhotoReadResult.record.store();
        expect(alicePhotoReadStoreStatus.code).toBe(202);
      });
    });

    describe('agent store: false', () => {
      it('does not persist record to agent DWN', async () => {
        const dataString = 'Hello, world!';
        const createResult = await dwnAlice.records.write({
          store        : false,
          data         : dataString,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          schema       : 'foo/bar',
          dataFormat   : 'text/plain'
        });

        expect(createResult.status.code).toBe(202);
        expect(createResult.status.detail).toBe('Accepted');
        expect(createResult.record).toBeDefined();
        expect(await createResult.record.data.text()).toBe(dataString);

        const queryResult = await dwnAlice.records.query({
          filter: {
            schema: 'foo/bar'
          }
        });

        expect(queryResult.status.code).toBe(200);
        expect(queryResult.records).toBeDefined();
        expect(queryResult.records.length).toBe(0);
      });

      it('has no effect if `store: true`', async () => {
        const dataString = 'Hello, world!';
        const createResult = await dwnAlice.records.write({
          store        : true,
          data         : dataString,
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          schema       : 'foo/bar',
          dataFormat   : 'text/plain'
        });

        expect(createResult.status.code).toBe(202);
        expect(createResult.status.detail).toBe('Accepted');
        expect(createResult.record).toBeDefined();
        expect(await createResult.record.data.text()).toBe(dataString);

        const queryResult = await dwnAlice.records.query({
          filter: {
            schema: 'foo/bar'
          }
        });

        expect(queryResult.status.code).toBe(200);
        expect(queryResult.records).toBeDefined();
        expect(queryResult.records.length).toBe(1);
        expect(queryResult.records[0].id).toBe(createResult.record.id);
        expect(await queryResult.records[0].data.text()).toBe(dataString);
      });
    });
  });

  describe('records.delete()', () => {
    beforeEach(async() => {
      // Configure the protocol on both DWNs
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocolDefinition
      });
      expect(aliceProtocolStatus.code).toBe(202);
      expect(aliceProtocol).toBeDefined();
      const { status: aliceProtocolSendStatus } = await aliceProtocol.send(aliceDid.uri);
      expect(aliceProtocolSendStatus.code).toBe(202);
      const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({ definition: protocolDefinition });
      expect(bobProtocolStatus.code).toBe(202);
      expect(bobProtocol).toBeDefined();
      const { status: bobProtocolSendStatus } = await bobProtocol.send(bobDid.uri);
      expect(bobProtocolSendStatus.code).toBe(202);

      // Install free-for-all protocol for tests that write records with arbitrary schema/dataFormat.
      const freeForAllDefinition: DwnProtocolDefinition = {
        protocol  : 'http://free-for-all.xyz',
        published : true,
        types     : { post: {}, other: {} },
        structure : { post: {}, other: {} },
      };
      const { status: aliceFfaStatus, protocol: aliceFfaProtocol } = await dwnAlice.protocols.configure({ definition: freeForAllDefinition });
      expect(aliceFfaStatus.code).toBe(202);
      const { status: aliceFfaSendStatus } = await aliceFfaProtocol.send(aliceDid.uri);
      expect(aliceFfaSendStatus.code).toBe(202);
      const { status: bobFfaStatus, protocol: bobFfaProtocol } = await dwnBob.protocols.configure({ definition: freeForAllDefinition });
      expect(bobFfaStatus.code).toBe(202);
      const { status: bobFfaSendStatus } = await bobFfaProtocol.send(bobDid.uri);
      expect(bobFfaSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('deletes a record', async () => {
        const { status: writeStatus, record } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();

        // Write the record to Alice's remote DWN.
        const { status } = await record.send(aliceDid.uri);
        expect(status.code).toBe(202);

        const deleteResult = await dwnAlice.records.delete({
          protocol : protocolUri,
          recordId : record.id
        });

        expect(deleteResult.status.code).toBe(202);
      });

      it('deletes a record and prunes its children', async () => {
        // Install a protocol that supports parent-child relationships.
        const { status: protocolStatus, protocol } = await dwnAlice.protocols.configure({
          definition: {
            protocol  : 'http://example.com/parent-child',
            published : true,
            types     : {
              foo: {
                schema: 'http://example.com/foo',
              },
              bar: {
                schema: 'http://example.com/bar'
              }
            },
            structure: {
              foo: {
                bar: {}
              }
            }
          }
        });
        expect(protocolStatus.code).toBe(202);

        // Write a parent record.
        const { status: parentWriteStatus, record: parentRecord } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocol.definition.protocol,
          protocolPath : 'foo',
          schema       : 'http://example.com/foo',
          dataFormat   : 'text/plain'
        });
        expect(parentWriteStatus.code).toBe(202);
        expect(parentRecord).toBeDefined();

        // Write a child record.
        const { status: childWriteStatus, record: childRecord } = await dwnAlice.records.write({
          data            : 'Hello, world!',
          protocol        : protocol.definition.protocol,
          protocolPath    : 'foo/bar',
          schema          : 'http://example.com/bar',
          dataFormat      : 'text/plain',
          parentContextId : parentRecord.contextId
        });
        expect(childWriteStatus.code).toBe(202);
        expect(childRecord).toBeDefined();

        // query for child records to confirm it exists
        const { status: childrenStatus, records: childrenRecords } = await dwnAlice.records.query({
          filter: {
            protocol     : protocol.definition.protocol,
            protocolPath : 'foo/bar'
          }
        });
        expect(childrenStatus.code).toBe(200);
        expect(childrenRecords).toBeDefined();
        expect(childrenRecords).toHaveLength(1);
        expect(childrenRecords[0].id).toBe(childRecord.id);

        // Delete the parent record and its children.
        const { status: deleteStatus } = await dwnAlice.records.delete({
          recordId : parentRecord.id,
          prune    : true
        });
        expect(deleteStatus.code).toBe(202);

        // query for child records to confirm it was deleted
        const { status: childrenStatusAfterDelete, records: childrenRecordsAfterDelete } = await dwnAlice.records.query({
          filter: {
            protocol     : protocol.definition.protocol,
            protocolPath : 'foo/bar'
          }
        });
        expect(childrenStatusAfterDelete.code).toBe(200);
        expect(childrenRecordsAfterDelete).toBeDefined();
        expect(childrenRecordsAfterDelete).toHaveLength(0);
      });

      it('returns a 404 when the specified record does not exist', async () => {
        const deleteResult = await dwnAlice.records.delete({
          protocol : protocolUri,
          recordId : 'abcd1234'
        });
        expect(deleteResult.status.code).toBe(404);
      });

      it('stores a deleted record along with its initialWrite', async () => {
        // Write a record but do not store it
        const { status: initialWriteStatus, record: initialWriteRecord } = await dwnAlice.records.write({
          store        : false,
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
        });
        expect(initialWriteStatus.code).toBe(202);

        // Delete the record without storing it
        const { status: deleteStatus } = await initialWriteRecord.delete({ store: false });
        expect(deleteStatus.code).toBe(202);

        // delete the record storing it
        const { status: deleteStoreStatus } = await initialWriteRecord.delete();
        expect(deleteStoreStatus.code).toBe(202);

        // try deleting it again
        const { status: deleteStatus2 } = await initialWriteRecord.delete();
        expect(deleteStatus2.code).toBe(404);
      });
    });

    describe('from: did', () => {
      it('deletes a record', async () => {
        const { status: writeStatus, record } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          schema       : 'foo/bar',
          dataFormat   : 'text/plain'
        });

        expect(writeStatus.code).toBe(202);
        expect(record).toBeDefined();

        // Write the record to the remote DWN.
        const { status } = await record.send(aliceDid.uri);
        expect(status.code).toBe(202);

        // Attempt to delete a record from the remote DWN.
        const deleteResult = await dwnAlice.records.delete({
          from     : aliceDid.uri,
          recordId : record.id
        });

        expect(deleteResult.status.code).toBe(202);
        expect(deleteResult.status.detail).toBe('Accepted');
      });

      it('returns a 401 when authentication or authorization fails', async () => {
        // Create a record on Bob's local DWN.
        const writeResult = await dwnBob.records.write({
          data         : 'Hello, world!',
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'foo'
        });
        expect(writeResult.status.code).toBe(202);

        // Write the record to Bob's remote DWN.
        const sendResult = await writeResult.record.send(bobDid.uri);
        expect(sendResult.status.code).toBe(202);

        // Alice attempts to delete a record from Bob's remote DWN specifying a recordId.
        const deleteResult = await dwnAlice.records.delete({
          from     : bobDid.uri,
          recordId : writeResult.record.id
        });

        /** Confirm that authorization failed because the Alice identity does not have
         * permission to delete a record from Bob's DWN. */
        expect(deleteResult.status.code).toBe(401);
        expect(deleteResult.status.detail).toContain('unauthorized');
      });

      it('deletes records that were authored/signed by another DID', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a record authored/signed by one party (Alice) can be written to
         * another party's DWN (Bob), and that recipient (Bob) is able to delete the record.
         *
         * TEST SETUP STEPS:
         *   1. Configure the email protocol on Bob's local DWN.
         */
        const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
          definition: protocolDefinition,
        });
        expect(bobProtocolStatus.code).toBe(202);
        /**
         *   2. Configure the email protocol on Bob's remote DWN.
         */
        const { status: bobRemoteProtocolStatus } = await bobProtocol.send(bobDid.uri);
        expect(bobRemoteProtocolStatus.code).toBe(202);
        /**
         *   3. Alice creates a record, but doesn't store it locally.
         */
        const { status: createStatus, record: testRecord } = await dwnAlice.records.write({
          store        : false,
          data         : 'test',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : 'http://email-protocol.xyz/schema/thread',
          dataFormat   : 'text/plain'
        });
        expect(createStatus.code).toBe(202);
        expect(testRecord.author).toBe(aliceDid.uri);
        /**
         *   4. Alice writes the record to Bob's remote DWN.
         */
        const { status: sendStatus } = await testRecord.send(bobDid.uri);
        expect(sendStatus.code).toBe(202);
        /**
         *   5. Bob deletes the record from his remote DWN.
         */
        const deleteResult = await dwnBob.records.delete({
          from     : bobDid.uri,
          recordId : testRecord.id
        });
        expect(deleteResult.status.code).toBe(202);
      });
    });
  });

  describe('records.query()', () => {
    beforeEach(async() => {
      // Configure the protocol on both DWNs
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocolDefinition
      });
      expect(aliceProtocolStatus.code).toBe(202);
      expect(aliceProtocol).toBeDefined();
      const { status: aliceProtocolSendStatus } = await aliceProtocol.send(aliceDid.uri);
      expect(aliceProtocolSendStatus.code).toBe(202);
      const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({ definition: protocolDefinition });
      expect(bobProtocolStatus.code).toBe(202);
      expect(bobProtocol).toBeDefined();
      const { status: bobProtocolSendStatus } = await bobProtocol.send(bobDid.uri);
      expect(bobProtocolSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('returns an array of records that match the filter provided', async () => {
        const writeResult = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();

        const result = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          }
        });

        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records.length).toBe(1);
        expect(result.records[0].id).toBe(writeResult.record.id);
      });

      it('returns cursor when there are additional results', async () => {
        for (let i = 0; i < 3; i++ ) {
          const writeResult = await dwnAlice.records.write({
            data         : `Hello, world ${i + 1}!`,
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          });

          expect(writeResult.status.code).toBe(202);
          expect(writeResult.status.detail).toBe('Accepted');
          expect(writeResult.record).toBeDefined();
        }

        const results = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          },
          pagination: { limit: 2 } // set a limit of 2
        });

        expect(results.status.code).toBe(200);
        expect(results.records).toBeDefined();
        expect(results.records.length).toBe(2);
        expect(results.cursor).toBeDefined();

        const additionalResults = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          },
          pagination: { limit: 2, cursor: results.cursor }
        });
        expect(additionalResults.status.code).toBe(200);
        expect(additionalResults.records).toBeDefined();
        expect(additionalResults.records.length).toBe(1);
        expect(additionalResults.cursor).toBeUndefined();
      });

      it('sorts results based on provided query sort parameter', async () => {
        const clock = sinon.useFakeTimers();

        const items = [];
        const publishedItems = [];
        for (let i = 0; i < 6; i++ ) {
          const writeResult = await dwnAlice.records.write({
            data         : `Hello, world ${i + 1}!`,
            published    : i % 2 == 0 ? true : false,
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          });

          expect(writeResult.status.code).toBe(202);
          expect(writeResult.status.detail).toBe('Accepted');
          expect(writeResult.record).toBeDefined();

          items.push(writeResult.record.id); // add id to list in the order it was inserted
          if (writeResult.record.published === true) {
            publishedItems.push(writeResult.record.id); // add published records separately
          }

          clock.tick(1000 * 1); // travel forward one second
        }
        clock.restore();

        // query in ascending order by the dateCreated field
        const createdAscResults = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          },
          dateSort: DwnDateSort.CreatedAscending // same as default
        });
        expect(createdAscResults.status.code).toBe(200);
        expect(createdAscResults.records).toBeDefined();
        expect(createdAscResults.records.length).toBe(6);
        expect(createdAscResults.records.map(r => r.id)).toEqual(items);

        // query in descending order by the dateCreated field
        const createdDescResults = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          },
          dateSort: DwnDateSort.CreatedDescending
        });
        expect(createdDescResults.status.code).toBe(200);
        expect(createdDescResults.records).toBeDefined();
        expect(createdDescResults.records.length).toBe(6);
        expect(createdDescResults.records.map(r => r.id)).toEqual([...items].reverse());

        // query in ascending order by the datePublished field, this will only return published records
        const publishedAscResults = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          },
          dateSort: DwnDateSort.PublishedAscending
        });
        expect(publishedAscResults.status.code).toBe(200);
        expect(publishedAscResults.records).toBeDefined();
        expect(publishedAscResults.records.length).toBe(3);
        expect(publishedAscResults.records.map(r => r.id)).toEqual(publishedItems);

        // query in desscending order by the datePublished field, this will only return published records
        const publishedDescResults = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          },
          dateSort: DwnDateSort.PublishedDescending
        });
        expect(publishedDescResults.status.code).toBe(200);
        expect(publishedDescResults.records).toBeDefined();
        expect(publishedDescResults.records.length).toBe(3);
        expect(publishedDescResults.records.map(r => r.id)).toEqual([...publishedItems].reverse());
      });

      it('queries for records matching tags', async () => {

        // Write a record to the agent's local DWN that includes a tag `foo` with value `bar`
        const { status, record } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain',
          tags         : {
            foo: 'bar',
          }
        });
        expect(status.code).toBe(202);

        // Write a record to the agent's local DWN that includes a tag `foo` with value `baz`
        const { status: status2 } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain',
          tags         : {
            foo: 'baz',
          }
        });
        expect(status2.code).toBe(202);

        // Control: query the agent's local DWN for the record without any tag filters
        const result = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          }
        });

        // should return both records
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records.length).toBe(2);


        // Query the agent's local DWN for the record using the tags.
        const fooBarResult = await dwnAlice.records.query({
          filter: {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain',
            tags         : {
              foo: 'bar',
            }
          }
        });

        // should only return the record with the tag `foo` and value `bar`
        expect(fooBarResult.status.code).toBe(200);
        expect(fooBarResult.records).toBeDefined();
        expect(fooBarResult.records.length).toBe(1);
        expect(fooBarResult.records[0].id).toBe(record.id);
        expect(fooBarResult.records[0].tags).toEqual({ foo: 'bar' });
      });
    });

    describe('from: did', () => {
      it('returns an array of records that match the filter provided', async () => {
        // Write a record to the agent's local DWN.
        const { record } = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });

        // Write the record to the agent's remote DWN.
        await record.send(aliceDid.uri);

        // Query the agent's remote DWN.
        const result = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          }
        });

        // Verify the query returns a result.
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records.length).toBe(1);
        expect(result.records[0].id).toBe(record.id);
      });

      it('returns empty records array when no records match the filter provided', async () => {
        // Attempt to query Bob's DWN using the ID of a record that does not exist.
        const result = await dwnAlice.records.query({
          from   : bobDid.uri,
          filter : {
            recordId: 'abcd1234'
          }
        });
        // Confirm that the record does not currently exist on Bob's DWN.
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records.length).toBe(0);
      });

      it('returns the correct author for records signed by another DID', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a record authored/signed by one party (Alice) can be written to
         * another party's DWN (Bob) and retain the original author's DID (Alice) when queried.
         *
         * TEST SETUP STEPS:
         *   1. Configure the email protocol on Bob's local DWN.
         */
        const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
          definition: protocolDefinition
        });
        expect(bobProtocolStatus.code).toBe(202);
        /**
         *   2. Configure the email protocol on Bob's remote DWN.
         */
        const { status: bobRemoteProtocolStatus } = await bobProtocol.send(bobDid.uri);
        expect(bobRemoteProtocolStatus.code).toBe(202);
        /**
         *   3. Alice creates a record, but doesn't store it locally.
         */
        const { status: createStatus, record: testRecord } = await dwnAlice.records.write({
          store        : false,
          data         : 'test',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(createStatus.code).toBe(202);
        expect(testRecord.author).toBe(aliceDid.uri);
        /**
         *   4. Alice writes the record to Bob's remote DWN.
         */
        const { status: sendStatus } = await testRecord.send(bobDid.uri);
        expect(sendStatus.code).toBe(202);
        /**
         *   5. Bob queries his remote DWN for the record.
         */
        const bobQueryResult = await dwnBob.records.query({
          from   : bobDid.uri,
          filter : {
            recordId: testRecord.id
          }
        });

        // The record's author should be Alice's DID since Alice was the signer.
        const [ recordOnBobsDwn ] = bobQueryResult.records;
        expect(recordOnBobsDwn.author).toBe(aliceDid.uri);
      });

      it('queries for records matching tags', async () => {

        // Write a record to alice's remote DWN that includes a tag `foo` with value `bar`
        const { status, record } = await dwnAlice.records.write({
          store        : false,
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain',
          tags         : {
            foo: 'bar',
          }
        });
        expect(status.code).toBe(202);
        const { status: sendFooBarStatus } = await record.send(aliceDid.uri);
        expect(sendFooBarStatus.code).toBe(202);

        // Write a record to alice's remote DWN that includes a tag `foo` with value `baz`
        const { status: status2, record: record2 } = await dwnAlice.records.write({
          store        : false,
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain',
          tags         : {
            foo: 'baz',
          }
        });
        expect(status2.code).toBe(202);
        const { status: sendFooBazStatus } = await record2.send(aliceDid.uri);
        expect(sendFooBazStatus.code).toBe(202);

        // Control: query the agent's local DWN for the record without any tag filters
        const result = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          }
        });

        // should return both records
        expect(result.status.code).toBe(200);
        expect(result.records).toBeDefined();
        expect(result.records.length).toBe(2);


        // Query the agent's local DWN for the record using the tags.
        const fooBarResult = await dwnAlice.records.query({
          from   : aliceDid.uri,
          filter : {
            protocol     : protocolUri,
            protocolPath : 'thread',
            schema       : protocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain',
            tags         : {
              foo: 'bar',
            }
          }
        });

        // should only return the record with the tag `foo` and value `bar`
        expect(fooBarResult.status.code).toBe(200);
        expect(fooBarResult.records).toBeDefined();
        expect(fooBarResult.records.length).toBe(1);
        expect(fooBarResult.records[0].id).toBe(record.id);
        expect(fooBarResult.records[0].tags).toEqual({ foo: 'bar' });
      });

      it('ensures that a protocolRole used to query is also used to read the data of the resulted records', async () => {
        // scenario: Bob has a protocol where he can write notes and add friends who can query and read these notes
        // Alice is a friend of Bob and she queries for the notes and reads the data of the notes
        // the protocolRole used to query for the notes should also be used to read the data of the notes

        const protocol = {
          ...notesProtocolDefinition,
          protocol: 'http://example.com/notes' + TestDataGenerator.randomString(15)
        };

        // Bob configures the notes protocol for himself
        const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
          definition: protocol
        });
        expect(bobProtocolStatus.code).toBe(202);
        const { status: bobRemoteProtocolStatus } = await bobProtocol.send(bobDid.uri);
        expect(bobRemoteProtocolStatus.code).toBe(202);

        // Bob creates a few notes ensuring that the data is larger than the max encoded size
        // that way the data will be requested with a separate `read` request
        const recordData: Map<string, string> = new Map();
        for (let i = 0; i < 3; i++) {
          const data = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
          const { status: noteCreateStatus, record: noteRecord } = await dwnBob.records.write({
            data,
            protocol     : protocol.protocol,
            protocolPath : 'note',
            schema       : protocol.types.note.schema,
            dataFormat   : 'text/plain',
          });
          expect(noteCreateStatus.code).toBe(202);
          const { status: noteSendStatus } = await noteRecord.send();
          expect(noteSendStatus.code).toBe(202);
          recordData.set(noteRecord.id, data);
        }

        // Bob makes Alice a `friend` to allow her to read and comment on his notes
        const { status: friendCreateStatus, record: friendRecord } = await dwnBob.records.write({
          data         : 'friend!',
          recipient    : aliceDid.uri,
          protocol     : protocol.protocol,
          protocolPath : 'friend',
          schema       : protocol.types.friend.schema,
          dataFormat   : 'text/plain'
        });
        expect(friendCreateStatus.code).toBe(202);
        const { status: bobFriendSendStatus } = await friendRecord.send(bobDid.uri);
        expect(bobFriendSendStatus.code).toBe(202);

        // alice uses the role to query for the available notes
        const { status: notesQueryStatus, records: noteRecords } = await dwnAlice.records.query({
          from         : bobDid.uri,
          protocolRole : 'friend',
          filter       : {
            protocol     : protocol.protocol,
            protocolPath : 'note'
          }
        });
        expect(notesQueryStatus.code).toBe(200);
        expect(noteRecords).toBeDefined();
        expect(noteRecords).toHaveLength(3);

        // spy on sendDwnRequest to ensure that the protocolRole is used to read the data of the notes
        const sendDwnRequestSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

        // confirm that it starts with 0 calls
        expect(sendDwnRequestSpy.callCount).toBe(0);
        // Alice attempts to read the data of the notes, which should succeed
        for (const record of noteRecords) {
          const readResult = await record.data.text();
          const expectedData = recordData.get(record.id);
          expect(readResult).toBe(expectedData);
        }

        // confirm that it was called 3 times
        expect(sendDwnRequestSpy.callCount).toBe(3);

        // confirm that the protocolRole was used to read the data of the notes
        expect(sendDwnRequestSpy.getCalls().every(call =>
          call.args[0].messageType === DwnInterface.RecordsRead &&
          (call.args[0] as ProcessDwnRequest<DwnInterface.RecordsRead>).messageParams.protocolRole === 'friend'
        )).toBe(true);
      });
    });
  });

  describe('records.read()', () => {
    beforeEach(async() => {
      // Configure the protocol on both DWNs
      const { status: aliceProtocolStatus, protocol: aliceProtocol } = await dwnAlice.protocols.configure({
        definition: protocolDefinition
      });
      expect(aliceProtocolStatus.code).toBe(202);
      expect(aliceProtocol).toBeDefined();
      const { status: aliceProtocolSendStatus } = await aliceProtocol.send(aliceDid.uri);
      expect(aliceProtocolSendStatus.code).toBe(202);
      const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({ definition: protocolDefinition });
      expect(bobProtocolStatus.code).toBe(202);
      expect(bobProtocol).toBeDefined();
      const { status: bobProtocolSendStatus } = await bobProtocol.send(bobDid.uri);
      expect(bobProtocolSendStatus.code).toBe(202);
    });

    describe('agent', () => {
      it('returns a record', async () => {
        const writeResult = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });

        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();

        const result = await dwnAlice.records.read({
          filter: {
            recordId: writeResult.record.id
          }
        });

        expect(result.status.code).toBe(200);
        expect(result.record.id).toBe(writeResult.record.id);
      });

      it('returns a 404 when a record cannot be found', async () => {
        const writeResult = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });

        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();


        // Delete the record
        await writeResult.record.delete();

        const result = await dwnAlice.records.read({
          filter: {
            recordId: writeResult.record.id
          }
        });

        expect(result.status.code).toBe(404);
        expect(result.record).toBeUndefined();
      });
    });

    describe('from: did', () => {
      it('returns a record', async () => {
        // Write a record to the agent's local DWN.
        const writeResult = await dwnAlice.records.write({
          data         : 'Hello, world!',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });

        expect(writeResult.status.code).toBe(202);
        expect(writeResult.status.detail).toBe('Accepted');
        expect(writeResult.record).toBeDefined();

        // Write the record to the agent's remote DWN.
        await writeResult.record.send(aliceDid.uri);

        // Attempt to read the record from the agent's remote DWN.
        const result = await dwnAlice.records.read({
          from   : aliceDid.uri,
          filter : {
            recordId: writeResult.record.id
          }
        });

        expect(result.status.code).toBe(200);
        expect(result.record.id).toBe(writeResult.record.id);
      });

      it('returns undefined record when requested record does not exit', async () => {
        // Attempt to read a record from Bob's DWN using the ID of a record that only exists in the connected agent's DWN.
        const result = await dwnAlice.records.read({
          from   : bobDid.uri,
          filter : {
            recordId: 'non-existent-id'
          }
        });

        // Confirm that the record does not currently exist on Bob's DWN.
        expect(result.status.code).toBe(404);
        expect(result.record).toBeUndefined();
      });

      it('returns the correct author for records signed by another DID', async () => {
        /**
         * WHAT IS BEING TESTED?
         *
         * We are testing whether a record authored/signed by one party (Alice) can be written to
         * another party's DWN (Bob) and retain the original author's DID (Alice) when read.
         *
         * TEST SETUP STEPS:
         *   1. Configure the email protocol on Bob's local DWN.
         */
        const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
          definition: protocolDefinition,
        });
        expect(bobProtocolStatus.code).toBe(202);
        /**
         *   2. Configure the email protocol on Bob's remote DWN.
         */
        const { status: bobRemoteProtocolStatus } = await bobProtocol.send(bobDid.uri);
        expect(bobRemoteProtocolStatus.code).toBe(202);
        /**
         *   3. Alice creates a record, but doesn't store it locally.
         */
        const { status: createStatus, record: testRecord } = await dwnAlice.records.write({
          store        : false,
          data         : 'test',
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(createStatus.code).toBe(202);
        expect(testRecord.author).toBe(aliceDid.uri);
        /**
         *   4. Alice writes the record to Bob's remote DWN.
         */
        const { status: sendStatus } = await testRecord.send(bobDid.uri);
        expect(sendStatus.code).toBe(202);
        /**
         *   5. Bob queries his remote DWN for the record.
         */
        const bobQueryResult = await dwnBob.records.read({
          from   : bobDid.uri,
          filter : {
            recordId: testRecord.id
          }
        });

        // The record's author should be Alice's DID since Alice was the signer.
        const recordOnBobsDwn = bobQueryResult.record;
        expect(recordOnBobsDwn.author).toBe(aliceDid.uri);
      });
    });
  });

  describe('records.subscribe()', () => {
    describe('agent', () => {
      it('should return a LiveQuery with initial records and respond to live events', async () => {
        // configure a protocol
        const protocolConfigure = await dwnAlice.protocols.configure({
          definition: { ...emailProtocolDefinition, published: true }
        });
        expect(protocolConfigure.status.code).toBe(202);

        // write a record BEFORE subscribing
        const write1 = await dwnAlice.records.write({
          data         : 'Message 1',
          recipient    : bobDid.uri,
          protocol     : emailProtocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : emailProtocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(write1.status.code).toBe(202);

        // subscribe — returns a LiveQuery with the initial snapshot
        const subscribeResult = await dwnAlice.records.subscribe({
          filter: {
            protocol: emailProtocolDefinition.protocol
          }
        });
        expect(subscribeResult.status.code).toBe(200);
        expect(subscribeResult.liveQuery).toBeDefined();
        const live = subscribeResult.liveQuery!;

        // initial records should contain write1
        expect(live.records.length).toBe(1);
        expect(live.records[0].id).toBe(write1.record.id);

        // track change events
        const changes: RecordChange[] = [];
        live.on('change', (change) => { changes.push(change); });

        // write a new record AFTER subscribing — should emit 'create'
        const write2 = await dwnAlice.records.write({
          data         : 'Message 2',
          recipient    : bobDid.uri,
          protocol     : emailProtocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : emailProtocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(write2.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(1);
          expect(changes[0].type).toBe('create');
          expect(changes[0].record.id).toBe(write2.record.id);
        });

        // delete the record using the original writeResult instance of it
        const deleteResult = await write1.record.delete();
        expect(deleteResult.status.code).toBe(202);

        // wait for the delete event
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(2);
          expect(changes[1].type).toBe('delete');
          expect(changes[1].record.id).toBe(write1.record.id);
        });

        // clean up
        await live.close();
      });

      it('should surface terminal subscription errors before closing the live query', async () => {
        let subscriptionHandler: ((msg: DwnSubscriptionMessage) => void) | undefined;
        const subscription = { close: sinon.stub().resolves() };
        const agent = {
          processDwnRequest: sinon.stub().callsFake(async (request: ProcessDwnRequest<DwnInterface.RecordsSubscribe>) => {
            subscriptionHandler = request.subscriptionHandler;
            return {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [],
                subscription,
              }
            };
          })
        };
        const dwn = new DwnApi({ agent: agent as unknown as EnboxAgent, connectedDid: aliceDid.uri });
        const { liveQuery } = await dwn.records.subscribe({
          filter: { protocol: protocolUri }
        });
        const cursor = {
          streamId   : 'events',
          epoch      : '1',
          position   : '10',
          messageCid : 'bafyreihash',
        };
        const errors: LiveQueryError[] = [];

        expect(liveQuery).toBeDefined();
        liveQuery!.on('error', (error) => { errors.push(error); });

        subscriptionHandler!({
          type  : 'error',
          cursor,
          error : {
            code   : 'MessagesSubscribeDeliveryAuthorizationFailed',
            detail : 'subscription grant is no longer valid',
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(errors).toEqual([{
          code   : 'MessagesSubscribeDeliveryAuthorizationFailed',
          detail : 'subscription grant is no longer valid',
          cursor,
        }]);
        expect(liveQuery!.isConnected).toBe(false);
        expect(subscription.close.calledOnce).toBe(true);
      });

      it('should emit update events for updated records', async () => {
        const protocolConfigure = await dwnAlice.protocols.configure({
          definition: { ...emailProtocolDefinition, published: true }
        });
        expect(protocolConfigure.status.code).toBe(202);

        // write a record
        const write1 = await dwnAlice.records.write({
          data         : 'Original',
          recipient    : bobDid.uri,
          protocol     : emailProtocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : emailProtocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(write1.status.code).toBe(202);

        // subscribe
        const { liveQuery: live } = await dwnAlice.records.subscribe({
          filter: { protocol: emailProtocolDefinition.protocol }
        });
        expect(live).toBeDefined();
        expect(live!.records.length).toBe(1);

        const changes: RecordChange[] = [];
        live!.on('change', (change) => { changes.push(change); });

        // update the record
        const updateResult = await write1.record.update({ data: 'Updated' });
        expect(updateResult.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(1);
          expect(changes[0].type).toBe('update');
          expect(changes[0].record.id).toBe(write1.record.id);
        });

        await live!.close();
      });

      it('should emit delete events for deleted records', async () => {
        const protocolConfigure = await dwnAlice.protocols.configure({
          definition: { ...emailProtocolDefinition, published: true }
        });
        expect(protocolConfigure.status.code).toBe(202);

        // write a record
        const write1 = await dwnAlice.records.write({
          data         : 'To be deleted',
          recipient    : bobDid.uri,
          protocol     : emailProtocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : emailProtocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(write1.status.code).toBe(202);

        // subscribe
        const { liveQuery: live } = await dwnAlice.records.subscribe({
          filter: { protocol: emailProtocolDefinition.protocol }
        });
        expect(live).toBeDefined();

        const changes: RecordChange[] = [];
        live!.on('change', (change) => { changes.push(change); });

        // delete the record
        const deleteResult = await write1.record.delete();
        expect(deleteResult.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(1);
          expect(changes[0].type).toBe('delete');
          expect(changes[0].record.id).toBe(write1.record.id);
        });

        await live!.close();
      });

      it('should support typed convenience events (create/update/delete)', async () => {
        const protocolConfigure = await dwnAlice.protocols.configure({
          definition: { ...emailProtocolDefinition, published: true }
        });
        expect(protocolConfigure.status.code).toBe(202);

        const { liveQuery: live } = await dwnAlice.records.subscribe({
          filter: { protocol: emailProtocolDefinition.protocol }
        });
        expect(live).toBeDefined();

        const created: Record[] = [];
        const updated: Record[] = [];
        const deleted: Record[] = [];
        live!.on('create', (record) => { created.push(record); });
        live!.on('update', (record) => { updated.push(record); });
        live!.on('delete', (record) => { deleted.push(record); });

        // write a record
        const writeResult = await dwnAlice.records.write({
          data         : 'Hello',
          recipient    : bobDid.uri,
          protocol     : emailProtocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : emailProtocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(writeResult.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(created.length).toBe(1);
          expect(created[0].id).toBe(writeResult.record.id);
        });

        // update it
        const updateResult = await writeResult.record.update({ data: 'Updated' });
        expect(updateResult.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(updated.length).toBe(1);
          expect(updated[0].id).toBe(writeResult.record.id);
        });

        // delete it
        const deleteResult = await writeResult.record.delete();
        expect(deleteResult.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(deleted.length).toBe(1);
          expect(deleted[0].id).toBe(writeResult.record.id);
        });

        await live!.close();
      });

      it('should return an unsubscribe function from on()', async () => {
        const protocolConfigure = await dwnAlice.protocols.configure({
          definition: { ...emailProtocolDefinition, published: true }
        });
        expect(protocolConfigure.status.code).toBe(202);

        const { liveQuery: live } = await dwnAlice.records.subscribe({
          filter: { protocol: emailProtocolDefinition.protocol }
        });
        expect(live).toBeDefined();

        const changes: RecordChange[] = [];
        const off = live!.on('change', (change) => { changes.push(change); });

        // write a record — should be received
        const write1 = await dwnAlice.records.write({
          data         : 'First',
          recipient    : bobDid.uri,
          protocol     : emailProtocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : emailProtocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(write1.status.code).toBe(202);

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(1);
        });

        // unsubscribe
        off();

        // write another record — should NOT be received
        const write2 = await dwnAlice.records.write({
          data         : 'Second',
          recipient    : bobDid.uri,
          protocol     : emailProtocolDefinition.protocol,
          protocolPath : 'thread',
          schema       : emailProtocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(write2.status.code).toBe(202);

        // give it time to potentially arrive (it shouldn't)
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(changes.length).toBe(1); // still only 1

        await live!.close();
      });

      it('should return a pagination cursor when the initial snapshot is limited', async () => {
        const protocolConfigure = await dwnAlice.protocols.configure({
          definition: { ...emailProtocolDefinition, published: true }
        });
        expect(protocolConfigure.status.code).toBe(202);

        // write 3 records
        for (let i = 0; i < 3; i++) {
          const writeResult = await dwnAlice.records.write({
            data         : `Message ${i}`,
            recipient    : bobDid.uri,
            protocol     : emailProtocolDefinition.protocol,
            protocolPath : 'thread',
            schema       : emailProtocolDefinition.types.thread.schema,
            dataFormat   : 'text/plain'
          });
          expect(writeResult.status.code).toBe(202);
        }

        // subscribe with a limit of 2
        const { liveQuery: live } = await dwnAlice.records.subscribe({
          filter     : { protocol: emailProtocolDefinition.protocol },
          pagination : { limit: 2 }
        });
        expect(live).toBeDefined();

        // should have 2 initial records and a cursor for the next page
        expect(live!.records.length).toBe(2);
        expect(live!.cursor).toBeDefined();
        expect(live!.cursor!.messageCid).toBeDefined();
        expect(live!.cursor!.value).toBeDefined();

        await live!.close();

        // subscribe again using the cursor to get the remaining records
        const { liveQuery: live2 } = await dwnAlice.records.subscribe({
          filter     : { protocol: emailProtocolDefinition.protocol },
          pagination : { limit: 2, cursor: live!.cursor }
        });
        expect(live2).toBeDefined();

        // should have 1 remaining record and no cursor (end of results)
        expect(live2!.records.length).toBe(1);
        expect(live2!.cursor).toBeUndefined();

        await live2!.close();
      });
    });

    describe('from: did', () => {
      it('subscribes to records from remote', async () => {
        // configure a protocol
        const protocolConfigure = await dwnAlice.protocols.configure({
          definition: { ...protocolDefinition, published: true }
        });
        expect(protocolConfigure.status.code).toBe(202);
        const protocolSend = await protocolConfigure.protocol.send(aliceDid.uri);
        expect(protocolSend.status.code).toBe(202);

        //configure the protocol on bob's DWN
        const protocolConfigureBob = await dwnBob.protocols.configure({
          definition: { ...protocolDefinition, published: true }
        });
        expect(protocolConfigureBob.status.code).toBe(202);
        const protocolSendBob = await protocolConfigureBob.protocol.send(bobDid.uri);
        expect(protocolSendBob.status.code).toBe(202);

        // subscribe to all messages from the protocol
        const { liveQuery: live } = await dwnAlice.records.subscribe({
          from   : aliceDid.uri,
          filter : {
            protocol: protocolUri,
          }
        });
        expect(live).toBeDefined();

        const changes: RecordChange[] = [];
        live!.on('change', (change) => { changes.push(change); });

        // write a record
        const writeResult = await dwnAlice.records.write({
          data         : 'Hello, world!',
          recipient    : bobDid.uri,
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        expect(writeResult.status.code).toBe(202);
        const writeResultSend = await writeResult.record.send();
        expect(writeResultSend.status.code).toBe(202);

        // wait for the create event
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(1);
          expect(changes[0].type).toBe('create');
          expect(changes[0].record.id).toBe(writeResult.record.id);
        });

        // delete the record using the original writeResult instance of it
        const { status: deleteStatus, record: deletedRecord } = await writeResult.record.delete();
        expect(deleteStatus.code).toBe(202);
        const deleteResultSend = await deletedRecord.send();
        expect(deleteResultSend.status.code).toBe(202);

        // wait for the delete event
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(2);
          expect(changes[1].type).toBe('delete');
          expect(changes[1].record.id).toBe(writeResult.record.id);
        });

        // write another record
        const writeResult2 = await dwnAlice.records.write({
          data         : 'Hello, world!',
          recipient    : bobDid.uri,
          protocol     : protocolUri,
          protocolPath : 'thread',
          schema       : protocolDefinition.types.thread.schema,
          dataFormat   : 'text/plain'
        });
        const writeResult2Send = await writeResult2.record.send();
        expect(writeResult2Send.status.code).toBe(202);

        // wait for the create event
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(changes.length).toBe(3);
          expect(changes[2].type).toBe('create');
          expect(changes[2].record.id).toBe(writeResult2.record.id);
        });

        await live!.close();
      });

      it('ensures that a protocolRole used to subscribe is also used to read the data of the resulted records', async () => {
        // scenario: Bob has a protocol where he can write notes and add friends who can subscribe and read these notes
        // When Alice subscribes to the notes protocol using the role, the role should also be used to read the data of the notes

        const protocol = {
          ...notesProtocolDefinition,
          protocol: 'http://example.com/notes' + TestDataGenerator.randomString(15)
        };

        // Bob configures the notes protocol for himself
        const { status: bobProtocolStatus, protocol: bobProtocol } = await dwnBob.protocols.configure({
          definition: protocol
        });
        expect(bobProtocolStatus.code).toBe(202);
        const { status: bobRemoteProtocolStatus } = await bobProtocol.send(bobDid.uri);
        expect(bobRemoteProtocolStatus.code).toBe(202);


        // Bob makes Alice a `friend` to allow her to read and comment on his notes
        const { status: friendCreateStatus, record: friendRecord } = await dwnBob.records.write({
          data         : 'friend!',
          recipient    : aliceDid.uri,
          protocol     : protocol.protocol,
          protocolPath : 'friend',
          schema       : protocol.types.friend.schema,
          dataFormat   : 'text/plain'
        });
        expect(friendCreateStatus.code).toBe(202);
        const { status: bobFriendSendStatus } = await friendRecord.send(bobDid.uri);
        expect(bobFriendSendStatus.code).toBe(202);

        // Alice subscribes to the notes protocol using the role
        const notes: Record[] = [];
        const { status: notesSubscribeStatus, liveQuery: live } = await dwnAlice.records.subscribe({
          from         : bobDid.uri,
          protocolRole : 'friend',
          filter       : {
            protocol     : protocol.protocol,
            protocolPath : 'note'
          }
        });
        expect(notesSubscribeStatus.code).toBe(200);
        expect(live).toBeDefined();

        live!.on('create', (record) => {
          notes.push(record);
        });

        // Bob creates a few notes ensuring that the data is larger than the max encoded size
        // that way the data will be requested with a separate `read` request
        const recordData: Map<string, string> = new Map();
        for (let i = 0; i < 3; i++) {
          const data = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
          const { status: noteCreateStatus, record: noteRecord } = await dwnBob.records.write({
            data,
            protocol     : protocol.protocol,
            protocolPath : 'note',
            schema       : protocol.types.note.schema,
            dataFormat   : 'text/plain',
          });
          expect(noteCreateStatus.code).toBe(202);
          const { status: noteSendStatus } = await noteRecord.send();
          expect(noteSendStatus.code).toBe(202);
          recordData.set(noteRecord.id, data);
        }

        // poll for the note records to be received
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(notes.length).toBe(3);
        });

        // spy on sendDwnRequest to ensure that the protocolRole is used to read the data of the notes
        const sendDwnRequestSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

        // confirm that it starts with 0 calls
        expect(sendDwnRequestSpy.callCount).toBe(0);
        // Alice attempts to read the data of the notes, which should succeed
        for (const record of notes) {
          const readResult = await record.data.text();
          const expectedData = recordData.get(record.id);
          expect(readResult).toBe(expectedData);
        }

        // confirm that it was called 3 times
        expect(sendDwnRequestSpy.callCount).toBe(3);

        // confirm that the protocolRole was used to read the data of the notes
        expect(sendDwnRequestSpy.getCalls().every(call =>
          call.args[0].messageType === DwnInterface.RecordsRead &&
          (call.args[0] as ProcessDwnRequest<DwnInterface.RecordsRead>).messageParams.protocolRole === 'friend'
        )).toBe(true);

        await live!.close();
      });
    });
  });

  describe('permissions.grant', () => {
    it('uses the connected DID to create a grant if no delegate DID is set', async () => {
      // scenario: create a permission grant for bob, confirm that alice is the signer

      // create a permission grant for bob
      const deviceXGrant = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const author = getRecordAuthor(deviceXGrant.rawMessage);
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri); // connected DID should be alice
      expect(author).toBe(aliceDid.uri);
    });

    it('uses the delegate DID to create a grant if set', async () => {
      // scenario: create a permission grant for aliceDeviceX, confirm that deviceX is the signer

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // set the delegate DID, this happens during a connect flow
      dwnAlice['delegateDid'] = aliceDeviceX.did.uri;

      // create a permission grant for deviceX
      const deviceXGrant = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const author = getRecordAuthor(deviceXGrant.rawMessage);
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri); // connected DID should be alice
      expect(dwnAlice['delegateDid']).toBe(aliceDeviceX.did.uri); // delegate DID should be deviceX
      expect(author).toBe(aliceDeviceX.did.uri);
    });

    it('creates and stores a grant', async () => {
      // scenario: create a grant for deviceX, confirm the grant exists

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });


      // create a grant for deviceX
      const deviceXGrant = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the grant
      const fetchedGrants = await dwnAlice.records.query({
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.grantPath,
        }
      });

      // expect to have the 1 grant created for deviceX
      expect(fetchedGrants.status.code).toBe(200);
      expect(fetchedGrants.records).toBeDefined();
      expect(fetchedGrants.records.length).toBe(1);
      expect(fetchedGrants.records[0].id).toBe(deviceXGrant.rawMessage.recordId);
    });

    it('creates a grant without storing it', async () => {
      // scenario: create a grant for deviceX, confirm the grant does not exist

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // create a grant for deviceX store is set to false by default
      const deviceXGrant = await dwnAlice.permissions.grant({
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the grant
      let fetchedGrants = await dwnAlice.records.query({
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.grantPath,
        }
      });

      // expect to have no grants
      expect(fetchedGrants.status.code).toBe(200);
      expect(fetchedGrants.records).toBeDefined();
      expect(fetchedGrants.records.length).toBe(0);

      // store the grant
      const processGrantReply = await deviceXGrant.store();
      expect(processGrantReply.status.code).toBe(202);

      // query for the grants again
      fetchedGrants = await dwnAlice.records.query({
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.grantPath,
        }
      });

      // expect to have the 1 grant created for deviceX
      expect(fetchedGrants.status.code).toBe(200);
      expect(fetchedGrants.records).toBeDefined();
      expect(fetchedGrants.records.length).toBe(1);
      expect(fetchedGrants.records[0].id).toBe(deviceXGrant.rawMessage.recordId);
    });
  });

  describe('permissions.request', () => {
    it('uses the connected DID to create a request if no delegate DID is set', async () => {
      // scenario: create a permission request for bob, confirm the request exists

      // create a permission request for bob
      const deviceXRequest = await dwnAlice.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const author = getRecordAuthor(deviceXRequest.rawMessage);
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri); // connected DID should be alice
      expect(author).toBe(aliceDid.uri);
    });

    it('uses the delegate DID to create a request if set', async () => {
      // scenario: create a permission request for aliceDeviceX, the signer

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // set the delegate DID
      dwnAlice['delegateDid'] = aliceDeviceX.did.uri;

      // create a permission request for deviceX
      const deviceXRequest = await dwnAlice.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const author = getRecordAuthor(deviceXRequest.rawMessage);
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri); // connected DID should be alice
      expect(dwnAlice['delegateDid']).toBe(aliceDeviceX.did.uri); // delegate DID should be deviceX
      expect(author).toBe(aliceDeviceX.did.uri);
    });

    it('creates a permission request and stores it', async () => {
      // scenario: create a permission request confirm the request exists

      // create a permission request
      const deviceXRequest = await dwnAlice.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the request
      const fetchedRequests = await dwnAlice.records.query({
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.requestPath,
        }
      });

      // expect to have the 1 request created
      expect(fetchedRequests.status.code).toBe(200);
      expect(fetchedRequests.records).toBeDefined();
      expect(fetchedRequests.records.length).toBe(1);
      expect(fetchedRequests.records[0].id).toBe(deviceXRequest.rawMessage.recordId);
    });

    it('creates a permission request without storing it', async () => {
      // scenario: create a permission request confirm the request does not exist

      // create a permission request store is set to false by default
      const deviceXRequest = await dwnAlice.permissions.request({
        scope: {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the request
      let fetchedRequests = await dwnAlice.records.query({
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.requestPath,
        }
      });

      // expect to have no requests
      expect(fetchedRequests.status.code).toBe(200);
      expect(fetchedRequests.records).toBeDefined();
      expect(fetchedRequests.records.length).toBe(0);

      // store the request
      const storeDeviceXRequest = await deviceXRequest.store();
      expect(storeDeviceXRequest.status.code).toBe(202);

      // query for the requests again
      fetchedRequests = await dwnAlice.records.query({
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.requestPath,
        }
      });

      // expect to have the 1 request created for deviceX
      expect(fetchedRequests.status.code).toBe(200);
      expect(fetchedRequests.records).toBeDefined();
      expect(fetchedRequests.records.length).toBe(1);
      expect(fetchedRequests.records[0].id).toBe(deviceXRequest.rawMessage.recordId);
    });
  });

  describe('permissions.queryRequests', () => {
    it('uses the connected DID to query for permission requests if no delegate DID is set', async () => {
      // scenario: query for permission requests, confirm that alice is the author of the query

      // create a permission request
      await dwnAlice.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // spy on the fetch requests method to confirm the author
      const fetchRequestsSpy = sinon.spy(AgentPermissionsApi.prototype, 'fetchRequests');

      // Query for requests
      const deviceXRequests = await dwnAlice.permissions.queryRequests();
      expect(deviceXRequests.length).toBe(1);

      // confirm alice is the connected DID
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri);
      expect(fetchRequestsSpy.callCount).toBe(1);
      expect(fetchRequestsSpy.args[0][0].author).toBe(aliceDid.uri);
    });

    it('uses the delegate DID to query for permission requests if set', async () => {
      // scenario: query for permission requests for aliceDeviceX, confirm that deviceX is the signer

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // spy on the fetch requests method to confirm the author
      const fetchRequestsSpy = sinon.spy(AgentPermissionsApi.prototype, 'fetchRequests');

      // set the delegate DID, this happens during a connect flow
      dwnAlice['delegateDid'] = aliceDeviceX.did.uri;

      // create a permission request
      await dwnAlice.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // Query for requests
      const deviceXRequests = await dwnAlice.permissions.queryRequests();
      expect(deviceXRequests.length).toBe(1);

      // confirm alice is the connected DID, and aliceDeviceX is the delegate DID
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri);
      expect(dwnAlice['delegateDid']).toBe(aliceDeviceX.did.uri);

      // confirm the author is aliceDeviceX
      expect(fetchRequestsSpy.callCount).toBe(1);
      expect(fetchRequestsSpy.args[0][0].author).toBe(aliceDeviceX.did.uri);
    });

    it('should query for permission requests from the local DWN', async () => {
      // bob creates two different requests and stores it
      const bobRequest = await dwnBob.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-1'
        }
      });

      // query for the requests
      const fetchedRequests = await dwnBob.permissions.queryRequests();
      expect(fetchedRequests.length).toBe(1);
      expect(fetchedRequests[0].id).toBe(bobRequest.id);
    });

    it('should query for permission requests from the remote DWN', async () => {
      // bob creates two different requests and stores it
      const bobRequest = await dwnBob.permissions.request({
        scope: {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-1'
        }
      });

      // send the request to alice's DWN
      const sentToAlice = await bobRequest.send(aliceDid.uri);
      expect(sentToAlice.status.code).toBe(202);

      // alice Queries the remote DWN for the requests
      const fetchedRequests = await dwnAlice.permissions.queryRequests({
        from: aliceDid.uri
      });
      expect(fetchedRequests.length).toBe(1);
      expect(fetchedRequests[0].id).toBe(bobRequest.id);
    });

    it('should filter by protocol', async () => {
      // bob creates two different requests and stores it
      const bobRequest1 = await dwnBob.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-1'
        }
      });

      const bobRequest2 = await dwnBob.permissions.request({
        store : true,
        scope : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol-2'
        }
      });

      // query for the requests with protocol-1
      const fetchedRequests = await dwnBob.permissions.queryRequests({
        protocol: 'http://example.com/protocol-1'
      });
      expect(fetchedRequests.length).toBe(1);
      expect(fetchedRequests[0].id).toBe(bobRequest1.id);

      // query for the requests with protocol-2
      const fetchedRequests2 = await dwnBob.permissions.queryRequests({
        protocol: 'http://example.com/protocol-2'
      });
      expect(fetchedRequests2.length).toBe(1);
      expect(fetchedRequests2[0].id).toBe(bobRequest2.id);
    });
  });

  describe('permissions.queryGrants', () => {
    it('uses the connected DID to query for grants if no delegate DID is set', async () => {
      // scenario: query for grants, confirm that alice is the author of the query

      // spy on the fetch grants method to confirm the author
      const fetchGrantsSpy = sinon.spy(AgentPermissionsApi.prototype, 'fetchGrants');

      // Query for grants
      const deviceXGrants = await dwnAlice.permissions.queryGrants();
      expect(deviceXGrants.length).toBe(0);

      // confirm alice is the connected DID
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri);
      expect(fetchGrantsSpy.callCount).toBe(1);
      expect(fetchGrantsSpy.args[0][0].author).toBe(aliceDid.uri);
    });

    it('uses the delegate DID to query for grants if set', async () => {
      // scenario: query for grants for aliceDeviceX, confirm that deviceX is the signer

      // create an identity for deviceX
      const aliceDeviceX = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // spy on the fetch grants method to confirm the author
      const fetchGrantsSpy = sinon.spy(AgentPermissionsApi.prototype, 'fetchGrants');

      // set the delegate DID, this happens during a connect flow
      dwnAlice['delegateDid'] = aliceDeviceX.did.uri;

      // Query for grants
      const deviceXGrants = await dwnAlice.permissions.queryGrants();
      expect(deviceXGrants.length).toBe(0);

      // confirm alice is the connected DID, and aliceDeviceX is the delegate DID
      expect(dwnAlice['connectedDid']).toBe(aliceDid.uri);
      expect(dwnAlice['delegateDid']).toBe(aliceDeviceX.did.uri);

      // confirm the author is aliceDeviceX
      expect(fetchGrantsSpy.callCount).toBe(1);
      expect(fetchGrantsSpy.args[0][0].author).toBe(aliceDeviceX.did.uri);
    });

    it('should query for permission grants from the local DWN', async () => {
      // alice creates a grant for bob and stores it
      const bobGrant = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the grants
      const fetchedGrants = await dwnAlice.permissions.queryGrants();
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(bobGrant.id);
    });

    it('should query for permission grants from the remote DWN', async () => {
      // alice creates a grant for bob and doesn't store it locally
      const bobGrant = await dwnAlice.permissions.grant({
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : protocolUri,
        }
      });

      // alice queries the remote DWN, should not find any grants
      let fetchedGrants = await dwnAlice.permissions.queryGrants({
        from     : aliceDid.uri,
        protocol : protocolUri
      });
      expect(fetchedGrants.length).toBe(0);

      // send the grant to alice's remote DWN
      const sentToAlice = await bobGrant.send(aliceDid.uri);
      expect(sentToAlice.status.code).toBe(202);

      // alice queries the remote DWN for the grants
      fetchedGrants = await dwnAlice.permissions.queryGrants({
        from     : aliceDid.uri,
        protocol : protocolUri
      });
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(bobGrant.id);
    });

    it('should filter by protocol', async () => {
      // alice creates two different grants for bob
      const bobGrant1 = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : protocolUri + '-1' // protocol 1
        }
      });

      const bobGrant2 = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : protocolUri + '-2' // protocol 2
        }
      });

      // query for the grants with protocol-1
      let fetchedGrants = await dwnAlice.permissions.queryGrants({
        protocol: protocolUri + '-1' // protocol 1
      });
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(bobGrant1.id);

      // query for the grants with protocol-2
      fetchedGrants = await dwnAlice.permissions.queryGrants({
        protocol: protocolUri + '-2' // protocol 2
      });
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(bobGrant2.id);
    });

    it('should filter by grantee', async () => {
      const { did: carolDid } = await testHarness.agent.identity.create({
        store     : false,
        metadata  : { name: 'Carol' },
        didMethod : 'jwk'
      });

      // alice creates a grant for bob and stores it
      const bobGrant = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // alice creates a grant for carol and stores it
      const carolGrant = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : carolDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the grants with bob as the grantee
      let fetchedGrants = await dwnAlice.permissions.queryGrants({
        grantee: bobDid.uri
      });
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(bobGrant.id);

      // query for the grants with carol as the grantee
      fetchedGrants = await dwnAlice.permissions.queryGrants({
        grantee: carolDid.uri
      });
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(carolGrant.id);
    });

    it('should filter by grantor', async () => {
      const { did: carolDid } = await testHarness.agent.identity.create({
        store     : true,
        metadata  : { name: 'Carol' },
        didMethod : 'jwk'
      });

      // alice creates a grant for bob
      const { message: messageGrantFromAlice } = await testHarness.agent.permissions.createGrant({
        store       : false,
        author      : aliceDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const grantFromAlice = PermissionGrant.parse({
        agent        : testHarness.agent,
        connectedDid : bobDid.uri, // bob is the connectedDid
        message      : messageGrantFromAlice
      });

      // bob imports the grant
      const importFromAlice = await grantFromAlice.import(true);
      expect(importFromAlice.status.code).toBe(202);

      // carol creates a grant for bob
      const { message: messageGrantFromCarol } = await testHarness.agent.permissions.createGrant({
        store       : false,
        author      : carolDid.uri,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      const grantFromCarol = PermissionGrant.parse({
        agent        : testHarness.agent,
        connectedDid : bobDid.uri, // bob is the connectedDid
        message      : messageGrantFromCarol
      });

      const importGrantCarol = await grantFromCarol.import(true);
      expect(importGrantCarol.status.code).toBe(202);

      // query for the grants with alice as the grantor
      const fetchedGrantsAlice = await dwnBob.permissions.queryGrants({
        grantor: aliceDid.uri
      });
      expect(fetchedGrantsAlice.length).toBe(1);
      expect(fetchedGrantsAlice[0].id).toBe(grantFromAlice.id);

      // query for the grants with carol as the grantor
      const fetchedGrantsCarol = await dwnBob.permissions.queryGrants({
        grantor: carolDid.uri
      });
      expect(fetchedGrantsCarol.length).toBe(1);
      expect(fetchedGrantsCarol[0].id).toBe(grantFromCarol.id);
    });

    it('should filter out revoked grants by default', async () => {
      // alice creates a grant for bob and stores it
      const bobGrant = await dwnAlice.permissions.grant({
        store       : true,
        grantedTo   : bobDid.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : 'http://example.com/protocol'
        }
      });

      // query for the grants — should include the grant
      let fetchedGrants = await dwnAlice.permissions.queryGrants();
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(bobGrant.id);

      // revoke the grant
      await bobGrant.revoke();

      // default query should now exclude the revoked grant
      fetchedGrants = await dwnAlice.permissions.queryGrants();
      expect(fetchedGrants.length).toBe(0);

      // with checkRevoked: false, the revoked grant should still be returned
      fetchedGrants = await dwnAlice.permissions.queryGrants({ checkRevoked: false });
      expect(fetchedGrants.length).toBe(1);
      expect(fetchedGrants[0].id).toBe(bobGrant.id);
    });
  });
});
