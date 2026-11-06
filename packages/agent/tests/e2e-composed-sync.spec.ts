import type { BearerIdentity } from '../src/bearer-identity.js';
import type { PermissionGrantEntry } from '../src/types/permissions.js';
import type { ModuleDefinition, ModuleRuleSet, ModulesConfigureMessage, PermissionScope, RecordsWriteMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { WebSocketDwnRpcClient } from '@enbox/dwn-clients';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  DataStream,
  DwnConstant,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  EncryptionModule,
  Message,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { requireDwnServer } from './utils/require-dwn-server.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { createAudienceRecord, createGrantKeyRecordsForGrants, getEncryptionKeyInfo } from '../src/dwn-encryption.js';

type SavedRecord = {
  message: RecordsWriteMessage;
  cid: string;
  ciphertext: Uint8Array;
  plaintext: string;
};

/** Actual HTTP replication of a three-module graph with independent device stores. */
describe('E2E: composed encrypted module sync', () => {
  const runId = crypto.randomUUID();
  const moduleRoot = `https://example.com/e2e-composed-sync/${runId}`;
  const core: ModuleDefinition = {
    module    : `${moduleRoot}/core`,
    published : true,
    types     : { workspace: { dataFormats: ['application/json'] }, member: { dataFormats: ['application/json'] } },
    structure : { workspace: { member: { $role: true, $actions: [{ who: 'recipient', of: 'workspace/member', can: ['read'] }] } } },
  };
  const documents: ModuleDefinition = {
    module    : `${moduleRoot}/documents`,
    published : true,
    uses      : { core: core.module },
    types     : { document: { dataFormats: ['text/plain'], encryptionRequired: true } },
    structure : { workspace: {
      $ref     : 'core:workspace',
      document : { $actions: [{ role: 'core:workspace/member', can: ['create', 'read'] }] },
    } },
  };
  const comments: ModuleDefinition = {
    module    : `${moduleRoot}/comments`,
    published : true,
    uses      : { documents: documents.module, core: core.module },
    types     : { comment: { dataFormats: ['text/plain'], encryptionRequired: true } },
    structure : { document: {
      $ref    : 'documents:workspace/document',
      comment : { $actions: [{ role: 'core:workspace/member', can: ['create', 'read'] }] },
    } },
  };
  const definitions = [core, documents, comments];
  const configurations = new Map<string, ModulesConfigureMessage>();
  const harnesses: PlatformAgentTestHarness[] = [];
  let owner: PlatformAgentTestHarness;
  let replica: PlatformAgentTestHarness;
  let alice: BearerIdentity;
  let member: PlatformAgentTestHarness;
  let bob: BearerIdentity;
  let membership: RecordsWriteMessage;
  let workspace: SavedRecord;
  let document: SavedRecord;
  let comment: SavedRecord;

  beforeAll(async () => {
    await requireDwnServer();
    owner = await createDevice('owner');
    replica = await createDevice('replica');
    alice = await owner.createIdentity({ name: 'Composed sync owner', testDwnUrls: [testDwnUrl] });
    await replica.agent.identity.import({ portableIdentity: await owner.agent.identity.export({ didUri: alice.did.uri }) });
    expect(owner.agent.dwn.node).not.toBe(replica.agent.dwn.node);
    expect(owner.dwnMessageStore).not.toBe(replica.dwnMessageStore);

    for (const definition of definitions) {
      const response = await owner.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ModulesConfigure,
        messageParams : { definition },
      });
      expect(response.reply.status.code).toBe(202);
      configurations.set(definition.module, response.message!);
    }
    workspace = await write(owner, core.module, 'workspace', '{"name":"Shared workspace"}', undefined, 'application/json');
    document = await write(owner, documents.module, 'workspace/document', 'An encrypted document', workspace.message.contextId);
    comment = await write(owner, comments.module, 'document/comment',
      `An encrypted composed comment: ${'x'.repeat(DwnConstant.maxDataSizeAllowedToBeEncoded + 512)}`, document.message.contextId);
  }, 40_000);

  afterAll(async () => {
    sinon.restore();
    for (const harness of harnesses.slice().reverse()) {
      await harness.agent.sync.stopSync();
      await harness.closeStorage();
    }
  });

  afterEach(() => sinon.restore());

  async function createDevice(name: string): Promise<PlatformAgentTestHarness> {
    const harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : `__TESTDATA__/e2e-composed-sync/${runId}/${name}`,
    });
    harnesses.push(harness);
    await harness.clearStorage();
    await harness.createAgentDid();
    return harness;
  }

  async function write(
    harness: PlatformAgentTestHarness,
    module: string,
    modulePath: string,
    plaintext: string,
    parentContextId?: string,
    dataFormat = 'text/plain',
  ): Promise<SavedRecord> {
    const result = await harness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : { module, modulePath, parentContextId, dataFormat },
      dataStream    : new Blob([plaintext]),
    });
    expect(result.reply.status.code).toBe(202);
    return {
      message    : result.message!,
      cid        : result.messageCid,
      plaintext,
      ciphertext : new Uint8Array(await result.data!.arrayBuffer()),
    };
  }

  async function readRecord(
    harness: PlatformAgentTestHarness,
    recordId: string,
    remote = false,
  ): Promise<{ message: RecordsWriteMessage; ciphertext: Uint8Array }> {
    const request = {
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    } as const;
    const response = remote
      ? await harness.agent.dwn.sendRequest(request)
      : await harness.agent.dwn.processRequest(request);
    expect(response.reply.status.code).toBe(200);
    return {
      message    : response.reply.entry!.recordsWrite!,
      ciphertext : await DataStream.toBytes(response.reply.entry!.data!),
    };
  }

  async function expectRecordPreserved(harness: PlatformAgentTestHarness, saved: SavedRecord, remote = false): Promise<void> {
    const stored = await readRecord(harness, saved.message.recordId, remote);
    expect(await Message.getCid(stored.message)).toBe(saved.cid);
    expect(stored.message.contextId).toBe(saved.message.contextId);
    expect(stored.message.authorization).toEqual(saved.message.authorization);
    expect(stored.ciphertext).toEqual(saved.ciphertext);
    const plaintext = await harness.agent.dwn.decryptRecordData({
      author       : alice.did.uri,
      target       : alice.did.uri,
      recordsWrite : stored.message,
      dataStream   : DataStream.fromBytes(stored.ciphertext),
    });
    expect(new TextDecoder().decode(await DataStream.toBytes(plaintext))).toBe(saved.plaintext);
  }

  async function grant(
    issuer: PlatformAgentTestHarness,
    issuerDid: string,
    recipient: PlatformAgentTestHarness,
    recipientDid: string,
    scope: PermissionScope,
  ): Promise<PermissionGrantEntry> {
    const created = await issuer.agent.permissions.createGrant({
      author      : issuerDid,
      grantedTo   : recipientDid,
      delegated   : true,
      store       : true,
      dateExpires : '2999-01-01T00:00:00.000000Z',
      scope,
    });
    // Approval hands signed grants to their recipient. Application configs,
    // ancestors, data and encryption controls are acquired by actual sync.
    const { encodedData, ...rawMessage } = created.message;
    const imported = await recipient.agent.dwn.processRequest({
      author      : recipientDid,
      target      : recipientDid,
      messageType : DwnInterface.RecordsWrite,
      rawMessage,
      signAsOwner : true,
      dataStream  : new Blob([Encoder.base64UrlToBytes(encodedData) as BlobPart]),
    });
    expect(imported.reply.status.code).toBe(202);
    const issuerCopy = await recipient.agent.dwn.processRequest({
      author      : recipientDid,
      target      : issuerDid,
      messageType : DwnInterface.RecordsWrite,
      rawMessage,
      dataStream  : new Blob([Encoder.base64UrlToBytes(encodedData) as BlobPart]),
    });
    expect(issuerCopy.reply.status.code).toBe(202);
    return created;
  }

  async function grantSyncAccess(recipient: PlatformAgentTestHarness, recipientDid: string): Promise<void> {
    for (const definition of definitions) {
      await grant(owner, alice.did.uri, recipient, recipientDid,
        { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: definition.module });
    }
  }

  it('pushes the whole graph and restores a cold replica through the real sync engine', async () => {
    const cold = await replica.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module: comments.module } },
    });
    expect(cold.reply.entries).toHaveLength(0);
    const remoteApply = sinon.spy(owner.agent.rpc, 'applyReplicatedMessage');
    await owner.agent.sync.setIdentityOptions({ did: alice.did.uri, options: { modules: 'all' } });
    await owner.agent.sync.sync('push');
    expect(remoteApply.called).toBe(true);
    expect(remoteApply.getCalls().every(call => new URL(call.args[0].dwnUrl).origin === new URL(testDwnUrl).origin)).toBe(true);
    await expectRecordPreserved(owner, comment, true);

    const localApply = sinon.spy(replica.agent.dwn, 'applyReplicatedMessage');
    await replica.agent.sync.setIdentityOptions({ did: alice.did.uri, options: { modules: 'all' } });
    await replica.agent.sync.sync('pull');
    expect(localApply.called).toBe(true);
    for (const [module, original] of configurations) {
      const installed = await replica.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ModulesQuery,
        messageParams : { filter: { module } },
      });
      expect(installed.reply.entries).toHaveLength(1);
      expect(await Message.getCid(installed.reply.entries![0])).toBe(await Message.getCid(original));
    }
    for (const record of [workspace, document, comment]) {
      await expectRecordPreserved(replica, record);
    }
    expect(comment.message.contextId).toBe(`${workspace.message.recordId}/${document.message.recordId}/${comment.message.recordId}`);
    expect(await replica.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
    expect((await (replica.agent.sync as SyncEngineLevel).getSyncHealth()).failedMessageCount).toBe(0);
    remoteApply.restore();
    localApply.restore();
  }, 90_000);

  it('repairs missing foreign configurations, ancestors, and audience controls during a later pull', async () => {
    const audienceReply = await replica.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { module: core.module, modulePath: ENCRYPTION_CONTROL_AUDIENCE_PATH } },
    });
    expect(audienceReply.reply.entries).toHaveLength(1);
    const audience = audienceReply.reply.entries![0];
    const missing = [configurations.get(core.module)!, workspace.message, document.message, audience];
    // Model a sparse local restore while retaining the existing remote-feed checkpoints.
    // Remote data and all real admission/repair methods remain unchanged.
    for (const message of missing) {
      const cid = await Message.getCid(message);
      await replica.dwnMessageStore.delete(alice.did.uri, cid);
      expect(await replica.dwnMessageStore.get(alice.did.uri, cid)).toBeUndefined();
    }
    const appended = await write(owner, comments.module, 'document/comment', 'Pull must repair the real provider chain', document.message.contextId);
    await owner.agent.sync.sync('push');
    const apply = sinon.spy(replica.agent.dwn, 'applyReplicatedMessage');
    await replica.agent.sync.sync('pull');

    const outcomes = await Promise.all(apply.getCalls().map(call => call.returnValue)) as ReplicationApplyResult[];
    const dependencies = outcomes.flatMap(result => result.kind === 'Incomplete' ? result.missing : []);
    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'Module', module: core.module }),
      expect.objectContaining({ type: 'Parent', module: documents.module, recordId: document.message.recordId }),
      expect.objectContaining({ type: 'Ancestor', module: core.module, recordId: workspace.message.recordId }),
      expect.objectContaining({ type: 'EncryptionControl', module: core.module, modulePath: ENCRYPTION_CONTROL_AUDIENCE_PATH }),
    ]));
    for (const record of [workspace, document, appended]) {
      await expectRecordPreserved(replica, record);
    }
    expect(await replica.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
  }, 90_000);

  it('syncs shared-role delivery to a separate member and repairs that role for a member-authored write', async () => {
    member = await createDevice('member');
    bob = await member.createIdentity({ name: 'Composed sync member', testDwnUrls: [testDwnUrl] });
    const ownProvider = await member.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : bob.did.uri,
      messageType   : DwnInterface.ModulesConfigure,
      messageParams : { definition: core },
    });
    expect(ownProvider.reply.status.code).toBe(202);
    const roleKey = (ownProvider.message!.descriptor.definition.structure.workspace.member as ModuleRuleSet).$keyAgreement!.publicKeyJwk;
    const assignment = await owner.agent.dwn.processRequest({
      author                 : alice.did.uri,
      target                 : alice.did.uri,
      messageType            : DwnInterface.RecordsWrite,
      recipientRolePublicKey : roleKey,
      messageParams          : {
        module          : core.module,
        modulePath      : 'workspace/member',
        parentContextId : workspace.message.contextId,
        recipient       : bob.did.uri,
        dataFormat      : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(assignment.reply.status.code).toBe(202);
    expect(assignment.audienceKeyDelivery?.delivered).toBe(true);
    membership = assignment.message!;
    await grantSyncAccess(member, bob.did.uri);
    await owner.agent.sync.sync('push');
    await member.agent.sync.setIdentityOptions({
      did     : alice.did.uri,
      options : { delegateDid: bob.did.uri, modules: definitions.map(definition => definition.module) as [string, ...string[]] },
    });
    await member.agent.sync.sync('pull');
    expect(await member.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();

    const read = await member.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: comment.message.recordId }, moduleRole: 'core:workspace/member' },
    });
    expect(read.reply.status.code).toBe(200);
    const decoded = await member.agent.dwn.decryptRecordData({
      author       : bob.did.uri,
      target       : alice.did.uri,
      recordsWrite : read.reply.entry!.recordsWrite!,
      moduleRole   : 'core:workspace/member',
      dataStream   : read.reply.entry!.data!,
    });
    expect(new TextDecoder().decode(await DataStream.toBytes(decoded))).toBe(comment.plaintext);

    await replica.agent.sync.sync('pull');
    await replica.dwnMessageStore.delete(alice.did.uri, await Message.getCid(membership));
    const written = await member.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module          : comments.module,
        modulePath      : 'document/comment',
        parentContextId : document.message.contextId,
        moduleRole      : 'core:workspace/member',
        dataFormat      : 'text/plain',
      },
      dataStream: new Blob(['A member-authored composed write from its own local replica']),
    });
    expect(written.reply.status.code).toBe(202);
    await member.agent.sync.sync('push');
    const apply = sinon.spy(replica.agent.dwn, 'applyReplicatedMessage');
    await replica.agent.sync.sync('pull');
    const outcomes = await Promise.all(apply.getCalls().map(call => call.returnValue)) as ReplicationApplyResult[];
    expect(outcomes.flatMap(result => result.kind === 'Incomplete' ? result.missing : [])).toContainEqual({
      type          : 'Role',
      module        : core.module,
      modulePath    : 'workspace/member',
      recipient     : bob.did.uri,
      contextPrefix : workspace.message.contextId,
    });
    await expectRecordPreserved(replica, {
      message    : written.message!,
      cid        : written.messageCid,
      ciphertext : new Uint8Array(await written.data!.arrayBuffer()),
      plaintext  : 'A member-authored composed write from its own local replica',
    });
    expect(await member.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
  }, 90_000);

  it('requires approved provider scopes and syncs real grant keys before a member delegate can decrypt', async () => {
    const app = await createDevice('member-delegate');
    const carol = await app.createIdentity({ name: 'Composed sync member delegate', testDwnUrls: [testDwnUrl] });
    await grant(owner, alice.did.uri, app, carol.did.uri,
      { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: comments.module });
    const options = { delegateDid: carol.did.uri, modules: definitions.map(definition => definition.module) as [string, ...string[]] };
    await expect(app.agent.sync.setIdentityOptions({ did: alice.did.uri, options })).rejects.toThrow('lacks Messages.Read grants');
    for (const definition of [core, documents]) {
      await grant(owner, alice.did.uri, app, carol.did.uri,
        { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: definition.module });
    }
    const consumerRead = await grant(member, bob.did.uri, app, carol.did.uri,
      { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, module: comments.module });
    await owner.agent.sync.sync('push');
    await app.agent.sync.setIdentityOptions({ did: alice.did.uri, options });
    await app.agent.sync.sync('pull', { did: alice.did.uri });
    expect(await app.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();
    expect(await app.agent.did.get({ didUri: bob.did.uri })).toBeUndefined();

    const read = await app.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      granteeDid    : carol.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: comment.message.recordId }, moduleRole: 'core:workspace/member', delegatedGrant: consumerRead.message },
    });
    expect(read.reply.status.code).toBe(200);
    const ciphertext = await DataStream.toBytes(read.reply.entry!.data!);
    const decrypt = (): Promise<ReadableStream<Uint8Array>> => app.agent.dwn.decryptRecordData({
      author         : bob.did.uri,
      target         : alice.did.uri,
      granteeDid     : carol.did.uri,
      delegatedGrant : consumerRead.message,
      recordsWrite   : read.reply.entry!.recordsWrite!,
      moduleRole     : 'core:workspace/member',
      dataStream     : DataStream.fromBytes(ciphertext),
    });
    await expect(decrypt()).rejects.toMatchObject({
      name     : 'AudienceDecryptError',
      recordId : comment.message.recordId,
      module   : comments.module,
    });

    const providerRead = await grant(member, bob.did.uri, app, carol.did.uri,
      { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, module: core.module });
    await grant(member, bob.did.uri, app, carol.did.uri, { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: core.module });
    const carolKey = await getEncryptionKeyInfo(app.agent, carol.did.uri);
    const keyRecords = await createGrantKeyRecordsForGrants({
      agent                : member.agent,
      ownerDid             : bob.did.uri,
      granteeDid           : carol.did.uri,
      granteeRootPublicKey : carolKey.publicKeyJwk,
      grantMessages        : [providerRead.message],
      moduleDefinitions    : [core],
    });
    expect(keyRecords.length).toBeGreaterThan(0);
    await member.agent.sync.setIdentityOptions({ did: bob.did.uri, options: { modules: 'all' } });
    await member.agent.sync.sync('push', { did: bob.did.uri });
    await app.agent.sync.setIdentityOptions({ did: bob.did.uri, options: { delegateDid: carol.did.uri, modules: [core.module] } });
    await app.agent.sync.sync('pull', { did: bob.did.uri });
    const syncedKeys = await app.agent.dwn.processRequest({
      author        : carol.did.uri,
      target        : bob.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { module: EncryptionModule.uri, modulePath: EncryptionModule.wrappedGrantKeyPath, recipient: carol.did.uri } },
    });
    expect(syncedKeys.reply.status.code).toBe(200);
    expect(syncedKeys.reply.entries!.map(record => record.recordId)).toEqual(expect.arrayContaining(keyRecords.map(record => record.recordId)));
    app.agent.dwn.clearDelegateDecryptionKeys(carol.did.uri);
    expect(new TextDecoder().decode(await DataStream.toBytes(await decrypt()))).toBe(comment.plaintext);
    expect(await app.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();
    expect(await app.agent.did.get({ didUri: bob.did.uri })).toBeUndefined();
    expect(await app.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
    expect(await app.agent.sync.getDeadLetters(bob.did.uri)).toEqual([]);
  }, 90_000);

  it('restarts the sync engine and checkpoint store, preserving an offline write after a compatible provider update', async () => {
    await owner.agent.sync.sync('pull');
    await replica.agent.sync.sync('pull');
    const before = await (replica.agent.sync as SyncEngineLevel).getReplicationLinks(alice.did.uri);
    expect(before.length).toBeGreaterThan(0);
    const options = await replica.agent.sync.getIdentityOptions(alice.did.uri);
    const role = configurations.get(core.module)!.descriptor.definition.structure.workspace.member as ModuleRuleSet;
    const preferred = await createAudienceRecord({
      agent            : owner.agent,
      sourceDid        : alice.did.uri,
      authorDid        : alice.did.uri,
      module           : core.module,
      rolePath         : 'workspace/member',
      contextId        : workspace.message.contextId!,
      sealingPublicKey : role.$keyAgreement!.publicKeyJwk,
    });
    const upgraded: ModuleDefinition = {
      ...core,
      types     : { ...core.types, label: { dataFormats: ['text/plain'] } },
      structure : { ...core.structure, label: {} },
    };
    const configured = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ModulesConfigure,
      messageParams : { definition: upgraded },
    });
    expect(configured.reply.status.code).toBe(202);
    await owner.agent.sync.sync('push');

    // This disconnected device has neither the latest provider configure nor its
    // new preferred audience. Previously accepted, retained audience keys remain valid.
    const offline = await write(replica, comments.module, 'document/comment', 'Queued while disconnected', document.message.contextId);
    const oldAudience = offline.message.encryption!.keyEncryption.find(entry => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME)!;
    expect(oldAudience.keyId).not.toBe(preferred.payload.keyId);
    const remoteBefore = await owner.agent.dwn.sendRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: offline.message.recordId } },
    });
    expect(remoteBefore.reply.status.code).toBe(404);

    // Reopen the actual LevelDB registration/checkpoint store, without registering
    // this identity again or rebuilding the application data from a test fixture.
    const location = (replica.syncStore as Level<string, string>).location;
    await (replica.agent.sync as SyncEngineLevel).close();
    replica.syncStore = new Level(location);
    replica.agent.sync = new SyncEngineLevel({ agent: replica.agent, db: replica.syncStore });
    expect(await replica.agent.sync.getIdentityOptions(alice.did.uri)).toEqual(options);
    expect(await (replica.agent.sync as SyncEngineLevel).getReplicationLinks(alice.did.uri)).toEqual(before);
    await replica.agent.sync.sync('push');
    await owner.agent.sync.sync('pull');
    await replica.agent.sync.sync('pull');
    await expectRecordPreserved(owner, offline, true);
    await expectRecordPreserved(owner, offline);
    await expectRecordPreserved(replica, offline);
    const installed = await replica.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module: core.module } },
    });
    expect(await Message.getCid(installed.reply.entries![0])).toBe(configured.messageCid);
    expect(await replica.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
    expect(await owner.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
  }, 90_000);

  it('replicates deletion and a provider-parent prune across the composed child subtree', async () => {
    const deleted = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: comment.message.recordId },
    });
    expect(deleted.reply.status.code).toBe(202);
    await owner.agent.sync.sync('push');
    await replica.agent.sync.sync('pull');
    const deletedRead = await replica.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: comment.message.recordId } },
    });
    expect(deletedRead.reply.status.code).toBe(404);
    expect(deletedRead.reply.entry!.recordsDelete).toEqual(deleted.message);

    const pruned = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: document.message.recordId, prune: true },
    });
    expect(pruned.reply.status.code).toBe(202);
    await owner.agent.sync.sync('push');
    await replica.agent.sync.sync('pull');
    for (const harness of [owner, replica]) {
      const children = await harness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { module: comments.module, contextId: document.message.contextId } },
      });
      expect(children.reply.status.code).toBe(200);
      expect(children.reply.entries).toHaveLength(0);
      const parent = await harness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: document.message.recordId } },
      });
      expect(parent.reply.status.code).toBe(404);
      expect(parent.reply.entry!.recordsDelete).toEqual(pruned.message);
      await expectRecordPreserved(harness, workspace);
      expect(await harness.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
    }
  }, 90_000);

  it('catches up composed encrypted records after a real transport disconnect and online wake', async () => {
    const liveDocument = await write(owner, documents.module, 'workspace/document', 'Live sync parent', workspace.message.contextId);
    await owner.agent.sync.sync('push');
    await replica.agent.sync.sync('pull');
    await replica.agent.sync.startSync({ interval: '1h' });
    try {
      expect(replica.agent.sync.hasActiveSubscriptions).toBe(true);
      const first = await write(owner, comments.module, 'document/comment', 'Arrives through the live wake stream', liveDocument.message.contextId);
      await owner.agent.sync.sync('push');
      await waitForLocalRecord(first.message.recordId);
      await expectRecordPreserved(replica, first);
      const duringDisconnect = await write(owner, comments.module, 'document/comment',
        'Catches up from the durable cursor after transport recovery', liveDocument.message.contextId);

      // Drop the raw transport, not JsonRpcSocket.close(), which intentionally
      // marks a user-closed session and disables automatic reconnection.
      const pool = WebSocketDwnRpcClient as unknown as {
        connections: Map<string, { url: string; socket: { socket: WebSocket; readonly isConnected: boolean } }>;
      };
      const connections = [...pool.connections.values()].filter(connection =>
        new URL(connection.url).host === new URL(testDwnUrl).host && connection.socket.socket.readyState === WebSocket.OPEN);
      expect(connections.length).toBeGreaterThan(0);
      const sockets = connections.map(connection => connection.socket.socket);
      const resumeReconnect = parkWebSocketReconnect();
      try {
        await Promise.all(sockets.map(socket => new Promise<void>(resolve => {
          socket.addEventListener('close', () => resolve(), { once: true });
          socket.close();
        })));
        expect(connections.every(connection => !connection.socket.isConnected)).toBe(true);
        // The browser offline hint parks automatic socket reconnect regardless
        // of CI load. The independent HTTP writer still commits real ciphertext
        // while the replica has no subscription transport to receive its wake.
        const committed = await owner.agent.dwn.sendRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : duringDisconnect.message,
          dataStream  : new Blob([duringDisconnect.ciphertext as BlobPart]),
        });
        expect(committed.reply.status.code).toBe(202);
        expect(committed.messageCid).toBe(duringDisconnect.cid);
        for (const [index, connection] of connections.entries()) {
          expect(connection.socket.isConnected).toBe(false);
          expect(connection.socket.socket).toBe(sockets[index]);
          expect(sockets[index].readyState).toBe(WebSocket.CLOSED);
        }
      } finally {
        resumeReconnect();
      }
      await waitForLocalRecord(duringDisconnect.message.recordId);
      await expectRecordPreserved(replica, duringDisconnect);
      expect(connections.every((connection, index) => connection.socket.socket !== sockets[index])).toBe(true);
      expect(replica.agent.sync.hasActiveSubscriptions).toBe(true);
      expect(await replica.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
    } finally {
      await replica.agent.sync.stopSync();
    }
  }, 90_000);

  /** Exercise the existing browser-offline gate without replacing transport or admission methods. */
  function parkWebSocketReconnect(): () => void {
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
    return (): void => {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis.navigator, 'onLine');
      } else {
        Object.defineProperty(globalThis.navigator, 'onLine', original);
      }
      // Public browser-wake hook: resume actual socket reconnect and replay.
      WebSocketDwnRpcClient.checkAllConnections();
    };
  }

  async function waitForLocalRecord(recordId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await replica.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { recordId } },
      });
      expect(response.reply.status.code).toBe(200);
      if (response.reply.entries!.length === 1) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Composed sync did not deliver ${recordId} through its live subscription`);
  }
});
