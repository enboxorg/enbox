import type { BearerDid } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { DwnMessage, DwnProtocolDefinition } from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { Jws } from '@enbox/dwn-sdk-js';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { createPermissionGrants, DwnInterface, EnboxUserAgent, getRecordAuthor } from '@enbox/agent';
import { processConnectedGrants, WalletConnect } from '@enbox/auth';

import photosProtocolDefinition from './fixtures/protocol-definitions/photos.json' with { type: 'json' };

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { Enbox } from '../src/enbox.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// Cross-tenant writes through the high-level API (#973).
//
// The agent already supports target-aware writes end-to-end (remote dispatch,
// grant/role resolution, cross-DWN encryption); these tests cover the api
// wrappers that used to block it: `records.write` / typed `create` with
// `from`, and `Record.update` with an explicit `from`.
// ---------------------------------------------------------------------------

describe('cross-tenant writes (#973)', () => {
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let dwnAlice: DwnApi;
  let dwnBob: DwnApi;
  let testHarness: PlatformAgentTestHarness;
  let protocolDefinition: DwnProtocolDefinition;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/dwn-api-remote-write',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    bobDid = bob.did;

    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    dwnBob = new DwnApi({ agent: testHarness.agent, connectedDid: bobDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();

    // Give the protocol a random URI per test so remote-tenant state from one
    // test never leaks into the next (the shared dev DWN server persists).
    protocolDefinition = {
      ...photosProtocolDefinition,
      protocol: `http://photo-protocol.xyz/${TestDataGenerator.randomString(15)}`,
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  /** Installs the protocol for Alice locally and on her remote DWN. */
  async function installProtocolForAlice(): Promise<void> {
    const { status, protocol } = await dwnAlice.protocols.configure({ definition: protocolDefinition });
    expect(status.code).toBe(202);
    const { status: sendStatus } = await protocol!.send(aliceDid.uri);
    expect(sendStatus.code).toBe(202);
  }

  /** Writes a `friend` $role record for Bob on Alice's tenant and sends it to her remote DWN. */
  async function grantBobFriendRole(): Promise<void> {
    const { status, record } = await dwnAlice.records.write({
      data         : 'friend role for bob',
      recipient    : bobDid.uri,
      protocol     : protocolDefinition.protocol,
      protocolPath : 'friend',
      schema       : protocolDefinition.types.friend.schema,
      dataFormat   : 'text/plain',
    });
    expect(status.code).toBe(202);
    const { status: sendStatus } = await record!.send(aliceDid.uri);
    expect(sendStatus.code).toBe(202);
  }

  describe('records.write with from', () => {
    it('should accept a role-authorized cross-tenant write and stamp remoteOrigin', async () => {
      await installProtocolForAlice();
      await grantBobFriendRole();

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      // Bob writes an album INTO Alice's remote DWN under his `friend` role.
      const { status, record, audienceKeyDelivery } = await dwnBob.records.write({
        data         : 'bob writes into alice dwn',
        from         : aliceDid.uri,
        recipient    : aliceDid.uri,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'album',
        protocolRole : 'friend',
        schema       : protocolDefinition.types.album.schema,
        dataFormat   : 'text/plain',
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // The write dispatched REMOTELY (sendDwnRequest), never through the
      // local processing path.
      expect(sendSpy.callCount).toBe(1);
      expect(processSpy.callCount).toBe(0);
      expect(sendSpy.firstCall.args[0].target).toBe(aliceDid.uri);
      expect(sendSpy.firstCall.args[0].author).toBe(bobDid.uri);

      // audienceKeyDelivery is a processRequest-only concept — never
      // fabricated on the remote path.
      expect(audienceKeyDelivery).toBeUndefined();

      // The returned record is stamped for the owner tenant: data re-reads
      // target Alice's DWN, and the invoked role is carried for them.
      expect(record!['_remoteOrigin']).toBe(aliceDid.uri);
      expect(record!.protocolRole).toBe('friend');
      expect(record!.author).toBe(bobDid.uri);

      // The record actually landed on Alice's remote DWN with data intact.
      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id },
      });
      expect(readResult.status.code).toBe(200);
      expect(await readResult.record!.data.text()).toBe('bob writes into alice dwn');
    });

    it('should surface the rejection of a non-role, non-grant cross-tenant write', async () => {
      await installProtocolForAlice();
      // No friend role for Bob this time.

      const { status, record } = await dwnBob.records.write({
        data         : 'unauthorized write',
        from         : aliceDid.uri,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'album',
        schema       : protocolDefinition.types.album.schema,
        dataFormat   : 'text/plain',
      });

      // The owner's DWN rejects the write; the status surfaces, not swallowed.
      expect(status.code).toBe(401);
      expect(record).toBeUndefined();
    });

    it('should keep the from-less write on the local processing path (regression)', async () => {
      await installProtocolForAlice();

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      const { status, record } = await dwnAlice.records.write({
        data         : 'local write',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'album',
        schema       : protocolDefinition.types.album.schema,
        dataFormat   : 'text/plain',
      });

      expect(status.code).toBe(202);
      expect(record!['_remoteOrigin']).toBeUndefined();
      expect(sendSpy.callCount).toBe(0);
    });

    it('should reject recipientRolePublicKey on the remote path (agent throws, surfaced)', async () => {
      await installProtocolForAlice();
      await grantBobFriendRole();

      // A structurally valid X25519 public JWK — the agent must reject it
      // before any shape validation because the path itself is unsupported.
      const x25519PublicKey = {
        kty : 'OKP',
        crv : 'X25519',
        x   : 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo',
      };

      await expect(dwnBob.records.write({
        data                   : 'role record with supplied key',
        from                   : aliceDid.uri,
        recipient              : aliceDid.uri,
        protocol               : protocolDefinition.protocol,
        protocolPath           : 'album',
        protocolRole           : 'friend',
        schema                 : protocolDefinition.types.album.schema,
        dataFormat             : 'text/plain',
        recipientRolePublicKey : x25519PublicKey,
      })).rejects.toThrow('recipientRolePublicKey is not supported on sendRequest');
    });
  });

  describe('typed records.create with from', () => {
    it('should role-write into the owner tenant through the typed surface and wrap the result', async () => {
      await installProtocolForAlice();
      await grantBobFriendRole();

      // The photos fixture types carry dataFormats: ['text/plain'], so the
      // typed payload for `album` is a plain string.
      type PhotosSchemaMap = { album: string };
      const typedBob = new TypedEnbox(
        dwnBob,
        defineProtocol(protocolDefinition as ProtocolDefinition, {} as PhotosSchemaMap),
      );

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      // Typed create auto-configures the protocol on Bob's LOCAL tenant, then
      // dispatches the record write to Alice's REMOTE tenant.
      const { status, record } = await typedBob.records.create('album', {
        data         : 'bob types into alice dwn',
        from         : aliceDid.uri,
        recipient    : aliceDid.uri,
        protocolRole : 'friend',
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // The record WRITE went remote; the auto-configure stayed local.
      const remoteWrites = sendSpy.getCalls().filter((call) => call.args[0].messageType === DwnInterface.RecordsWrite);
      expect(remoteWrites).toHaveLength(1);
      expect(remoteWrites[0].args[0].target).toBe(aliceDid.uri);

      // The typed wrapper carries the owner-tenant stamping through.
      expect(record!.rawRecord['_remoteOrigin']).toBe(aliceDid.uri);
      expect(record!.protocolRole).toBe('friend');

      // The record landed on Alice's remote DWN with the typed payload.
      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id },
      });
      expect(readResult.status.code).toBe(200);
      expect(await readResult.record!.data.text()).toBe('bob types into alice dwn');
    });
  });

  describe('Record.update with from', () => {
    it('should dispatch a role-authorized cross-tenant update remotely and stamp remoteOrigin', async () => {
      await installProtocolForAlice();
      await grantBobFriendRole();

      // Bob creates the album cross-tenant, then co-updates it cross-tenant
      // under the same role (photos protocol: friend can create + update).
      const { status: createStatus, record } = await dwnBob.records.write({
        data         : 'v1',
        from         : aliceDid.uri,
        recipient    : aliceDid.uri,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'album',
        protocolRole : 'friend',
        schema       : protocolDefinition.types.album.schema,
        dataFormat   : 'text/plain',
      });
      expect(createStatus.code).toBe(202);

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const { status: updateStatus, record: updatedRecord } = await record!.update({
        data : 'v2',
        from : aliceDid.uri,
      });

      expect(updateStatus.code).toBe(202);
      expect(sendSpy.callCount).toBe(1);
      expect(processSpy.callCount).toBe(0);
      expect(sendSpy.firstCall.args[0].target).toBe(aliceDid.uri);

      // The returned record keeps targeting the owner tenant for data reads.
      expect(updatedRecord['_remoteOrigin']).toBe(aliceDid.uri);

      // The update landed on Alice's remote DWN.
      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id },
      });
      expect(readResult.status.code).toBe(200);
      expect(await readResult.record!.data.text()).toBe('v2');
    });

    it('should update locally when a remote-origin record is updated without from (regression)', async () => {
      await installProtocolForAlice();

      // Alice writes locally, sends to her remote, then reads it back FROM the
      // remote — producing a record with a remote origin.
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data         : 'local v1',
        protocol     : protocolDefinition.protocol,
        protocolPath : 'album',
        schema       : protocolDefinition.types.album.schema,
        dataFormat   : 'text/plain',
      });
      expect(writeStatus.code).toBe(202);
      const { status: sendStatus } = await record!.send(aliceDid.uri);
      expect(sendStatus.code).toBe(202);

      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id },
      });
      expect(readResult.status.code).toBe(200);
      const remoteOriginRecord = readResult.record!;
      expect(remoteOriginRecord['_remoteOrigin']).toBe(aliceDid.uri);

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      // No `from` — the update must stay LOCAL despite the remote origin.
      const { status: updateStatus } = await remoteOriginRecord.update({ data: 'local v2' });

      expect(updateStatus.code).toBe(202);
      expect(sendSpy.callCount).toBe(0);
      expect(processSpy.callCount).toBe(1);
      expect(processSpy.firstCall.args[0].target).toBe(aliceDid.uri);
    });
  });

  describe('delegated-grant writes with from', () => {
    let delegateHarness: PlatformAgentTestHarness;

    beforeAll(async () => {
      delegateHarness = await PlatformAgentTestHarness.setup({
        agentClass       : EnboxUserAgent,
        agentStores      : 'memory',
        testDataLocation : '__TESTDATA__/dwn-api-remote-write-delegate',
      });

      await delegateHarness.clearStorage();
      await delegateHarness.createAgentDid();
    });

    afterAll(async () => {
      await delegateHarness.clearStorage();
      await delegateHarness.closeStorage();
    });

    it('should dispatch a delegated-grant write to the owner\'s remote DWN', async () => {
      // Alice installs a simple notes protocol locally and on her remote DWN.
      const notesProtocol: DwnProtocolDefinition = {
        published : true,
        protocol  : `http://notes-protocol.xyz/protocol/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema      : 'https://notes-protocol.xyz/schema/note',
            dataFormats : ['text/plain'],
          },
        },
        structure: {
          note: {},
        },
      };
      const { status: configStatus, protocol } = await dwnAlice.protocols.configure({ definition: notesProtocol });
      expect(configStatus.code).toBe(202);
      const { status: protocolSendStatus } = await protocol!.send(aliceDid.uri);
      expect(protocolSendStatus.code).toBe(202);

      // Alice grants a device did:jwk delegated write/read for the protocol;
      // the DELEGATE agent (separate harness, no Alice keys) imports it.
      const delegatedBearerDid = await testHarness.agent.did.create({ store: false, method: 'jwk' });
      const delegatePortableDid = await delegatedBearerDid.export();
      const grantRequest = WalletConnect.createPermissionRequestForProtocol({
        definition  : notesProtocol,
        permissions : ['write', 'read'],
      });
      const grants = await createPermissionGrants(
        aliceDid.uri, delegatedBearerDid.uri, testHarness.agent, grantRequest.permissionScopes,
      );

      await delegateHarness.agent.identity.import({ portableIdentity: {
        portableDid : delegatePortableDid,
        metadata    : {
          connectedDid : aliceDid.uri,
          name         : 'Device',
          uri          : delegatePortableDid.uri,
          tenant       : delegateHarness.agent.agentDid.uri,
        },
      } });
      await processConnectedGrants({
        grants,
        connectedDid : aliceDid.uri,
        delegateDid  : delegatePortableDid.uri,
        agent        : delegateHarness.agent as EnboxUserAgent,
      });

      const enbox = new Enbox({
        agent        : delegateHarness.agent,
        connectedDid : aliceDid.uri,
        delegateDid  : delegatePortableDid.uri,
      });

      const sendSpy = sinon.spy(delegateHarness.agent, 'sendDwnRequest');

      // The delegate writes INTO Alice's remote DWN on her behalf — the
      // grant path must keep working through the `from` dispatch branch.
      // (Uses the new public `enbox.dwn` accessor rather than a private cast.)
      const { status, record } = await enbox.dwn.records.write({
        data         : 'delegated remote note',
        from         : aliceDid.uri,
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();
      expect(record!['_remoteOrigin']).toBe(aliceDid.uri);

      // The dispatch went remote, carrying the delegated-grant parameters.
      expect(sendSpy.callCount).toBe(1);
      const sentRequest = sendSpy.firstCall.args[0];
      expect(sentRequest.target).toBe(aliceDid.uri);
      expect(sentRequest.granteeDid).toBe(delegatePortableDid.uri);
      expect((sentRequest.messageParams as { delegatedGrant?: unknown }).delegatedGrant).toBeDefined();

      // Verify on Alice's remote DWN: the record exists, the logical author
      // is Alice (the grantor), and the SIGNER is the delegate.
      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id },
      });
      expect(readResult.status.code).toBe(200);
      expect(await readResult.record!.data.text()).toBe('delegated remote note');

      const rawMessage = readResult.record!.rawMessage as DwnMessage[DwnInterface.RecordsWrite];
      expect(getRecordAuthor(rawMessage)).toBe(aliceDid.uri);
      expect(Jws.getSignerDid(rawMessage.authorization.signature.signatures[0])).toBe(delegatePortableDid.uri);
    });
  });
});
