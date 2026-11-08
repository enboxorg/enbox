import type { ModuleDefinition, ModuleRuleSet } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { FollowedModuleScope, FollowedSyncSource } from '../src/followed-sync-source.js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolveModuleGraph, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { deferred } from './utils/deferred.js';
import { ensureSyncStoreFormat } from '../src/sync-store-format.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { followedModuleScopeEqual, followedSyncSourceActiveEqual } from '../src/followed-sync-source.js';

const MODULE = 'https://example.com/notebook';
const REALTIME = 'https://example.com/notebook-realtime';

function rootSource(): FollowedSyncSource {
  return {
    acceptanceId   : 'accepted-root',
    id             : 'viewer-role',
    sourceDid      : 'did:example:alice',
    actorDid       : 'did:example:bob',
    remoteEndpoint : 'https://owner.example/dwn',
    rootModule     : MODULE,
    contextId      : 'notebook-record',
    roles          : ['notebook/viewer'],
    modules        : { [MODULE]: { contextPath: 'notebook', moduleRole: 'notebook/viewer', modulePaths: ['notebook', 'notebook/page'] } },
  };
}

function moduleScope(): FollowedModuleScope {
  return { moduleRole: 'notebook:notebook/viewer', contextPath: 'notebook', modulePaths: ['notebook/live'] };
}

function projectionGraph(): ReturnType<typeof resolveModuleGraph> {
  const root = {
    module    : MODULE,
    published : true,
    types     : { notebook: {}, viewer: {}, page: {} },
    structure : { notebook: {
      $actions : [{ role: 'notebook/viewer', can: ['read' as const] }],
      viewer   : { $role: true },
      page     : { $actions: [{ role: 'notebook/viewer', can: ['read' as const] }] },
    } },
  };
  return resolveModuleGraph({
    module    : REALTIME,
    published : true,
    uses      : { notebook: MODULE },
    types     : { live: {} },
    structure : { notebook: {
      $ref : 'notebook:notebook',
      live : { $actions: [{ role: 'notebook:notebook/viewer', can: ['read'] }] },
    } },
  }, uri => uri === MODULE ? root : undefined, { requireKeyAgreement: false });
}

describe('Followed context consumer projections', () => {
  let db: Level<string, string>;
  let engine: SyncEngineLevel;
  let root: FollowedSyncSource;

  beforeEach(async () => {
    db = new Level<string, string>(`__TESTDATA__/sync-followed-projections/${crypto.randomUUID()}`);
    engine = new SyncEngineLevel({ db });
    root = rootSource();
    await ensureSyncStoreFormat(db, 'sync-followed-projections.spec.ts');
    await engine['_identityStore'].set(root.actorDid, { modules: 'all' });
    await engine['_followedSourceStore'].replace(root);
  });

  afterEach(async () => {
    sinon.restore();
    await engine.close();
  });

  it('orders a diamond of signed consumer configurations without admitting unrelated root-support metadata', async () => {
    const owner = await TestDataGenerator.generatePersona();
    const actor = await TestDataGenerator.generatePersona();
    const graph = projectionGraph();
    const notebook = structuredClone(graph.definitionsByUri.get(MODULE)!);
    notebook.$keyAgreement = { publicKeyJwk: owner.encryptionKeyPair.publicJwk };
    (notebook.structure.notebook.viewer as ModuleRuleSet).$keyAgreement = notebook.$keyAgreement;
    const shared = `${MODULE}/shared`;
    const left = `${MODULE}/left`;
    const right = `${MODULE}/right`;
    const unrelated = `${MODULE}/unrelated`;
    const consumer = structuredClone(graph.definitionsByUri.get(REALTIME)!);
    consumer.uses = { ...consumer.uses, left, right };
    const definition = (module: string, uses?: Record<string, string>): ModuleDefinition => ({
      module, published: true, types: { item: {} }, structure: { item: {} }, ...(uses === undefined ? {} : { uses }),
    });
    const messages = await Promise.all([
      notebook, consumer, definition(left, { shared }), definition(right, { shared }), definition(shared), definition(unrelated),
    ].map(async moduleDefinition => (await TestDataGenerator.generateModulesConfigure({ author: owner, moduleDefinition })).message));
    const byModule = new Map(messages.map(message => [message.descriptor.definition.module, message]));
    sinon.stub(engine as never, 'readFollowedRootSupport').resolves({
      dependencies  : [MODULE, unrelated].map(module => ({ message: byModule.get(module), isLatestBaseState: true })),
      resolvedGraph : resolveModuleGraph(notebook, () => undefined), root          : {},
    });
    const sendRequest = sinon.stub().callsFake(async ({ messageParams }: { messageParams: { filter: { module: string } } }) => ({
      reply: { status: { code: 200, detail: 'OK' }, entries: [byModule.get(messageParams.filter.module)] },
    }));
    const query = await TestDataGenerator.generateMessagesQuery({ author: actor });
    sinon.stub(engine, 'agent').get(() => ({
      dwn               : { sendRequest },
      processDwnRequest : sinon.stub().resolves({ message: query.message }),
      rpc               : { sendDwnRequest: sinon.stub().resolves({ status: { code: 200 }, entries: [], roleRecordId: root.id }) },
    } as unknown as EnboxPlatformAgent));
    const source = { ...root, sourceDid: owner.did, actorDid: actor.did, modules: { ...root.modules, [REALTIME]: null } };

    const result = await engine['prepareFollowedModuleUpdates'](source, undefined, () => true);

    expect(result.unavailable).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.prepared).toHaveLength(1);
    const configurations = result.prepared[0].configurations;
    const ordered = configurations.map(message => message.descriptor.definition.module);
    expect([...ordered].sort()).toEqual([MODULE, REALTIME, shared, left, right].sort());
    expect(ordered.indexOf(shared)).toBeLessThan(ordered.indexOf(left));
    expect(ordered.indexOf(shared)).toBeLessThan(ordered.indexOf(right));
    for (const provider of [MODULE, left, right]) {
      expect(ordered.indexOf(provider)).toBeLessThan(ordered.indexOf(REALTIME));
    }
    for (const message of configurations) {expect(message).toBe(byModule.get(message.descriptor.definition.module)!);}
    expect(sendRequest.callCount).toBe(4);
  });

  it('prepares independent consumers with bounded requests and releases shared support only after they settle', async () => {
    const modules = Array.from({ length: 6 }, (_, index) => `${REALTIME}-${index}`);
    const entered = deferred();
    const release = deferred();
    const cancel = sinon.stub();
    sinon.stub(engine as never, 'readFollowedRootSupport').resolves({
      dependencies: [], root: { dataStream: new ReadableStream({ cancel }) },
    });
    let active = 0;
    let maximum = 0;
    const sendRequest = sinon.stub().callsFake(async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 4) {entered.resolve();}
      await release.promise;
      active--;
      return { reply: { status: { code: 503, detail: 'temporarily unavailable' } } };
    });
    sinon.stub(engine, 'agent').get(() => ({ dwn: { sendRequest } } as unknown as EnboxPlatformAgent));

    const preparing = engine['prepareFollowedModuleUpdates']({ ...root, modules: { ...root.modules, ...Object.fromEntries(modules.map(module => [module, null])) } }, undefined, () => true);
    await entered.promise;
    expect(sendRequest.callCount).toBe(4);
    expect(cancel.notCalled).toBe(true);
    release.resolve();
    expect(await preparing).toEqual({ prepared: [], unavailable: [], pending: modules });
    expect(maximum).toBe(4);
    expect(cancel.calledOnce).toBe(true);
  });

  it('finishes each shared metadata closure before admitting the next consumer', async () => {
    const consumers = [REALTIME, `${REALTIME}-second`];
    sinon.stub(engine as never, 'prepareFollowedModuleUpdates').resolves({
      prepared    : consumers.map(module => ({ module, scope: moduleScope(), configurations: [], graph: projectionGraph() })),
      unavailable : [], pending     : [],
    });
    const entered = deferred();
    const release = deferred();
    const admit = sinon.stub(engine as never, 'admitFollowedModule').resolves();
    admit.onFirstCall().callsFake(async (): Promise<void> => {
      entered.resolve();
      await release.promise;
      throw new Error('the first consumer metadata failed admission');
    });
    sinon.stub(console, 'warn');
    const selecting = engine.ensureFollowedSourceModules(root, consumers);
    await entered.promise;
    expect(admit.callCount).toBe(1);
    release.resolve();
    const selected = await selecting;
    expect(admit.callCount).toBe(2);
    expect(selected.modules[consumers[0]]).toBeNull();
    expect(selected.modules[consumers[1]]).toEqual(moduleScope());
    expect(selected.acceptanceId).toBe(root.acceptanceId);
  });

  it('admits providers before consumers and stops when a provider cannot be admitted', async () => {
    const provider = (await TestDataGenerator.generateModulesConfigure({ moduleDefinition: {
      module: MODULE, published: true, types: { notebook: {} }, structure: { notebook: {} },
    } })).message;
    const consumer = (await TestDataGenerator.generateModulesConfigure({ moduleDefinition: {
      module    : REALTIME, published : true, uses      : { notebook: MODULE }, types     : { live: {} },
      structure : { notebook: { $ref: 'notebook:notebook', live: {} } },
    } })).message;
    const entered = deferred();
    const release = deferred();
    const applyReplicatedMessage = sinon.stub().resolves({ kind: 'Applied' });
    applyReplicatedMessage.onFirstCall().callsFake(async () => {
      entered.resolve();
      await release.promise;
      return { kind: 'Applied' };
    });
    const processRequest = sinon.stub().resolves({ reply: { status: { code: 200 }, entries: [consumer] } });
    sinon.stub(engine, 'agent').get(() => ({ dwn: { applyReplicatedMessage, processRequest } } as unknown as EnboxPlatformAgent));
    const prepared = { configurations: [provider, consumer], module: REALTIME, scope: moduleScope(), graph: projectionGraph() };
    const admitting = engine['admitFollowedModule'](root, prepared, undefined);
    await entered.promise;
    expect(applyReplicatedMessage.callCount).toBe(1);
    expect(applyReplicatedMessage.firstCall.args).toEqual([root.sourceDid, provider]);
    expect(processRequest.notCalled).toBe(true);
    release.resolve();
    await admitting;
    expect(applyReplicatedMessage.secondCall.args).toEqual([root.sourceDid, consumer]);
    expect(processRequest.calledOnce).toBe(true);

    applyReplicatedMessage.resetHistory();
    applyReplicatedMessage.resetBehavior();
    applyReplicatedMessage.resolves({ kind: 'Invalid' });
    processRequest.resetHistory();
    await expect(engine['admitFollowedModule'](root, prepared, undefined)).rejects.toThrow('could not be admitted (Invalid)');
    expect(applyReplicatedMessage.callCount).toBe(1);
    expect(processRequest.notCalled).toBe(true);
  });

  it('adds a separately scoped consumer while preserving root authority and acceptance', async () => {
    const changes: Array<readonly string[] | undefined> = [];
    engine.on(event => {
      if (event.type === 'followed-context:change') {changes.push(event.affectedModules);}
    });
    const consumer = moduleScope();
    const prepare = sinon.stub(engine as never, 'prepareFollowedModuleUpdates').resolves({
      prepared    : [{ module: REALTIME, scope: consumer, configurations: [], graph: projectionGraph() }],
      unavailable : [],
      pending     : [],
    });
    sinon.stub(engine as never, 'admitFollowedModule').resolves();

    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    expect(followedSyncSourceActiveEqual(root, selected)).toBe(true);
    expect(selected.acceptanceId).toBe(root.acceptanceId);
    expect(Object.keys(selected.modules).sort()).toEqual([MODULE, REALTIME].sort());
    expect(selected.modules[REALTIME]).toEqual(consumer);
    expect(changes).toEqual([undefined, [REALTIME]]);
    const [base, extra] = await engine['targetResolver'].buildTargetsForSource(selected);
    expect(base.scope).toMatchObject({ module: MODULE, modulePaths: root.modules[MODULE]!.modulePaths });
    expect(extra.scope).toMatchObject({ module: REALTIME, contextId: root.contextId, modulePaths: consumer.modulePaths });
    expect(extra.authorization).toMatchObject({ moduleRole: consumer.moduleRole, roleRecordId: root.id });
    expect(extra.dwnUrl).toBe(root.remoteEndpoint);
    expect(extra.projectionId).not.toBe(base.projectionId);
    expect(extra.authorizationEpoch).not.toBe(base.authorizationEpoch);
    expect(await engine.ensureFollowedSourceModules(root, [REALTIME])).toEqual(selected);
    expect(prepare.calledOnce).toBe(true);
  });

  it('rebuilds the root graph from its admitted role-read proof without requiring a feed grant', async () => {
    const owner = await TestDataGenerator.generatePersona();
    const definition = structuredClone(projectionGraph().definitionsByUri.get(MODULE)!);
    definition.$keyAgreement = { publicKeyJwk: owner.encryptionKeyPair.publicJwk };
    (definition.structure.notebook.viewer as ModuleRuleSet).$keyAgreement = definition.$keyAgreement;
    const configured = await TestDataGenerator.generateModulesConfigure({ author: owner, moduleDefinition: definition });
    const support = sinon.stub(engine as never, 'readFollowedRootSupport').resolves({
      dependencies  : [{ message: configured.message, isLatestBaseState: true }],
      resolvedGraph : resolveModuleGraph(definition, () => undefined), root          : {},
    });
    await engine['_identityStore'].set(root.actorDid, { modules: 'all', delegateDid: 'did:example:delegate' });
    const grant = sinon.stub(engine['_permissionsApi'], 'getPermissionForRequest').rejects(new Error('no feed grant'));
    const processRequest = sinon.stub().rejects(new Error('unexpected additional read'));
    const sendRequest = sinon.stub().rejects(new Error('offline'));
    sinon.stub(engine, 'agent').get(() => ({ dwn: { processRequest, sendRequest } } as unknown as EnboxPlatformAgent));

    const graph = await engine.resolveFollowedSourceModuleGraph(root, MODULE);

    expect(graph.rootModuleUri).toBe(MODULE);
    expect(support.firstCall.args[3]).toBe(true);
    expect(grant.notCalled).toBe(true);
    expect(processRequest.notCalled).toBe(true);
    expect(sendRequest.notCalled).toBe(true);
  });

  it('reports missing admitted evidence as unavailable without a second remote recovery path', async () => {
    const read = sinon.stub(engine as never, 'readFollowedRootSupport').rejects(new Error('local root evidence missing'));
    const sendRequest = sinon.stub().rejects(new Error('must not recover through remote graph loading'));
    sinon.stub(engine, 'agent').get(() => ({ dwn: { sendRequest } } as unknown as EnboxPlatformAgent));

    await expect(engine.resolveFollowedSourceModuleGraph(root, MODULE)).rejects.toThrow('local root evidence missing');

    expect(read.calledOnce).toBe(true);
    expect(read.firstCall.args[3]).toBe(true);
    expect(sendRequest.notCalled).toBe(true);
    expect(await engine.getFollowedSource(root.id)).toEqual(root);
  });

  it('retains unavailable selections without blocking root refresh or claiming a consumer is current', async () => {
    sinon.stub(engine as never, 'prepareFollowedModuleUpdates').resolves({ prepared: [], unavailable: [REALTIME], pending: [] });
    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    expect(Object.keys(selected.modules).sort()).toEqual([MODULE, REALTIME].sort());
    expect(selected.modules[REALTIME]).toBeNull();
    expect(followedSyncSourceActiveEqual(root, selected)).toBe(true);
    expect(await engine.pullFollowedSource(selected, REALTIME)).toBe(false);
    const reconcile = sinon.stub(engine as never, 'reconcileTarget').resolves({ pullDrained: true });
    expect(await engine.pullFollowedSource(root, MODULE)).toBe(true);
    expect(reconcile.calledOnce).toBe(true);
    expect((reconcile.firstCall.args[0] as { scope: { module: string } }).scope.module).toBe(MODULE);
  });

  it('reconciles consumer loss without retiring the root acceptance or its link', async () => {
    const selected = { ...root, modules: { ...root.modules, [REALTIME]: moduleScope() } };
    await engine['_followedSourceStore'].replace(selected);
    const targets = await engine['targetResolver'].buildTargetsForSource(selected);
    for (const target of targets) {await engine['getOrCreateReplicationLink'](target);}
    sinon.stub(engine as never, 'prepareFollowedModuleUpdates').resolves({ prepared: [], unavailable: [REALTIME], pending: [] });

    const current = await engine['reconcileFollowedSourceModules'](selected, [], true);
    expect(followedSyncSourceActiveEqual(root, current)).toBe(true);
    expect(Object.keys(current.modules).sort()).toEqual([MODULE, REALTIME].sort());
    expect(current.modules[REALTIME]).toBeNull();
    const links = await engine['replicationLinkStore'].getAllLinks();
    expect(links).toHaveLength(1);
    expect(links[0].scope).toMatchObject({ module: MODULE });
    expect(await engine.markFollowedSourcePullPending(selected, REALTIME)).toBe(false);
  });

  it('keeps verified consumer coordinates during transport uncertainty and marks only that projection pending', async () => {
    const selected = { ...root, modules: { ...root.modules, [REALTIME]: moduleScope() } };
    await engine['_followedSourceStore'].replace(selected);
    sinon.stub(engine as never, 'prepareFollowedModuleUpdates').resolves({ prepared: [], unavailable: [], pending: [REALTIME] });
    const pending = sinon.spy(engine, 'markFollowedSourcePullPending');

    const current = await engine['reconcileFollowedSourceModules'](selected, [], true);
    expect(current).toEqual(selected);
    expect(pending.calledOnceWithExactly(current, REALTIME)).toBe(true);
  });

  it('settles independent pending-link updates before reporting an update failure', async () => {
    const consumers = [REALTIME, `${REALTIME}-second`];
    const selected = { ...root, modules: { ...root.modules, ...Object.fromEntries(consumers.map(module => [module, moduleScope()])) } };
    await engine['_followedSourceStore'].replace(selected);
    sinon.stub(engine as never, 'prepareFollowedModuleUpdates').resolves({
      prepared: [], unavailable: [], pending: consumers,
    });
    const entered = deferred();
    const release = deferred();
    const failure = new Error('pending link update failed');
    const markPending = sinon.stub(engine, 'markFollowedSourcePullPending');
    markPending.onFirstCall().rejects(failure);
    markPending.onSecondCall().callsFake(async (): Promise<boolean> => {
      entered.resolve();
      await release.promise;
      return true;
    });
    let settled = false;
    const updating = engine['reconcileFollowedSourceModules'](selected, [], true)
      .catch((error: unknown) => {settled = true; return error;});
    await entered.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect(await updating).toBe(failure);
    expect(await engine.getFollowedSource(root.id)).toEqual(selected);
  });

  it('collects independent source health keys in bounded batches and preserves all projections', async () => {
    const sources = Array.from({ length: 6 }, (_, index) => ({ ...root, id: `role-${index}`, contextId: `notebook-${index}` }));
    await engine['_followedSourceStore'].replace(sources[0], [root.id]);
    for (const source of sources.slice(1)) {await engine['_followedSourceStore'].replace(source);}
    const resolveTargets = engine['targetResolver'].buildTargetsForSource.bind(engine['targetResolver']);
    const entered = deferred();
    const release = deferred();
    let active = 0;
    let maximum = 0;
    const resolve = sinon.stub(engine['targetResolver'], 'buildTargetsForSource').callsFake(async source => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 4) {entered.resolve();}
      await release.promise;
      const targets = await resolveTargets(source);
      active--;
      return targets;
    });
    const keys = new Set<string>();
    const collecting = engine['addCurrentFollowedSourceKeys'](keys);
    await entered.promise;
    expect(resolve.callCount).toBe(4);
    release.resolve();
    await collecting;
    expect(maximum).toBe(4);
    expect(keys.size).toBe(6);
  });

  it('does not keep health targets from a failed followed-source resolution', async () => {
    const failure = new Error('source target computation failed');
    sinon.stub(engine['targetResolver'], 'buildTargetsForSource').rejects(failure);
    const keys = new Set<string>();
    await expect(engine['addCurrentFollowedSourceKeys'](keys)).rejects.toBe(failure);
    expect(keys.size).toBe(0);
  });

  it('forgets all consumer links through a root handle captured before they were added', async () => {
    const selected = { ...root, modules: { ...root.modules, [REALTIME]: moduleScope() } };
    await engine['_followedSourceStore'].replace(selected);
    for (const target of await engine['targetResolver'].buildTargetsForSource(selected)) {
      await engine['getOrCreateReplicationLink'](target);
    }

    await engine.deleteFollowedSource(root);
    expect(await engine.getFollowedSource(root.id)).toBeUndefined();
    expect(await engine['replicationLinkStore'].getAllLinks()).toEqual([]);
  });

  it('cannot restore projections after the root is forgotten during preparation', async () => {
    const entered = deferred();
    const release = deferred();
    sinon.stub(engine as never, 'prepareFollowedModuleUpdates').callsFake(async () => {
      entered.resolve();
      await release.promise;
      return { prepared: [{ module: REALTIME, scope: moduleScope(), configurations: [], graph: projectionGraph() }], unavailable: [], pending: [] };
    });
    const admit = sinon.stub(engine as never, 'admitFollowedModule').resolves();
    const adding = engine.ensureFollowedSourceModules(root, [REALTIME]);
    const outcome = adding.catch((error: unknown) => error);
    await entered.promise;
    await engine.deleteFollowedSource(root);
    release.resolve();

    expect(await outcome).toBeInstanceOf(Error);
    expect(admit.notCalled).toBe(true);
    expect(await engine.getFollowedSource(root.id)).toBeUndefined();
  });

  it('distinguishes consumer policy changes without changing root handle equality', () => {
    const first = { ...root, modules: { ...root.modules, [REALTIME]: moduleScope() } };
    const changed = { ...moduleScope(), modulePaths: ['notebook/live', 'notebook/live/session'] as [string, ...string[]] };
    const second = { ...first, modules: { ...first.modules, [REALTIME]: changed } };
    expect(followedSyncSourceActiveEqual(first, second)).toBe(true);
    expect(followedModuleScopeEqual(first.modules[REALTIME], second.modules[REALTIME])).toBe(false);
  });
});
