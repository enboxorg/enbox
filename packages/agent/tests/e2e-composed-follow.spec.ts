import type { BearerIdentity } from '../src/bearer-identity.js';
import type { FollowedSyncSource } from '../src/followed-sync-source.js';
import type { PermissionGrantEntry } from '../src/types/permissions.js';
import type { ModuleDefinition, ModuleRuleSet, PermissionScope, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { waitFor as pollUntil } from './utils/wait-for.js';
import { requireDwnServer } from './utils/require-dwn-server.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { createGrantKeyRecordsForGrants, getEncryptionKeyInfo } from '../src/dwn-encryption.js';

describe('E2E: one managed root with a composed consumer feed', () => {
  const runId = crypto.randomUUID();
  const notebook: ModuleDefinition = {
    module    : `https://example.com/composed-follow/${runId}/notebook`,
    published : true,
    types     : {
      page   : { dataFormats: ['application/json'], encryptionRequired: true },
      member : { dataFormats: ['application/json'] },
      viewer : { dataFormats: ['application/json'] },
    },
    structure: { page: {
      $actions : [{ role: 'page/member', can: ['read'] }, { role: 'page/viewer', can: ['read'] }],
      viewer   : { $role: true, $actions: [{ who: 'recipient', of: 'page/viewer', can: ['read'] }] },
      member   : { $role: true, $actions: [{ who: 'recipient', of: 'page/member', can: ['read'] }] },
    } },
  };
  const realtime: ModuleDefinition = {
    module    : `https://example.com/composed-follow/${runId}/realtime`,
    published : true,
    uses      : { notebook: notebook.module },
    types     : { live: { dataFormats: ['text/plain'], encryptionRequired: true } },
    structure : { page: {
      $ref : 'notebook:page',
      live : { $actions: [{ role: 'notebook:page/member', can: ['read'] }, { role: 'notebook:page/viewer', can: ['read'] }] },
    } },
  };
  const privateRealtime: ModuleDefinition = { ...realtime, module: `${realtime.module}-private`, published: false };
  let owner: PlatformAgentTestHarness;
  let member: PlatformAgentTestHarness;
  let alice: BearerIdentity;
  let bob: BearerIdentity;
  let page: RecordsWriteMessage;
  let accepted: FollowedSyncSource;
  let selected: FollowedSyncSource;
  let realtimeRecord: RecordsWriteMessage;
  let membership: RecordsWriteMessage;
  let ownNotebookDefinition: ModuleDefinition;
  let delegate: PlatformAgentTestHarness | undefined;

  beforeAll(async () => {
    await requireDwnServer();
    owner = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : `__TESTDATA__/e2e-composed-follow/${runId}/owner`,
    });
    member = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : `__TESTDATA__/e2e-composed-follow/${runId}/member`,
    });
    await owner.clearStorage();
    await member.clearStorage();
    await owner.createAgentDid();
    await member.createAgentDid();
    alice = await owner.createIdentity({ name: 'Composed follow owner', testDwnUrls: [testDwnUrl] });
    bob = await member.createIdentity({ name: 'Composed follow member', testDwnUrls: [testDwnUrl] });
    for (const definition of [notebook, realtime, privateRealtime]) {
      const configured = await owner.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ModulesConfigure,
        messageParams : { definition },
      });
      expect(configured.reply.status.code).toBe(202);
    }
    const ownNotebook = await member.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : bob.did.uri,
      messageType   : DwnInterface.ModulesConfigure,
      messageParams : { definition: notebook },
    });
    expect(ownNotebook.reply.status.code).toBe(202);
    ownNotebookDefinition = ownNotebook.message!.descriptor.definition;
    const created = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: notebook.module, modulePath: 'page', dataFormat: 'application/json' },
      dataStream    : new Blob(['{"title":"Shared root"}']),
    });
    expect(created.reply.status.code).toBe(202);
    page = created.message!;
    const roleKey = (ownNotebook.message!.descriptor.definition.structure.page.member as ModuleRuleSet).$keyAgreement!.publicKeyJwk;
    const assignment = await owner.agent.dwn.processRequest({
      author                 : alice.did.uri,
      target                 : alice.did.uri,
      messageType            : DwnInterface.RecordsWrite,
      recipientRolePublicKey : roleKey,
      messageParams          : {
        module          : notebook.module,
        modulePath      : 'page/member',
        recipient       : bob.did.uri,
        parentContextId : page.contextId,
        dataFormat      : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(assignment.reply.status.code).toBe(202);
    membership = assignment.message!;
    expect(assignment.audienceKeyDelivery?.delivered).toBe(true);
    await owner.agent.sync.setIdentityOptions({ did: alice.did.uri, options: { modules: 'all' } });
    await owner.agent.sync.sync('push');
    await member.agent.sync.setIdentityOptions({ did: bob.did.uri, options: { modules: 'all' } });
  }, 60_000);

  afterAll(async () => {
    sinon.restore();
    await delegate?.agent.sync.stopSync();
    await delegate?.closeStorage();
    await member?.agent.sync.stopSync();
    await owner?.agent.sync.stopSync();
    await member?.closeStorage();
    await owner?.closeStorage();
  });

  it('accepts the root independently and verifies an empty consumer through its actual role-authorized feed', async () => {
    accepted = await member.agent.sync.followSource({
      actorDid    : bob.did.uri,
      sourceDid   : alice.did.uri,
      rootModule  : notebook.module,
      contextPath : 'page',
      contextId   : page.contextId!,
      roles       : ['page/member'],
      modules     : [realtime.module],
    });
    expect(accepted.modules[realtime.module]).toBeNull();
    expect(Object.keys(accepted.modules).sort()).toEqual([notebook.module, realtime.module].sort());
    expect(await member.agent.sync.pullFollowedSource(accepted, accepted.rootModule)).toBe(true);
    selected = await member.agent.sync.ensureFollowedSourceModules(accepted, [realtime.module]);
    expect(selected.id).toBe(accepted.id);
    expect(selected.acceptanceId).toBe(accepted.acceptanceId);
    expect(selected.modules[realtime.module]).toEqual({
      contextPath: 'page', moduleRole: 'notebook:page/member', modulePaths: ['page/live'],
    });
    expect(await member.agent.sync.pullFollowedSource(selected, realtime.module)).toBe(true);
    expect(await member.agent.sync.listFollowedSources()).toHaveLength(1);
    const links = await (member.agent.sync as SyncEngineLevel).getReplicationLinks(alice.did.uri);
    expect(links).toHaveLength(2);
    expect(links.map(link => link.scope.kind === 'context' && link.scope.module).sort()).toEqual([notebook.module, realtime.module].sort());
    expect(links.map(link => link.followedSourceId)).toEqual([accepted.id, accepted.id]);
    expect(await member.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();
    await member.agent.sync.startSync({ interval: '1h' });
  }, 60_000);

  it('pulls and decrypts later consumer ciphertext using the shared foreign role without copying owner keys', async () => {
    const written = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: realtime.module, modulePath: 'page/live', parentContextId: page.contextId, dataFormat: 'text/plain' },
      dataStream    : new Blob(['Encrypted realtime advert']),
    });
    expect(written.reply.status.code).toBe(202);
    realtimeRecord = written.message!;
    await owner.agent.sync.sync('push');
    await waitFor(async () => {
      const response = await member.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { module: realtime.module, modulePath: 'page/live', contextId: page.contextId }, moduleRole: 'notebook:page/member' },
      });
      return response.reply.status.code === 200 && response.reply.entries?.some(record => record.recordId === realtimeRecord.recordId) === true;
    });
    const read = await member.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: written.message!.recordId }, moduleRole: 'notebook:page/member' },
    });
    expect(read.reply.status.code).toBe(200);
    expect(await Message.getCid(read.reply.entry!.recordsWrite!)).toBe(written.messageCid);
    const ciphertext = await DataStream.toBytes(read.reply.entry!.data!);
    expect(ciphertext).toEqual(new Uint8Array(await written.data!.arrayBuffer()));
    const plaintext = await member.agent.dwn.decryptRecordData({
      author       : bob.did.uri,
      target       : alice.did.uri,
      moduleRole   : 'notebook:page/member',
      recordsWrite : read.reply.entry!.recordsWrite!,
      dataStream   : DataStream.fromBytes(ciphertext),
    });
    expect(new TextDecoder().decode(await DataStream.toBytes(plaintext))).toBe('Encrypted realtime advert');
    expect(await member.agent.sync.getDeadLetters(alice.did.uri)).toEqual([]);
  }, 60_000);

  it('reconstructs a consumer graph from admitted local metadata after a sync-engine restart without owner network access', async () => {
    const location = (member.syncStore as Level<string, string>).location;
    await (member.agent.sync as SyncEngineLevel).close();
    member.syncStore = new Level(location);
    member.agent.sync = new SyncEngineLevel({ agent: member.agent, db: member.syncStore });
    const remote = sinon.stub(member.agent.dwn, 'sendRequest').rejects(new Error('Owner is offline'));
    const rpc = sinon.spy(member.agent.rpc, 'sendDwnRequest');
    try {
      const graph = await member.agent.sync.resolveFollowedSourceModuleGraph(selected, realtime.module);
      expect(graph.rootModuleUri).toBe(realtime.module);
      expect(graph.nodesByDeclaredPath.get('page/live')?.expectedParent).toEqual({
        owningModuleUri  : notebook.module,
        owningModulePath : 'page',
      });
      expect(remote.notCalled).toBe(true);
      expect(rpc.notCalled).toBe(true);
      expect((await member.agent.sync.getFollowedSource(selected.id))?.acceptanceId).toBe(accepted.acceptanceId);
    } finally {
      remote.restore();
      rpc.restore();
    }
    await member.agent.sync.startSync({ interval: '1h' });
  }, 60_000);

  it('requires approved consumer feed and record scopes for a genuine member delegate', async () => {
    delegate = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : `__TESTDATA__/e2e-composed-follow/${runId}/delegate`,
    });
    await delegate.clearStorage();
    await delegate.createAgentDid();
    const carol = await delegate.createIdentity({ name: 'Member app delegate', testDwnUrls: [testDwnUrl] });
    const providerRead = await grantToDelegate(carol.did.uri,
      { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, module: notebook.module });
    await grantToDelegate(carol.did.uri, { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: notebook.module });
    const carolKey = await getEncryptionKeyInfo(delegate.agent, carol.did.uri);
    await createGrantKeyRecordsForGrants({
      agent                : member.agent,
      ownerDid             : bob.did.uri,
      granteeDid           : carol.did.uri,
      granteeRootPublicKey : carolKey.publicKeyJwk,
      grantMessages        : [providerRead.message],
      moduleDefinitions    : [notebook],
    });
    await member.agent.sync.sync('push', { did: bob.did.uri });
    await delegate.agent.sync.setIdentityOptions({ did: bob.did.uri, options: { delegateDid: carol.did.uri, modules: [notebook.module] } });
    await delegate.agent.sync.sync('pull', { did: bob.did.uri });
    const source = await delegate.agent.sync.followSource({
      actorDid    : bob.did.uri,
      sourceDid   : alice.did.uri,
      rootModule  : notebook.module,
      contextPath : 'page', modules     : [],
      contextId   : page.contextId!,
      roles       : ['page/member'],
    });
    let consumer = await delegate.agent.sync.ensureFollowedSourceModules(source, [realtime.module]);
    expect(consumer.modules[realtime.module]).toBeNull();
    expect(await delegate.agent.sync.pullFollowedSource(source, source.rootModule)).toBe(true);

    const consumerFeed = await grantToDelegate(carol.did.uri,
      { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, module: realtime.module });
    consumer = await delegate.agent.sync.ensureFollowedSourceModules(source, [realtime.module]);
    expect(consumer.modules[realtime.module]).toBeNull();
    expect(await delegate.agent.sync.pullFollowedSource(source, source.rootModule)).toBe(true);

    const consumerRead = await grantToDelegate(carol.did.uri,
      { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, module: realtime.module });
    const requests = sinon.spy(delegate.agent.rpc, 'sendDwnRequest');
    consumer = await delegate.agent.sync.ensureFollowedSourceModules(source, [realtime.module]);
    expect(consumer.modules[realtime.module]).not.toBeNull();
    expect(consumer.acceptanceId).toBe(source.acceptanceId);
    expect(await delegate.agent.sync.pullFollowedSource(consumer, realtime.module)).toBe(true);
    const consumerRequests = requests.getCalls().map(call => call.args[0].message).filter(message => {
      const descriptor = message.descriptor as { filters?: Array<{ module?: string }>; filter?: { module?: string } };
      return descriptor.filter?.module === realtime.module || descriptor.filters?.some(filter => filter.module === realtime.module);
    });
    expect(consumerRequests.length).toBeGreaterThan(0);
    const grantIds = consumerRequests.flatMap(message => {
      const embedded = message.authorization?.authorDelegatedGrant;
      return embedded === undefined ? [] : [embedded.recordId];
    });
    expect(grantIds).toContain(consumerFeed.message.recordId);
    expect(grantIds).not.toContain(providerRead.message.recordId);
    requests.restore();
    const response = await delegate.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      granteeDid    : carol.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: realtimeRecord.recordId }, moduleRole: 'notebook:page/member', delegatedGrant: consumerRead.message },
    });
    expect(response.reply.status.code).toBe(200);
    const plaintext = await delegate.agent.dwn.decryptRecordData({
      author         : bob.did.uri,
      target         : alice.did.uri,
      granteeDid     : carol.did.uri,
      delegatedGrant : consumerRead.message,
      moduleRole     : 'notebook:page/member',
      recordsWrite   : response.reply.entry!.recordsWrite!,
      dataStream     : response.reply.entry!.data!,
    });
    expect(new TextDecoder().decode(await DataStream.toBytes(plaintext))).toBe('Encrypted realtime advert');
    expect(await delegate.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();
    expect(await delegate.agent.did.get({ didUri: bob.did.uri })).toBeUndefined();
    expect((await delegate.agent.sync.getIdentityOptions(bob.did.uri))?.modules).toEqual([notebook.module]);
    await delegate.agent.sync.deleteFollowedSource(source);
  }, 90_000);

  it('retains a private consumer selection as unavailable while the accepted root remains refreshable', async () => {
    selected = await member.agent.sync.ensureFollowedSourceModules(selected, [privateRealtime.module]);
    expect(Object.keys(selected.modules).sort()).toEqual([notebook.module, privateRealtime.module, realtime.module].sort());
    expect(selected.modules[privateRealtime.module]).toBeNull();
    expect(selected.modules[realtime.module]).not.toBeNull();
    expect(selected.acceptanceId).toBe(accepted.acceptanceId);
    expect(await member.agent.sync.pullFollowedSource(selected, privateRealtime.module)).toBe(false);
    expect(await member.agent.sync.pullFollowedSource(accepted, accepted.rootModule)).toBe(true);
  }, 60_000);

  it('retires every module link through the original root acceptance', async () => {
    await member.agent.sync.deleteFollowedSource(accepted);
    expect(await member.agent.sync.listFollowedSources()).toEqual([]);
    expect(await (member.agent.sync as SyncEngineLevel).getReplicationLinks(alice.did.uri)).toEqual([]);
    expect(await member.agent.sync.pullFollowedSource(selected, realtime.module)).toBe(false);
  }, 60_000);

  it('rebinds every consumer after a root role downgrade and retires them after role deletion', async () => {
    const refollowed = await member.agent.sync.followSource({
      actorDid    : bob.did.uri,
      sourceDid   : alice.did.uri,
      rootModule  : notebook.module,
      contextPath : 'page',
      contextId   : page.contextId!,
      roles       : ['page/member', 'page/viewer'],
      modules     : [realtime.module],
    });
    const previous = await member.agent.sync.ensureFollowedSourceModules(refollowed, [realtime.module]);
    expect(previous.acceptanceId).not.toBe(accepted.acceptanceId);
    expect(await member.agent.sync.pullFollowedSource(selected, realtime.module)).toBe(false);
    await member.agent.sync.startSync({ interval: '1s' });
    const removedMember = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: membership.recordId },
    });
    expect(removedMember.reply.status.code).toBe(202);
    const viewerKey = (ownNotebookDefinition.structure.page.viewer as ModuleRuleSet).$keyAgreement!.publicKeyJwk;
    const assignedViewer = await owner.agent.dwn.processRequest({
      author                 : alice.did.uri,
      target                 : alice.did.uri,
      messageType            : DwnInterface.RecordsWrite,
      recipientRolePublicKey : viewerKey,
      messageParams          : {
        module          : notebook.module,
        modulePath      : 'page/viewer',
        recipient       : bob.did.uri,
        parentContextId : page.contextId,
        dataFormat      : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(assignedViewer.reply.status.code).toBe(202);
    expect(assignedViewer.audienceKeyDelivery?.delivered).toBe(true);
    await owner.agent.sync.sync('push');
    await waitFor(async () => (await member.agent.sync.listFollowedSources()).some(source =>
      source.modules[source.rootModule]!.moduleRole === 'page/viewer' && source.modules[realtime.module]?.moduleRole === 'notebook:page/viewer'));
    const downgraded = (await member.agent.sync.listFollowedSources())[0];
    expect(downgraded.id).toBe(assignedViewer.message!.recordId);
    expect(downgraded.acceptanceId).not.toBe(previous.acceptanceId);
    expect(await member.agent.sync.pullFollowedSource(previous, realtime.module)).toBe(false);
    await expect(member.agent.sync.resolveFollowedSourceModuleGraph(previous, realtime.module)).rejects.toThrow();
    expect(await member.agent.sync.pullFollowedSource(downgraded, downgraded.rootModule)).toBe(true);
    expect(await member.agent.sync.pullFollowedSource(downgraded, realtime.module)).toBe(true);

    const removedViewer = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: assignedViewer.message!.recordId },
    });
    expect(removedViewer.reply.status.code).toBe(202);
    await owner.agent.sync.sync('push');
    await waitFor(async () => (await member.agent.sync.listFollowedSources()).length === 0);
    expect(await (member.agent.sync as SyncEngineLevel).getReplicationLinks(alice.did.uri)).toEqual([]);
    expect(await member.agent.sync.pullFollowedSource(downgraded, realtime.module)).toBe(false);
  }, 90_000);

  it('resolves admitted private-provider metadata locally without claiming private-provider decryption support', async () => {
    const privateNotebook: ModuleDefinition = { ...notebook, module: `${notebook.module}-private`, published: false };
    const publicConsumer: ModuleDefinition = {
      ...realtime,
      module : `${realtime.module}-private-root`,
      uses   : { notebook: privateNotebook.module },
    };
    for (const definition of [privateNotebook, publicConsumer]) {
      const response = await owner.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ModulesConfigure,
        messageParams : { definition },
      });
      expect(response.reply.status.code).toBe(202);
    }
    const recipient = await member.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : bob.did.uri,
      messageType   : DwnInterface.ModulesConfigure,
      messageParams : { definition: privateNotebook },
    });
    expect(recipient.reply.status.code).toBe(202);
    const created = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : { module: privateNotebook.module, modulePath: 'page', dataFormat: 'application/json' },
      dataStream    : new Blob(['{"title":"Private provider metadata"}']),
    });
    expect(created.reply.status.code).toBe(202);
    const recipientRolePublicKey = (recipient.message!.descriptor.definition.structure.page.member as ModuleRuleSet).$keyAgreement!.publicKeyJwk;
    const granted = await owner.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      recipientRolePublicKey,
      messageParams : {
        module          : privateNotebook.module,
        modulePath      : 'page/member',
        parentContextId : created.message!.contextId,
        recipient       : bob.did.uri,
        dataFormat      : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(granted.reply.status.code).toBe(202);
    expect(granted.audienceKeyDelivery?.delivered).toBe(true);
    await owner.agent.sync.sync('push');
    const privateRoot = await member.agent.sync.followSource({
      actorDid    : bob.did.uri,
      sourceDid   : alice.did.uri,
      rootModule  : privateNotebook.module,
      contextPath : 'page', modules     : [],
      contextId   : created.message!.contextId!,
      roles       : ['page/member'],
    });
    const privateProjection = await member.agent.sync.ensureFollowedSourceModules(privateRoot, [publicConsumer.module]);
    expect(privateProjection.modules[publicConsumer.module]).not.toBeNull();
    const location = (member.syncStore as Level<string, string>).location;
    await (member.agent.sync as SyncEngineLevel).close();
    member.syncStore = new Level(location);
    member.agent.sync = new SyncEngineLevel({ agent: member.agent, db: member.syncStore });
    const remote = sinon.stub(member.agent.dwn, 'sendRequest').rejects(new Error('Owner is offline'));
    const requests = sinon.spy(member.agent.dwn, 'processRequest');
    try {
      const graph = await member.agent.sync.resolveFollowedSourceModuleGraph(privateProjection, publicConsumer.module);
      expect(graph.definitionsByUri.get(privateNotebook.module)?.published).toBe(false);
      expect(remote.notCalled).toBe(true);
      expect(requests.getCalls().every(call => call.args[0].author === bob.did.uri)).toBe(true);
    } finally {
      remote.restore();
      requests.restore();
    }
    await member.agent.sync.deleteFollowedSource(privateRoot);
  }, 60_000);

  async function grantToDelegate(granteeDid: string, scope: PermissionScope): Promise<PermissionGrantEntry> {
    const grant = await member.agent.permissions.createGrant({
      author      : bob.did.uri,
      grantedTo   : granteeDid,
      delegated   : true,
      store       : true,
      dateExpires : '2999-01-01T00:00:00.000000Z',
      scope,
    });
    const { encodedData, ...rawMessage } = grant.message;
    for (const target of [granteeDid, bob.did.uri]) {
      const result = await delegate!.agent.dwn.processRequest({
        author      : granteeDid,
        target,
        messageType : DwnInterface.RecordsWrite,
        rawMessage,
        ...(target === granteeDid ? { signAsOwner: true } : {}),
        dataStream  : new Blob([Encoder.base64UrlToBytes(encodedData) as BlobPart]),
      });
      expect(result.reply.status.code).toBe(202);
    }
    return grant;
  }

  async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    await pollUntil(predicate, {
      intervalMs : 50,
      message    : 'Managed composed feed did not become ready',
      timeoutMs  : 20_000,
    });
  }

});
