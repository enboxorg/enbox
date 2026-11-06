import type { BearerDid } from '@enbox/dids';
import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { DwnMessage, DwnModuleDefinition } from '@enbox/agent';

import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { DwnConstant, Jws } from '@enbox/dwn-sdk-js';

import { createPermissionGrants, DwnInterface, EnboxUserAgent, getRecordAuthor } from '@enbox/agent';
import { processConnectedGrants, WalletConnect } from '@enbox/auth';

import photosModuleDefinition from './fixtures/module-definitions/photos.json' with { type: 'json' };

import { defineModule } from '../src/define-module.js';
import { DwnApi } from '../src/dwn-api.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { Enbox } from '../src/enbox.js';
import { recordCodecs } from '../src/record-codec.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { publishModule, publishRecord } from './utils/test-dwn-operations.js';

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
  let moduleDefinition: DwnModuleDefinition;

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

    // Give the module a random URI per test so remote-tenant state from one
    // test never leaks into the next (the shared dev DWN server persists).
    moduleDefinition = {
      ...photosModuleDefinition,
      module: `http://photo-module.xyz/${TestDataGenerator.randomString(15)}`,
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  /** Installs the module for Alice locally and on her remote DWN. */
  async function installModuleForAlice(): Promise<void> {
    const { status, module } = await dwnAlice.modules.configure({ definition: moduleDefinition });
    expect(status.code).toBe(202);
    const { status: sendStatus } = await publishModule(
      testHarness.agent,
      module!,
      aliceDid.uri,
      aliceDid.uri,
    );
    expect(sendStatus.code).toBe(202);
  }

  /** Writes a `friend` $role record for Bob on Alice's tenant and sends it to her remote DWN. */
  async function grantBobFriendRole(): Promise<void> {
    const { status, record } = await dwnAlice.records.write({
      data       : 'friend role for bob',
      recipient  : bobDid.uri,
      module     : moduleDefinition.module,
      modulePath : 'friend',
      schema     : moduleDefinition.types.friend.schema,
      dataFormat : 'text/plain',
    });
    expect(status.code).toBe(202);
    await publishRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);
  }

  describe('records.write with from', () => {
    it('should accept a role-authorized cross-tenant write', async () => {
      await installModuleForAlice();
      await grantBobFriendRole();

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      // Bob writes an album INTO Alice's remote DWN under his `friend` role.
      const { status, record, audienceKeyDelivery } = await dwnBob.records.write({
        data       : 'bob writes into alice dwn',
        from       : aliceDid.uri,
        recipient  : aliceDid.uri,
        module     : moduleDefinition.module,
        modulePath : 'album',
        moduleRole : 'friend',
        schema     : moduleDefinition.types.album.schema,
        dataFormat : 'text/plain',
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

      // The invoked role is retained for follow-up operations.
      expect(record!.moduleRole).toBe('friend');
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
      await installModuleForAlice();
      // No friend role for Bob this time.

      const { status, record } = await dwnBob.records.write({
        data       : 'unauthorized write',
        from       : aliceDid.uri,
        module     : moduleDefinition.module,
        modulePath : 'album',
        schema     : moduleDefinition.types.album.schema,
        dataFormat : 'text/plain',
      });

      // The owner's DWN rejects the write; the status surfaces, not swallowed.
      expect(status.code).toBe(401);
      expect(record).toBeUndefined();
    });

    it('should keep the from-less write on the local processing path (regression)', async () => {
      await installModuleForAlice();

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      const { status, record } = await dwnAlice.records.write({
        data       : 'local write',
        module     : moduleDefinition.module,
        modulePath : 'album',
        schema     : moduleDefinition.types.album.schema,
        dataFormat : 'text/plain',
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();
      expect(sendSpy.callCount).toBe(0);
    });

    it('should reject recipientRolePublicKey on the remote path (agent throws, surfaced)', async () => {
      await installModuleForAlice();
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
        module                 : moduleDefinition.module,
        modulePath             : 'album',
        moduleRole             : 'friend',
        schema                 : moduleDefinition.types.album.schema,
        dataFormat             : 'text/plain',
        recipientRolePublicKey : x25519PublicKey,
      })).rejects.toThrow('recipientRolePublicKey is not supported on sendRequest');
    });
  });

  describe('typed records.create with from', () => {
    it('should role-write into the owner tenant through the typed surface and wrap the result', async () => {
      await installModuleForAlice();
      await grantBobFriendRole();

      // The photos fixture types carry dataFormats: ['text/plain'], so the
      // typed payload for `album` is a plain string.
      const typedBob = new TypedEnbox(
        dwnBob,
        defineModule(moduleDefinition as ModuleDefinition, {
          album       : recordCodecs.text(),
          friend      : recordCodecs.text(),
          participant : recordCodecs.text(),
          photo       : recordCodecs.text(),
          updater     : recordCodecs.text(),
        }),
      );

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');

      // Typed create auto-configures the module on Bob's LOCAL tenant, then
      // dispatches the record write to Alice's REMOTE tenant.
      const record = await typedBob.records.create('album', {
        data       : 'bob types into alice dwn',
        from       : aliceDid.uri,
        recipient  : aliceDid.uri,
        moduleRole : 'friend',
      });

      // The record WRITE went remote; the auto-configure stayed local.
      const remoteWrites = sendSpy.getCalls().filter((call) => call.args[0].messageType === DwnInterface.RecordsWrite);
      expect(remoteWrites).toHaveLength(1);
      expect(remoteWrites[0].args[0].target).toBe(aliceDid.uri);

      // The typed API returns the canonical record with its invoked role intact.
      expect(record.moduleRole).toBe('friend');

      // The record landed on Alice's remote DWN with the typed payload.
      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record.id },
      });
      expect(readResult.status.code).toBe(200);
      expect(await readResult.record!.data.text()).toBe('bob types into alice dwn');
    });
  });

  describe('Record.update with from', () => {
    it('should dispatch a role-authorized cross-tenant update remotely', async () => {
      await installModuleForAlice();
      await grantBobFriendRole();

      // Bob creates the album cross-tenant, then co-updates it cross-tenant
      // under the same role (photos module: friend can create + update).
      const { status: createStatus, record } = await dwnBob.records.write({
        data       : 'v1',
        from       : aliceDid.uri,
        recipient  : aliceDid.uri,
        module     : moduleDefinition.module,
        modulePath : 'album',
        moduleRole : 'friend',
        schema     : moduleDefinition.types.album.schema,
        dataFormat : 'text/plain',
      });
      expect(createStatus.code).toBe(202);

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const updatedRecord = await record!.update({
        data : 'v2',
        from : aliceDid.uri,
      });

      expect(updatedRecord).toBe(record);
      expect(sendSpy.callCount).toBe(1);
      expect(processSpy.callCount).toBe(0);
      expect(sendSpy.firstCall.args[0].target).toBe(aliceDid.uri);

      // The update landed on Alice's remote DWN.
      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id },
      });
      expect(readResult.status.code).toBe(200);
      expect(await readResult.record!.data.text()).toBe('v2');
    });

    it('should update locally when a remotely read record is updated without from (regression)', async () => {
      await installModuleForAlice();

      // Alice writes locally, sends to her remote, then reads it back FROM the
      // remote — producing a record with remote data access.
      const { status: writeStatus, record } = await dwnAlice.records.write({
        data       : 'local v1',
        module     : moduleDefinition.module,
        modulePath : 'album',
        schema     : moduleDefinition.types.album.schema,
        dataFormat : 'text/plain',
      });
      expect(writeStatus.code).toBe(202);
      await publishRecord(testHarness.agent, record!, aliceDid.uri, aliceDid.uri);

      const readResult = await dwnAlice.records.read({
        from   : aliceDid.uri,
        filter : { recordId: record!.id },
      });
      expect(readResult.status.code).toBe(200);
      const remoteRecord = readResult.record!;

      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      // No `from` — the update must stay local despite the remote read.
      const updatedRecord = await remoteRecord.update({ data: 'local v2' });

      expect(updatedRecord).toBe(remoteRecord);
      expect(sendSpy.callCount).toBe(0);
      expect(processSpy.callCount).toBe(1);
      expect(processSpy.firstCall.args[0].target).toBe(aliceDid.uri);
    });

    it('should re-derive the author and re-home data access on both references after a co-update', async () => {
      // A co-update-friendly module: anyone may create/read/update/co-update.
      const coUpdateModule: DwnModuleDefinition = {
        published : true,
        module    : `http://co-update-module.xyz/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema      : 'http://co-update-module.xyz/schema/note',
            dataFormats : ['text/plain'],
          },
        },
        structure: {
          note: {
            $actions: [{ who: 'anyone', can: ['create', 'read', 'update', 'co-update'] }],
          },
        },
      };
      const { status: aliceConfig, module } = await dwnAlice.modules.configure({ definition: coUpdateModule });
      expect(aliceConfig.code).toBe(202);
      const { status: aliceModuleSend } = await publishModule(
        testHarness.agent,
        module!,
        aliceDid.uri,
        aliceDid.uri,
      );
      expect(aliceModuleSend.code).toBe(202);
      const { status: bobConfig } = await dwnBob.modules.configure({ definition: coUpdateModule });
      expect(bobConfig.code).toBe(202);

      // Data too large to inline in query results, so later reads are LAZY —
      // which DWN they target is exactly what this test pins down.
      const largeData = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1000);

      // Alice authors the note and sends it to her remote DWN.
      const { status: writeStatus, record: alicesRecord } = await dwnAlice.records.write({
        data       : largeData,
        module     : coUpdateModule.module,
        modulePath : 'note',
        schema     : coUpdateModule.types.note.schema,
        dataFormat : 'text/plain',
      });
      expect(writeStatus.code).toBe(202);
      await publishRecord(testHarness.agent, alicesRecord!, aliceDid.uri, aliceDid.uri);

      // Bob reads it from Alice's remote and stores a local copy, then
      // re-queries locally so the new reference captures local data access.
      const bobRead = await dwnBob.records.read({
        from   : aliceDid.uri,
        filter : { recordId: alicesRecord!.id },
      });
      expect(bobRead.status.code).toBe(200);
      const imported = await testHarness.agent.processDwnRequest({
        author      : bobDid.uri,
        dataStream  : await bobRead.record!.data.stream(),
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : bobRead.record!.rawMessage as DwnMessage[DwnInterface.RecordsWrite],
        store       : true,
        target      : bobDid.uri,
      });
      expect(imported.reply.status.code).toBe(202);

      const bobLocalQuery = await dwnBob.records.query({ filter: { recordId: alicesRecord!.id } });
      expect(bobLocalQuery.status.code).toBe(200);
      const localRecord = bobLocalQuery.records[0];
      expect(localRecord.author).toBe(aliceDid.uri);

      // Bob co-updates the ALICE-authored record cross-tenant (tags-only, so
      // no fresh data blob masks the lazy read below).
      const updatedRecord = await localRecord.update({
        from : aliceDid.uri,
        tags : { rev: 'v2' },
      });
      expect(updatedRecord).toBe(localRecord);

      // The author is re-derived from the NEWLY SIGNED message on BOTH the
      // returned record and the in-place-mutated original — old and new
      // authors differ, and neither reference may keep reporting Alice.
      expect(updatedRecord.author).toBe(bobDid.uri);
      expect(localRecord.author).toBe(bobDid.uri);

      // Both references now target the owner tenant for lazy data reads.
      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      expect(await localRecord.data.text()).toBe(largeData);
      expect(await updatedRecord.data.text()).toBe(largeData);

      const remoteReads = sendSpy.getCalls().filter((call) => call.args[0].messageType === DwnInterface.RecordsRead);
      const localReads = processSpy.getCalls().filter((call) => call.args[0].messageType === DwnInterface.RecordsRead);
      expect(remoteReads).toHaveLength(2);
      expect(remoteReads.every((call) => call.args[0].target === aliceDid.uri)).toBe(true);
      expect(localReads).toHaveLength(0);
    });
  });

  describe('delegated remote access', () => {
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

    async function createDelegatedEnbox(
      definition: DwnModuleDefinition,
      permissions: Array<'delete' | 'read' | 'write'>,
    ): Promise<{ delegateDid: string; enbox: Enbox }> {
      const delegatedBearerDid = await testHarness.agent.did.create({ store: false, method: 'jwk' });
      const delegatePortableDid = await delegatedBearerDid.export();
      const grantRequest = WalletConnect.createPermissionRequestForModule({ definition, permissions });
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

      return {
        delegateDid : delegatePortableDid.uri,
        enbox       : new Enbox({
          agent        : delegateHarness.agent,
          connectedDid : aliceDid.uri,
          delegateDid  : delegatePortableDid.uri,
        }),
      };
    }

    it('should dispatch a delegated-grant write to the owner\'s remote DWN', async () => {
      // Alice installs a simple notes module locally and on her remote DWN.
      const notesModule: DwnModuleDefinition = {
        published : true,
        module    : `http://notes-module.xyz/module/${TestDataGenerator.randomString(15)}`,
        types     : {
          note: {
            schema      : 'https://notes-module.xyz/schema/note',
            dataFormats : ['text/plain'],
          },
        },
        structure: {
          note: {},
        },
      };
      const { status: configStatus, module } = await dwnAlice.modules.configure({ definition: notesModule });
      expect(configStatus.code).toBe(202);
      const { status: moduleSendStatus } = await publishModule(
        testHarness.agent,
        module!,
        aliceDid.uri,
        aliceDid.uri,
      );
      expect(moduleSendStatus.code).toBe(202);

      // Alice grants a device did:jwk delegated write/read for the module;
      // the DELEGATE agent (separate harness, no Alice keys) imports it.
      const { delegateDid, enbox } = await createDelegatedEnbox(notesModule, ['write', 'read']);

      const sendSpy = sinon.spy(delegateHarness.agent, 'sendDwnRequest');

      // The delegate writes INTO Alice's remote DWN on her behalf — the
      // grant path must keep working through the `from` dispatch branch.
      // (Uses the new public `enbox.dwn` accessor rather than a private cast.)
      const { status, record } = await enbox.dwn.records.write({
        data       : 'delegated remote note',
        from       : aliceDid.uri,
        module     : notesModule.module,
        modulePath : 'note',
        schema     : notesModule.types.note.schema,
        dataFormat : 'text/plain',
      });

      expect(status.code).toBe(202);
      expect(record).toBeDefined();

      // The dispatch went remote, carrying the delegated-grant parameters.
      expect(sendSpy.callCount).toBe(1);
      const sentRequest = sendSpy.firstCall.args[0];
      expect(sentRequest.target).toBe(aliceDid.uri);
      expect(sentRequest.granteeDid).toBe(delegateDid);
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
      expect(Jws.getSignerDid(rawMessage.authorization.signature.signatures[0])).toBe(delegateDid);
    });

    it('should enforce and retain a nested role for typed remote reads and deletes', async () => {
      const roleModule: DwnModuleDefinition = {
        published : true,
        module    : `http://role-access.xyz/module/${TestDataGenerator.randomString(15)}`,
        types     : {
          thread: {
            schema      : 'https://role-access.xyz/schema/thread',
            dataFormats : ['text/plain'],
          },
          participant: {
            schema      : 'https://role-access.xyz/schema/participant',
            dataFormats : ['text/plain'],
          },
          auditor: {
            schema      : 'https://role-access.xyz/schema/auditor',
            dataFormats : ['text/plain'],
          },
          session: {
            schema      : 'https://role-access.xyz/schema/session',
            dataFormats : ['text/plain'],
          },
        },
        structure: {
          thread: {
            participant : { $role: true },
            auditor     : { $role: true },
            session     : {
              $actions: [
                { role: 'thread/participant', can: ['read', 'co-delete'] },
                { role: 'thread/auditor', can: ['read', 'co-delete'] },
              ],
            },
          },
        },
      };

      for (const ownerDwn of [dwnAlice, dwnBob]) {
        const { status, module } = await ownerDwn.modules.configure({ definition: roleModule });
        expect(status.code).toBe(202);
        const { status: sendStatus } = await publishModule(
          testHarness.agent,
          module!,
          ownerDwn.connectedDid,
          ownerDwn.connectedDid,
        );
        expect(sendStatus.code).toBe(202);
      }

      const { status: threadStatus, record: thread } = await dwnBob.records.write({
        data       : 'thread',
        module     : roleModule.module,
        modulePath : 'thread',
        schema     : roleModule.types.thread.schema,
        dataFormat : 'text/plain',
      });
      expect(threadStatus.code).toBe(202);
      await publishRecord(testHarness.agent, thread!, bobDid.uri, bobDid.uri);

      const { status: participantStatus, record: participant } = await dwnBob.records.write({
        data            : 'participant',
        parentContextId : thread!.contextId,
        recipient       : aliceDid.uri,
        module          : roleModule.module,
        modulePath      : 'thread/participant',
        schema          : roleModule.types.participant.schema,
        dataFormat      : 'text/plain',
      });
      expect(participantStatus.code).toBe(202);
      await publishRecord(testHarness.agent, participant!, bobDid.uri, bobDid.uri);

      const sessionData = TestDataGenerator.randomString(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
      const { status: sessionStatus, record: session } = await dwnBob.records.write({
        data            : sessionData,
        parentContextId : thread!.contextId,
        module          : roleModule.module,
        modulePath      : 'thread/session',
        schema          : roleModule.types.session.schema,
        dataFormat      : 'text/plain',
      });
      expect(sessionStatus.code).toBe(202);
      await publishRecord(testHarness.agent, session!, bobDid.uri, bobDid.uri);

      const { enbox } = await createDelegatedEnbox(roleModule, ['read', 'delete']);
      const typed = new TypedEnbox(
        enbox.dwn,
        defineModule(roleModule, {
          thread      : recordCodecs.text(),
          participant : recordCodecs.text(),
          auditor     : recordCodecs.text(),
          session     : recordCodecs.text(),
        }),
      );
      const readRequest = {
        from   : bobDid.uri,
        filter : { recordId: session!.id },
        within : thread!.contextId,
      };

      await expect(typed.records.read('thread/session', readRequest)).rejects.toBeInstanceOf(DwnResponseError);
      await expect(typed.records.read('thread/session', {
        ...readRequest,
        moduleRole: 'thread/auditor',
      })).rejects.toBeInstanceOf(DwnResponseError);

      const sendSpy = sinon.spy(delegateHarness.agent, 'sendDwnRequest');
      const remoteRecord = await typed.records.read('thread/session', {
        ...readRequest,
        moduleRole: 'thread/participant',
      });
      expect(remoteRecord?.moduleRole).toBe('thread/participant');
      expect(await remoteRecord!.value()).toBe(sessionData);
      expect(await remoteRecord!.value()).toBe(sessionData);

      const roleReads = sendSpy.getCalls().filter((call) =>
        call.args[0].messageType === DwnInterface.RecordsRead
        && call.args[0].target === bobDid.uri
      );
      expect(roleReads).toHaveLength(2);
      expect(roleReads.every((call) =>
        call.args[0].messageParams.moduleRole === 'thread/participant'
      )).toBe(true);

      const deleteRequest = {
        from     : bobDid.uri,
        recordId : session!.id,
        within   : thread!.contextId,
      };
      await expect(typed.records.delete('thread/session', deleteRequest)).rejects.toBeInstanceOf(DwnResponseError);
      await expect(typed.records.delete('thread/session', {
        ...deleteRequest,
        moduleRole: 'thread/auditor',
      })).rejects.toBeInstanceOf(DwnResponseError);

      const retained = await dwnBob.records.read({
        from   : bobDid.uri,
        filter : { recordId: session!.id },
      });
      expect(retained.status.code).toBe(200);

      await typed.records.delete('thread/session', {
        ...deleteRequest,
        moduleRole: 'thread/participant',
      });

      const deleted = await dwnBob.records.read({
        from   : bobDid.uri,
        filter : { recordId: session!.id },
      });
      expect(deleted.status.code).toBe(404);
    });
  });
});
