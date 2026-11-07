import type { ModuleDefinition, ModuleRuleSet } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { FollowedSyncProjection, FollowedSyncSource } from '../src/followed-sync-source.js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolveModuleGraph, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { deferred } from './utils/deferred.js';
import { ensureSyncStoreFormat } from '../src/sync-store-format.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { followedSyncProjectionEqual, followedSyncSourceActiveEqual } from '../src/followed-sync-source.js';

const MODULE = 'https://example.com/notebook';
const REALTIME = 'https://example.com/notebook-realtime';

function rootSource(): FollowedSyncSource {
  return {
    acceptanceId   : 'accepted-root',
    id             : 'viewer-role',
    sourceDid      : 'did:example:alice',
    actorDid       : 'did:example:bob',
    remoteEndpoint : 'https://owner.example/dwn',
    module         : MODULE,
    contextId      : 'notebook-record',
    moduleRole     : 'notebook/viewer',
    roles          : ['notebook/viewer'],
    modulePaths    : ['notebook', 'notebook/page'],
  };
}

function projection(module = REALTIME): FollowedSyncProjection {
  return { module, moduleRole: 'notebook:notebook/viewer', attachmentPath: 'notebook', modulePaths: ['notebook/live'] };
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
    const source = { ...root, sourceDid: owner.did, actorDid: actor.did, additionalModules: [REALTIME] };

    const result = await engine['prepareFollowedProjectionUpdates'](source, undefined, () => true);

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

    const preparing = engine['prepareFollowedProjectionUpdates']({ ...root, additionalModules: modules }, undefined, () => true);
    await entered.promise;
    expect(sendRequest.callCount).toBe(4);
    expect(cancel.notCalled).toBe(true);
    release.resolve();
    expect(await preparing).toEqual({ prepared: [], unavailable: [], pending: modules });
    expect(maximum).toBe(4);
    expect(cancel.calledOnce).toBe(true);
  });

  it('finishes each shared metadata closure before admitting the next consumer', async () => {
    const consumers = [projection(), projection(`${REALTIME}-second`)];
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
      prepared    : consumers.map(consumer => ({ projection: consumer, configurations: [], graph: projectionGraph() })),
      unavailable : [], pending     : [],
    });
    const entered = deferred();
    const release = deferred();
    const admit = sinon.stub(engine as never, 'admitFollowedProjection').resolves();
    admit.onFirstCall().callsFake(async (): Promise<void> => {
      entered.resolve();
      await release.promise;
      throw new Error('the first consumer metadata failed admission');
    });
    sinon.stub(console, 'warn');
    const selecting = engine.ensureFollowedSourceModules(root, consumers.map(consumer => consumer.module));
    await entered.promise;
    expect(admit.callCount).toBe(1);
    release.resolve();
    const selected = await selecting;
    expect(admit.callCount).toBe(2);
    expect(selected.projections).toEqual([consumers[1]]);
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
    const prepared = { configurations: [provider, consumer], projection: projection(), graph: projectionGraph() };
    const admitting = engine['admitFollowedProjection'](root, prepared, undefined);
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
    await expect(engine['admitFollowedProjection'](root, prepared, undefined)).rejects.toThrow('could not be admitted (Invalid)');
    expect(applyReplicatedMessage.callCount).toBe(1);
    expect(processRequest.notCalled).toBe(true);
  });

  it('adds a separately scoped consumer while preserving root authority and acceptance', async () => {
    const changes: Array<readonly string[] | undefined> = [];
    engine.on(event => {
      if (event.type === 'followed-context:change') {changes.push(event.affectedModules);}
    });
    const consumer = projection();
    const prepare = sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
      prepared    : [{ projection: consumer, configurations: [], graph: projectionGraph() }],
      unavailable : [],
      pending     : [],
    });
    sinon.stub(engine as never, 'admitFollowedProjection').resolves();

    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    expect(followedSyncSourceActiveEqual(root, selected)).toBe(true);
    expect(selected.acceptanceId).toBe(root.acceptanceId);
    expect(selected.additionalModules).toEqual([REALTIME]);
    expect(selected.projections).toEqual([consumer]);
    expect(changes).toEqual([undefined, [REALTIME]]);
    const [base, extra] = await engine['targetResolver'].buildTargetsForSource(selected);
    expect(base.scope).toMatchObject({ module: MODULE, modulePaths: root.modulePaths });
    expect(extra.scope).toMatchObject({ module: REALTIME, contextId: root.contextId, modulePaths: consumer.modulePaths });
    expect(extra.authorization).toMatchObject({ moduleRole: consumer.moduleRole, roleRecordId: root.id });
    expect(extra.dwnUrl).toBe(root.remoteEndpoint);
    expect(extra.projectionId).not.toBe(base.projectionId);
    expect(extra.authorizationEpoch).not.toBe(base.authorizationEpoch);
    expect(await engine.ensureFollowedSourceModules(root, [REALTIME])).toEqual(selected);
    expect(prepare.calledOnce).toBe(true);
  });

  it('resolves a cached verified graph without changing acceptance or selections and rejects stale projection handles', async () => {
    const graph = projectionGraph();
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
      prepared    : [{ projection: projection(), configurations: [], graph }],
      unavailable : [],
      pending     : [],
    });
    sinon.stub(engine as never, 'admitFollowedProjection').resolves();
    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    const persist = sinon.spy(engine['_followedSourceStore'], 'replace');
    expect(await engine.resolveFollowedSourceModuleGraph(selected, REALTIME)).toBe(graph);
    expect(persist.notCalled).toBe(true);
    await engine['_followedSourceStore'].replace({
      ...selected,
      projections: [{ ...projection(), modulePaths: ['notebook/live', 'notebook/live/session'] }],
    });
    await expect(engine.resolveFollowedSourceModuleGraph(selected, REALTIME)).rejects.toThrow('no current accepted root');
  });

  it('requires current delegate coverage even when the verified owner graph is already cached', async () => {
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
      prepared    : [{ projection: projection(), configurations: [], graph: projectionGraph() }],
      unavailable : [],
      pending     : [],
    });
    sinon.stub(engine as never, 'admitFollowedProjection').resolves();
    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    await engine['_identityStore'].set(root.actorDid, { delegateDid: 'did:example:carol', modules: 'all' });
    const permission = sinon.stub(engine['_permissionsApi'], 'getPermissionForRequest').rejects(new Error('consumer grant absent'));
    await expect(engine.resolveFollowedSourceModuleGraph(selected, REALTIME)).rejects.toThrow('consumer grant absent');
    expect(permission.firstCall.args[0]).toMatchObject({
      connectedDid : root.actorDid,
      delegateDid  : 'did:example:carol',
      module       : REALTIME,
      modulePath   : 'notebook/live',
    });
  });

  for (const change of ['forget', 'projection removal', 'projection replacement', 'acceptance replacement'] as const) {
    it(`prunes a cached graph after external ${change} while retaining other accepted graphs`, async () => {
      const graph = projectionGraph();
      sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
        prepared: [{ projection: projection(), configurations: [], graph }], unavailable: [], pending: [],
      });
      sinon.stub(engine as never, 'admitFollowedProjection').resolves();
      const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
      const other = { ...root, id: 'another-role', contextId: 'another-notebook' };
      await engine['_followedSourceStore'].replace(other);
      const otherSelected = await engine.ensureFollowedSourceModules(other, [REALTIME]);
      expect(engine['_followedProjectionGraphs'].size).toBe(2);

      if (change === 'forget') {
        await engine['_followedSourceStore'].delete(root.id);
      } else {
        const changed = { ...selected };
        if (change === 'projection removal') {
          changed.projections = undefined;
        } else if (change === 'acceptance replacement') {
          changed.acceptanceId = 'new-acceptance';
        } else {
          changed.projections = [{ ...projection(), modulePaths: ['notebook/another-path'] }];
        }
        await engine['_followedSourceStore'].replace(changed);
      }
      await engine['refreshFollowedSourceState']();

      expect(engine['_followedProjectionGraphs'].size).toBe(1);
      const load = sinon.spy(engine as never, 'loadFollowedProjectionGraph');
      expect(await engine.resolveFollowedSourceModuleGraph(otherSelected, REALTIME)).toBe(graph);
      expect(load.notCalled).toBe(true);
    });
  }

  it('keeps accepted graphs when paused or stopped offline and clears them with durable sync state', async () => {
    const graph = projectionGraph();
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
      prepared: [{ projection: projection(), configurations: [], graph }], unavailable: [], pending: [],
    });
    sinon.stub(engine as never, 'admitFollowedProjection').resolves();
    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    const target = await engine['targetResolver'].buildTargetForSource(selected, undefined, REALTIME);
    await engine['getOrCreateReplicationLink'](target);
    await engine['pauseRoleLinksForActor'](root.actorDid);
    expect(engine['_followedProjectionGraphs'].size).toBe(1);
    await engine.stopSync();
    expect(engine['_followedProjectionGraphs'].size).toBe(1);
    const load = sinon.spy(engine as never, 'loadFollowedProjectionGraph');
    expect(await engine.resolveFollowedSourceModuleGraph(selected, REALTIME)).toBe(graph);
    expect(load.notCalled).toBe(true);

    await engine.clear();
    expect(engine['_followedProjectionGraphs'].size).toBe(0);
    expect(await engine.listFollowedSources()).toEqual([]);
  });

  it('prunes a cached consumer when its new metadata cannot be admitted', async () => {
    const prepare = sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
      prepared: [{ projection: projection(), configurations: [], graph: projectionGraph() }], unavailable: [], pending: [],
    });
    const admit = sinon.stub(engine as never, 'admitFollowedProjection').resolves();
    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    expect(engine['_followedProjectionGraphs'].size).toBe(1);
    admit.rejects(new Error('incompatible configuration'));
    sinon.stub(console, 'warn');

    const updated = await engine['reconcileFollowedSourceModules'](selected, [], true);
    expect(prepare.callCount).toBe(2);
    expect(updated.projections).toBeUndefined();
    expect(engine['_followedProjectionGraphs'].size).toBe(0);
    expect(followedSyncSourceActiveEqual(root, updated)).toBe(true);
  });

  it('retains unavailable selections without blocking root refresh or claiming a consumer is current', async () => {
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({ prepared: [], unavailable: [REALTIME], pending: [] });
    const selected = await engine.ensureFollowedSourceModules(root, [REALTIME]);
    expect(selected.additionalModules).toEqual([REALTIME]);
    expect(selected.projections).toBeUndefined();
    expect(followedSyncSourceActiveEqual(root, selected)).toBe(true);
    expect(await engine.pullFollowedSource(selected, REALTIME)).toBe(false);
    const reconcile = sinon.stub(engine as never, 'reconcileTarget').resolves({ pullDrained: true });
    expect(await engine.pullFollowedSource(root)).toBe(true);
    expect(reconcile.calledOnce).toBe(true);
    expect((reconcile.firstCall.args[0] as { scope: { module: string } }).scope.module).toBe(MODULE);
  });

  it('reconciles consumer loss without retiring the root acceptance or its link', async () => {
    const selected = { ...root, additionalModules: [REALTIME], projections: [projection()] };
    await engine['_followedSourceStore'].replace(selected);
    const targets = await engine['targetResolver'].buildTargetsForSource(selected);
    for (const target of targets) {await engine['getOrCreateReplicationLink'](target);}
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({ prepared: [], unavailable: [REALTIME], pending: [] });

    const current = await engine['reconcileFollowedSourceModules'](selected, [], true);
    expect(followedSyncSourceActiveEqual(root, current)).toBe(true);
    expect(current.additionalModules).toEqual([REALTIME]);
    expect(current.projections).toBeUndefined();
    const links = await engine['replicationLinkStore'].getAllLinks();
    expect(links).toHaveLength(1);
    expect(links[0].scope).toMatchObject({ module: MODULE });
    expect(await engine.markFollowedSourcePullPending(selected, REALTIME)).toBe(false);
  });

  it('keeps verified consumer coordinates during transport uncertainty and marks only that projection pending', async () => {
    const selected = { ...root, additionalModules: [REALTIME], projections: [projection()] };
    await engine['_followedSourceStore'].replace(selected);
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({ prepared: [], unavailable: [], pending: [REALTIME] });
    const pending = sinon.spy(engine, 'markFollowedSourcePullPending');

    const current = await engine['reconcileFollowedSourceModules'](selected, [], true);
    expect(current).toEqual(selected);
    expect(pending.calledOnceWithExactly(current, REALTIME)).toBe(true);
  });

  it('settles independent pending-link updates before reporting an update failure', async () => {
    const consumers = [projection(), projection(`${REALTIME}-second`)];
    const selected = { ...root, additionalModules: consumers.map(consumer => consumer.module), projections: consumers };
    await engine['_followedSourceStore'].replace(selected);
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').resolves({
      prepared: [], unavailable: [], pending: selected.additionalModules,
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
    const selected = { ...root, additionalModules: [REALTIME], projections: [projection()] };
    await engine['_followedSourceStore'].replace(selected);
    for (const target of await engine['targetResolver'].buildTargetsForSource(selected)) {
      await engine['getOrCreateReplicationLink'](target);
    }
    engine['_followedProjectionGraphs'].set(SyncEngineLevel['followedProjectionGraphKey'](selected, REALTIME), {
      projection: projection(), graph: projectionGraph(),
    });

    await engine.deleteFollowedSource(root);
    expect(await engine.getFollowedSource(root.id)).toBeUndefined();
    expect(await engine['replicationLinkStore'].getAllLinks()).toEqual([]);
    expect(engine['_followedProjectionGraphs'].size).toBe(0);
  });

  it('cannot restore projections after the root is forgotten during preparation', async () => {
    const entered = deferred();
    const release = deferred();
    sinon.stub(engine as never, 'prepareFollowedProjectionUpdates').callsFake(async () => {
      entered.resolve();
      await release.promise;
      return { prepared: [{ projection: projection(), configurations: [], graph: projectionGraph() }], unavailable: [], pending: [] };
    });
    const admit = sinon.stub(engine as never, 'admitFollowedProjection').resolves();
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
    const first = { ...root, additionalModules: [REALTIME], projections: [projection()] };
    const changed = { ...projection(), modulePaths: ['notebook/live', 'notebook/live/session'] as [string, ...string[]] };
    const second = { ...first, projections: [changed] };
    expect(followedSyncSourceActiveEqual(first, second)).toBe(true);
    expect(followedSyncProjectionEqual(first.projections[0], second.projections[0])).toBe(false);
  });
});
