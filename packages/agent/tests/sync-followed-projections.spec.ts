import type { FollowedSyncProjection, FollowedSyncSource } from '../src/followed-sync-source.js';

import { Level } from 'level';
import { resolveModuleGraph } from '@enbox/dwn-sdk-js';
import sinon from 'sinon';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

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

  it('forgets all consumer links through a root handle captured before they were added', async () => {
    const selected = { ...root, additionalModules: [REALTIME], projections: [projection()] };
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
