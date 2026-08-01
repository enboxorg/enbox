import type { ReplicationLinkState } from '../src/types/sync.js';
import type { RoleReplicationSupportBatch } from '../src/sync-role-replication-support.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { FollowedSyncSource, FollowedSyncSourceInput } from '../src/followed-sync-source.js';

import sinon from 'sinon';

import { Level } from 'level';
import { Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { buildLinkKey } from '../src/sync-link-key.js';
import { deferred } from './utils/deferred.js';
import { resolveFollowedSyncRoleRoot } from '../src/followed-sync-source.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRuntime } from '../src/sync-runtime.js';

const SOURCE_DID = 'did:example:owner';
const PROTOCOL = 'https://example.com/notebooks';

const ROLES: FollowedSyncSource['roles'] = [
  {
    protocolPaths : ['notebook', 'notebook/page', 'notebook/page/delta'],
    protocolRole  : 'notebook/collaborator',
  },
  { protocolPaths: ['notebook', 'notebook/page'], protocolRole: 'notebook/viewer' },
];

function source(
  id = 'role-a',
  contextId = 'notebook-a',
  protocolRole: FollowedSyncSource['protocolRole'] = 'notebook/viewer',
): FollowedSyncSource {
  const role = ROLES.find(candidate => candidate.protocolRole === protocolRole)!;
  return {
    acceptanceId  : `acceptance-${id}`,
    id,
    sourceDid     : SOURCE_DID,
    actorDid      : 'did:example:member',
    protocol      : PROTOCOL,
    contextId,
    protocolRole,
    protocolPaths : role.protocolPaths,
    roles         : ROLES,
  };
}

function targetFor(followed: FollowedSyncSource, dwnUrl = 'https://owner.example.com'): SyncTarget {
  return {
    did           : followed.sourceDid,
    dwnUrl,
    projectionId  : `projection-${followed.id}`,
    authorization : {
      kind         : 'role',
      actorDid     : followed.actorDid,
      protocolRole : followed.protocolRole,
      roleRecordId : followed.id,
    },
    authorizationEpoch : `epoch-${followed.id}`,
    scope              : {
      kind          : 'context',
      protocol      : followed.protocol,
      contextId     : followed.contextId,
      protocolPaths : followed.protocolPaths,
    },
  };
}

function sourceInput(followed = source()): FollowedSyncSourceInput {
  return {
    actorDid  : followed.actorDid,
    contextId : followed.contextId,
    protocol  : followed.protocol,
    roles     : followed.roles,
    sourceDid : followed.sourceDid,
  };
}

function supportBatch(roleRecordId: string): RoleReplicationSupportBatch {
  return {
    dependencies : [],
    roleRecordId,
    root         : { message: { descriptor: {} }, isLatestBaseState: true } as any,
    rootCid      : `root-${roleRecordId}`,
  };
}

async function storeFollowedSource(engine: SyncEngineLevel, followed: FollowedSyncSource): Promise<void> {
  const internal = engine as any;
  const commit = await internal.commitFollowedSource(followed);
  await internal.removeFollowedSourceLinksForSources(commit.replaced);
  internal.activateFollowedSource(followed, undefined, commit.existing !== undefined);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 1000): Promise<void> {
  const expiresAt = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= expiresAt) {
      throw new Error('Timed out waiting for followed-source state.');
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

describe('SyncEngineLevel — followed sources', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-followed-source-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should derive the context root record from the final compound context segment', () => {
    expect(resolveFollowedSyncRoleRoot('notebook-a/page-a', {
      protocolRole  : 'notebook/page/viewer',
      protocolPaths : ['notebook/page'],
    })).toEqual({ protocolPath: 'notebook/page', recordId: 'page-a' });
  });

  it('should prepare a followed source without holding the sync lock', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    sinon.stub(internal, 'resolveFollowedSource').callsFake(async () => {
      expect(internal._lifecycle.isSyncInProgress).toBe(false);
      return {
        kind    : 'active',
        batch   : supportBatch(followed.id),
        dwnUrl  : 'https://owner.example.com',
        dwnUrls : ['https://owner.example.com'],
        source  : followed,
      };
    });
    sinon.stub(internal, 'convergeRetiredFollowedSources').callsFake(async () => {
      expect(internal._lifecycle.isSyncInProgress).toBe(false);
    });
    sinon.stub(internal, 'admitFollowedSource').callsFake(async () => {
      expect(internal._lifecycle.isSyncInProgress).toBe(false);
    });

    await expect(engine.followSource(sourceInput(followed))).resolves.toEqual(followed);
    expect(await engine.listFollowedSources()).toEqual([followed]);
  });

  it('should re-prepare when the followed-source catalog changes before commit', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const initial = source();
    const concurrent = source('role-b', initial.contextId, 'notebook/collaborator');
    const resolve = sinon.stub(internal, 'resolveFollowedSource').callsFake(
      async (_input: FollowedSyncSourceInput, _shouldContinue: undefined, previous: FollowedSyncSource[]) => {
        const followed = previous[0] ?? initial;
        return {
          kind    : 'active',
          batch   : supportBatch(followed.id),
          dwnUrl  : 'https://owner.example.com',
          dwnUrls : ['https://owner.example.com'],
          source  : followed,
        };
      }
    );
    sinon.stub(internal, 'convergeRetiredFollowedSources').resolves();
    sinon.stub(internal, 'admitFollowedSource').callsFake(async () => {
      if (resolve.callCount === 1) {
        await internal._followedSourceStore.replace(concurrent);
      }
    });

    await expect(engine.followSource(sourceInput(initial))).resolves.toEqual(concurrent);
    expect(resolve.callCount).toBe(2);
    expect(await engine.listFollowedSources()).toEqual([concurrent]);
  });

  it('should serialize a destructive lifecycle transition behind followed-source preparation', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const resolutionStarted = deferred();
    const releaseResolution = deferred();
    sinon.stub(internal, 'resolveFollowedSource').callsFake(async () => {
      resolutionStarted.resolve();
      await releaseResolution.promise;
      return {
        kind    : 'active',
        batch   : supportBatch(followed.id),
        dwnUrl  : 'https://owner.example.com',
        dwnUrls : ['https://owner.example.com'],
        source  : followed,
      };
    });
    sinon.stub(internal, 'convergeRetiredFollowedSources').resolves();
    sinon.stub(internal, 'admitFollowedSource').resolves();

    const following = engine.followSource(sourceInput(followed));
    await resolutionStarted.promise;
    let clearCompleted = false;
    const clearing = engine.clear().then((): void => { clearCompleted = true; });
    await Promise.resolve();
    expect(clearCompleted).toBe(false);
    releaseResolution.resolve();

    await expect(following).resolves.toEqual(followed);
    await clearing;
    expect(await engine.listFollowedSources()).toEqual([]);
  });

  it('should wake followed-context maintenance after live-sync startup', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    sinon.stub(internal, 'startSyncRuntime').resolves();
    const schedule = sinon.stub(internal, 'scheduleFollowedSourceReconciliation');

    await engine.startSync();

    expect(schedule.calledOnce).toBe(true);
  });

  it('should drain maintenance wakes received during an active pass', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    internal._runtime = new SyncRuntime(true);
    const reconcile = sinon.stub(internal, 'reconcileFollowedSources').callsFake(async (): Promise<void> => {
      if (reconcile.callCount < 3) {
        internal.scheduleFollowedSourceReconciliation();
        internal.scheduleFollowedSourceReconciliation();
      }
    });

    internal.scheduleFollowedSourceReconciliation();
    await internal._lifecycle.waitForBackgroundTasks();

    expect(reconcile.callCount).toBe(3);
    internal._runtime.dispose();
  });

  it('should wake role maintenance only when an established link loses authority', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const link = await createRoleLink(engine, targetFor(source()));
    const schedule = sinon.stub(internal, 'scheduleFollowedSourceReconciliation');
    sinon.stub(internal._linkRecoveryCoordinator, 'transitionToPaused').resolves();

    link.status = 'initializing';
    await internal.transitionToPaused(linkKey(link), link);
    expect(schedule.notCalled).toBe(true);

    link.status = 'live';
    await internal.transitionToPaused(linkKey(link), link);
    expect(schedule.calledOnce).toBe(true);
  });

  it('should require every endpoint to agree on one exact role incarnation', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const endpoints = ['https://one.example', 'https://two.example'];
    internal._targetResolver = { getRemoteEndpointUrls: sinon.stub().resolves(endpoints) };
    const resolveEndpoint = sinon.stub(internal, 'resolveFollowedEndpoint');
    resolveEndpoint.onFirstCall().resolves({
      kind   : 'active',
      batch  : supportBatch('role-b'),
      dwnUrl : endpoints[0],
      role   : ROLES[0],
    });
    resolveEndpoint.onSecondCall().resolves({
      kind   : 'active',
      batch  : supportBatch('role-b'),
      dwnUrl : endpoints[1],
      role   : ROLES[0],
    });

    await expect(internal.resolveFollowedSource(sourceInput())).resolves.toMatchObject({
      kind   : 'active',
      source : { id: 'role-b', protocolRole: ROLES[0].protocolRole },
    });

    resolveEndpoint.reset();
    resolveEndpoint.onFirstCall().resolves({
      kind   : 'active',
      batch  : supportBatch('role-a'),
      dwnUrl : endpoints[0],
      role   : ROLES[0],
    });
    resolveEndpoint.onSecondCall().resolves({
      kind   : 'active',
      batch  : supportBatch('role-b'),
      dwnUrl : endpoints[1],
      role   : ROLES[0],
    });
    await expect(internal.resolveFollowedSource(sourceInput())).resolves.toMatchObject({ kind: 'unknown' });

    resolveEndpoint.reset();
    resolveEndpoint.onFirstCall().resolves({
      kind   : 'active',
      batch  : supportBatch('role-b'),
      dwnUrl : endpoints[0],
      role   : ROLES[0],
    });
    resolveEndpoint.onSecondCall().resolves({
      kind   : 'active',
      batch  : supportBatch('role-b'),
      dwnUrl : endpoints[1],
      role   : ROLES[1],
    });
    await expect(internal.resolveFollowedSource(sourceInput())).resolves.toMatchObject({ kind: 'unknown' });

    resolveEndpoint.reset();
    resolveEndpoint.onFirstCall().resolves({ kind: 'absent', dwnUrl: endpoints[0] });
    resolveEndpoint.onSecondCall().resolves({
      kind   : 'active',
      batch  : supportBatch('role-b'),
      dwnUrl : endpoints[1],
      role   : ROLES[0],
    });
    await expect(internal.resolveFollowedSource(sourceInput())).resolves.toMatchObject({ kind: 'unknown' });

    resolveEndpoint.reset();
    resolveEndpoint.onFirstCall().resolves({ kind: 'absent', dwnUrl: endpoints[0] });
    resolveEndpoint.onSecondCall().resolves({ kind: 'absent', dwnUrl: endpoints[1] });
    await expect(internal.resolveFollowedSource(sourceInput())).resolves.toEqual({ kind: 'absent', dwnUrls: endpoints });
  });

  it('should apply followed-context changes from a sibling engine', async () => {
    const dataPath = '__TESTDATA__/sync-followed-source-cross-context';
    const first = new SyncEngineLevel({ dataPath, db });
    const second = new SyncEngineLevel({ dataPath, db });
    const secondInternal = second as any;
    const previous = source('role-a');
    const replacement = source('role-b', previous.contextId, 'notebook/collaborator');
    const events: Array<string | undefined> = [];
    second.on(event => {
      if (event.type === 'followed-context:change') {
        events.push(event.followedSourceId);
      }
    });

    try {
      await storeFollowedSource(first, previous);
      await waitFor(() => events.includes(previous.id));

      const previousLink = await createRoleLink(second, targetFor(previous));
      const previousLinkKey = linkKey(previousLink);
      secondInternal.activateLink(previousLinkKey, previousLink);

      await secondInternal._identityStore.set(replacement.actorDid, { protocols: [PROTOCOL] });
      secondInternal._runtime = new SyncRuntime(true);
      sinon.stub(secondInternal, 'resolveFollowedSource').resolves({
        kind    : 'active',
        batch   : supportBatch(replacement.id),
        dwnUrl  : 'https://owner.example.com',
        dwnUrls : ['https://owner.example.com'],
        source  : replacement,
      });
      sinon.stub(secondInternal, 'convergeRetiredFollowedSources').resolves();
      sinon.stub(secondInternal, 'admitFollowedSource').resolves();
      secondInternal._targetResolver = {
        buildTargetsForSource: sinon.stub().resolves([targetFor(replacement)]),
      };
      sinon.stub(secondInternal, 'initializeLinkTargetWithRetry').callsFake(async (target: SyncTarget): Promise<any> => {
        const link = await createRoleLink(second, target);
        const key = linkKey(link);
        if (!secondInternal._linkControllers.has(key)) {
          secondInternal.activateLink(key, link);
        }
        return { status: 'active', durableLinkIdentityKey: key };
      });

      await storeFollowedSource(first, replacement);
      await waitFor(async () => {
        const links = await secondInternal.replicationLinkStore.getLinksForTenant(SOURCE_DID);
        return events.includes(replacement.id) &&
          !secondInternal._linkControllers.has(previousLinkKey) &&
          links.some((link: ReplicationLinkState): boolean =>
            link.authorization.kind === 'role' &&
            link.authorization.roleRecordId === replacement.id &&
            secondInternal._linkControllers.has(linkKey(link))
          );
      });
      const replacementLink = (await secondInternal.replicationLinkStore.getLinksForTenant(SOURCE_DID))[0];
      const replacementLinkKey = linkKey(replacementLink);

      await first.forgetFollowedContext(replacement);
      await waitFor(async () => events.includes(undefined) &&
        !secondInternal._linkControllers.has(replacementLinkKey) &&
        (await secondInternal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).length === 0);
    } finally {
      secondInternal._runtime.dispose();
      (first as any).closeFollowedSourceWakePublisher();
      secondInternal.closeFollowedSourceWakePublisher();
    }
  });

  it('should repair a missed followed-context removal during periodic reconciliation', async () => {
    const dataPath = '__TESTDATA__/sync-followed-source-missed-wake';
    const first = new SyncEngineLevel({ dataPath, db });
    const second = new SyncEngineLevel({ dataPath, db });
    const followed = source();

    try {
      await storeFollowedSource(first, followed);
      await waitFor(async () => (await second.listFollowedSources()).length === 1);
      const link = await createRoleLink(second, targetFor(followed));
      const key = linkKey(link);
      (second as any).activateLink(key, link);
      (second as any).closeFollowedSourceWakePublisher();

      const events: Array<string | undefined> = [];
      second.on(event => {
        if (event.type === 'followed-context:change') {
          events.push(event.followedSourceId);
        }
      });
      await first.forgetFollowedContext(followed);
      expect((second as any)._linkControllers.has(key)).toBe(true);

      await (second as any).reconcileFollowedSources(new SyncRuntime());

      expect(events).toEqual([undefined]);
      expect((second as any)._linkControllers.has(key)).toBe(false);
      expect(await (second as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toEqual([]);
    } finally {
      (first as any).closeFollowedSourceWakePublisher();
      (second as any).closeFollowedSourceWakePublisher();
    }
  });

  it('should not let a later catalog read consume a pending change event', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const events: Array<string | undefined> = [];
    engine.on(event => {
      if (event.type === 'followed-context:change') {
        events.push(event.followedSourceId);
      }
    });

    expect(await engine.listFollowedSources()).toEqual([]);
    await internal._followedSourceStore.replace(followed);
    expect(await engine.listFollowedSources()).toEqual([followed]);

    await internal.refreshFollowedSourceState();

    expect(events).toEqual([followed.id]);
  });

  it('should baseline every durable source before applying a point mutation', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const existing = source('role-b', 'notebook-b');
    const added = source('role-a', 'notebook-a');
    const events: Array<{ contextId: string; id: string | undefined }> = [];
    await internal._followedSourceStore.replace(existing);
    engine.on(event => {
      if (event.type === 'followed-context:change') {
        events.push({ contextId: event.contextId, id: event.followedSourceId });
      }
    });

    await internal.commitFollowedSource(added);
    await internal._followedSourceStore.delete(existing.id);
    await internal.refreshFollowedSourceState();

    expect(events).toContainEqual({ contextId: existing.contextId, id: undefined });
  });

  it('should converge a cross-context re-follow to its new acceptance', async () => {
    const dataPath = '__TESTDATA__/sync-followed-source-exact-wakes';
    const first = new SyncEngineLevel({ dataPath, db });
    const second = new SyncEngineLevel({ dataPath, db });
    const followed = source();
    const replacement = { ...followed, acceptanceId: 'acceptance-readded' };
    const events: Array<{ acceptanceId: string; id: string | undefined }> = [];

    try {
      await storeFollowedSource(first, followed);
      await waitFor(async () => (await second.listFollowedSources()).length === 1);
      second.on(event => {
        if (event.type === 'followed-context:change') {
          events.push({
            acceptanceId : event.followedSourceAcceptanceId,
            id           : event.followedSourceId,
          });
        }
      });

      await (first as any).commitFollowedSourceRemoval(followed);
      await (first as any).commitFollowedSource(replacement);
      await waitFor(() => events.at(-1)?.acceptanceId === replacement.acceptanceId);

      expect(events.at(-1)).toEqual({ acceptanceId: replacement.acceptanceId, id: followed.id });
    } finally {
      (first as any).closeFollowedSourceWakePublisher();
      (second as any).closeFollowedSourceWakePublisher();
    }
  });

  it('should emit catalog removal on clear and allow the same source to be added again', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const events: Array<string | undefined> = [];
    engine.on(event => {
      if (event.type === 'followed-context:change') {
        events.push(event.followedSourceId);
      }
    });
    await storeFollowedSource(engine, followed);

    await engine.clear();
    await storeFollowedSource(engine, { ...followed, acceptanceId: 'acceptance-readded' });

    expect(events).toEqual([followed.id, undefined, followed.id]);
  });

  it('should not remove a role link when a sibling committed its source after a stale scan', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await createRoleLink(engine, targetFor(followed));
    sinon.stub(internal, 'runIdentityLifecycle').callsFake(async (_did: string, operation: () => Promise<void>) => {
      await internal._followedSourceStore.replace(followed);
      await operation();
    });

    await internal.removeObsoleteFollowedSourceLinks([]);

    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toHaveLength(1);
  });

  it('should publish the durable source that wins while catalog cleanup is pending', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const previous = source('role-a');
    const replacement = source('role-b', previous.contextId, 'notebook/collaborator');
    await internal._followedSourceStore.replace(previous);
    expect(await engine.listFollowedSources()).toEqual([previous]);

    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>(resolve => { markCleanupStarted = resolve; });
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    sinon.stub(internal, 'removeObsoleteFollowedSourceLinks').callsFake(async (): Promise<void> => {
      markCleanupStarted();
      await cleanupGate;
    });
    const events: string[] = [];
    engine.on(event => {
      if (event.type === 'followed-context:change' && event.followedSourceId !== undefined) {
        events.push(event.followedSourceId);
      }
    });

    const refresh = internal.refreshFollowedSourceState();
    await cleanupStarted;
    await internal._followedSourceStore.replace(replacement, [previous.id]);
    releaseCleanup();
    await refresh;

    expect(events).toEqual([replacement.id]);
    expect(await engine.listFollowedSources()).toEqual([replacement]);
  });

  it('should close the followed-context wake with the engine', async () => {
    const ownedDb = new Level<string, string>('__TESTDATA__/sync-followed-source-close-wake');
    const engine = new SyncEngineLevel({ dataPath: '__TESTDATA__/sync-followed-source-close-wake', db: ownedDb });
    const closeWake = sinon.spy((engine as any)._followedSourceWakePublisher, 'close');

    await engine.close();

    expect(closeWake.calledOnce).toBe(true);
  });

  it('should replace or retire a followed context only after an authoritative maintenance result', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const previous = source('role-a');
    const replacement = source('role-b', previous.contextId, 'notebook/collaborator');
    await internal._followedSourceStore.replace(previous);
    await internal._identityStore.set(previous.actorDid, { protocols: [PROTOCOL] });
    const events: unknown[] = [];
    engine.on(event => { events.push(event); });
    sinon.stub(internal, 'resolveFollowedSource').callsFake(async () => {
      expect(internal._lifecycle.isSyncInProgress).toBe(false);
      return {
        kind    : 'active',
        batch   : supportBatch(replacement.id),
        dwnUrl  : 'https://owner.example.com',
        dwnUrls : ['https://owner.example.com'],
        source  : replacement,
      };
    });
    const converge = sinon.stub(internal, 'convergeRetiredFollowedSources').resolves();
    const commitReplacement = sinon.spy(internal, 'commitFollowedSource');
    const commitRemoval = sinon.spy(internal, 'commitFollowedSourceRemoval');
    sinon.stub(internal, 'admitFollowedSource').callsFake(async () => {
      expect(internal._lifecycle.isSyncInProgress).toBe(false);
    });

    await internal.runFollowedSourceMaintenance(new SyncRuntime(), previous);

    expect(converge.firstCall.calledBefore(commitReplacement.firstCall)).toBe(true);
    expect(await engine.listFollowedSources()).toEqual([replacement]);
    expect(events).toMatchObject([{
      type             : 'followed-context:change',
      actorDid         : previous.actorDid,
      contextId        : previous.contextId,
      followedSourceId : replacement.id,
      protocol         : previous.protocol,
      tenantDid        : previous.sourceDid,
    }]);

    (internal.resolveFollowedSource as sinon.SinonStub).resolves({
      kind  : 'unknown',
      error : new Error('endpoint unavailable'),
    });
    await internal.runFollowedSourceMaintenance(new SyncRuntime(), replacement);
    expect(await engine.listFollowedSources()).toEqual([replacement]);
    expect(events).toHaveLength(1);

    (internal.resolveFollowedSource as sinon.SinonStub).resolves({
      kind    : 'absent',
      dwnUrls : ['https://owner.example.com'],
    });
    await internal.runFollowedSourceMaintenance(new SyncRuntime(), replacement);
    expect(converge.secondCall.calledBefore(commitRemoval.firstCall)).toBe(true);
    expect(await engine.listFollowedSources()).toEqual([]);
    expect(events).toHaveLength(2);
    expect(converge.calledTwice).toBe(true);
  });

  it('should let forget remove a role incarnation installed after its handle was checked', async () => {
    const engine = new SyncEngineLevel({ db });
    const previous = source('role-a');
    const replacement = source('role-b', previous.contextId, 'notebook/collaborator');
    await (engine as any)._followedSourceStore.replace(replacement);

    await engine.forgetFollowedContext(previous);

    expect(await engine.listFollowedSources()).toEqual([]);
  });

  it('should not let an exact stale-source deletion remove its replacement', async () => {
    const engine = new SyncEngineLevel({ db });
    const previous = source('role-a');
    const replacement = source('role-b', previous.contextId, 'notebook/collaborator');
    await (engine as any)._followedSourceStore.replace(replacement);

    await engine.deleteFollowedSource(previous);

    expect(await engine.listFollowedSources()).toEqual([replacement]);
  });

  it('should persist a verified source without synchronously draining its history', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    sinon.stub((engine as any).targetResolver, 'buildTargetsForSource').resolves([target]);
    const reconcile = sinon.stub((engine as any)._durableFeedReconciler, 'reconcile');

    await storeFollowedSource(engine, followed);

    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(reconcile.notCalled).toBe(true);
  });

  it('should persist before hot-adding every advertised target', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    const order: string[] = [];
    sinon.stub((engine as any).targetResolver, 'buildTargetsForSource').resolves([target]);
    const sourceStore = (engine as any)._followedSourceStore;
    const persist = sourceStore.replace.bind(sourceStore);
    sinon.stub(sourceStore, 'replace').callsFake(async (value: FollowedSyncSource, replacedIds: string[]) => {
      order.push('persist');
      await persist(value, replacedIds);
    });
    (engine as any)._runtime = new SyncRuntime(true);
    let finishInitialization!: () => void;
    let markInitializationStarted!: () => void;
    const initializationStarted = new Promise<void>(resolve => {
      markInitializationStarted = resolve;
    });
    const initialize = sinon.stub(engine as any, 'initializeLinkTargetWithRetry').callsFake(() => {
      order.push('hot-add');
      markInitializationStarted();
      return new Promise(resolve => {
        finishInitialization = (): void => resolve({ status: 'active', durableLinkIdentityKey: 'role-link' });
      });
    });

    await storeFollowedSource(engine, followed);
    await initializationStarted;

    expect(order).toEqual(['persist', 'hot-add']);
    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(await engine.listFollowedSources()).toEqual([followed]);
    expect(initialize.calledOnceWithExactly(target)).toBe(true);
    finishInitialization();
    await (engine as any)._lifecycle.waitForBackgroundTasks();
    (engine as any)._runtime.dispose();
  });

  it('should replace an older role-record incarnation for the same followed context', async () => {
    const engine = new SyncEngineLevel({ db });
    const previous = source('role-a');
    const replacement = source('role-b', 'notebook-a', 'notebook/collaborator');
    const target = targetFor(replacement);
    await (engine as any)._followedSourceStore.replace(previous);
    await createRoleLink(engine, targetFor(previous));
    sinon.stub((engine as any).targetResolver, 'buildTargetsForSource').resolves([target]);

    await storeFollowedSource(engine, replacement);

    expect(await engine.getFollowedSource(previous.id)).toBeUndefined();
    expect(await engine.listFollowedSources()).toEqual([replacement]);
    expect((await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).every(
      (link: ReplicationLinkState) => link.authorization.kind !== 'role' || link.authorization.roleRecordId !== previous.id,
    )).toBe(true);
  });

  it('should update a role group without restarting an unchanged active incarnation', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    await (engine as any)._followedSourceStore.replace(followed);
    await createRoleLink(engine, target);
    const updated: FollowedSyncSource = { ...followed, roles: [followed.roles[1], followed.roles[0]] };

    await storeFollowedSource(engine, updated);

    expect(await engine.getFollowedSource(followed.id)).toEqual(updated);
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toHaveLength(1);
  });

  it('should reject a changed active authorization under the same role-record ID', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    await (engine as any)._followedSourceStore.replace(followed);
    const changed: FollowedSyncSource = {
      ...followed,
      protocolPaths : ['notebook', 'notebook/page', 'notebook/page/delta'],
      roles         : [
        followed.roles[0],
        { ...followed.roles[1], protocolPaths: ['notebook', 'notebook/page', 'notebook/page/delta'] },
      ],
    };

    await expect(storeFollowedSource(engine, changed)).rejects.toThrow('different details');
    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
  });

  it('should pause only the lagging endpoint when a query reports a replacement role record', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    await (engine as any)._followedSourceStore.replace(followed);
    stubRemoteQuery(engine, {
      roleRecordId : 'role-b',
      status       : { code: 200 },
      entries      : [],
      drained      : true,
    });

    await expect((engine as any).reconcileTarget(target, { direction: 'pull' }))
      .rejects.toThrow('changed from role-a to role-b');

    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([
      { remoteEndpoint: target.dwnUrl, status: 'paused' },
    ]);
  });

  it('should pause only the lagging endpoint when it cannot find the role record', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    await (engine as any)._followedSourceStore.replace(followed);
    stubRemoteQuery(engine, {
      status: {
        code   : 401,
        detail : 'ProtocolAuthorizationMatchingRoleRecordNotFound: no matching role record',
      },
    });

    await expect((engine as any).reconcileTarget(target, { direction: 'pull' }))
      .rejects.toThrow('ProtocolAuthorizationMatchingRoleRecordNotFound');

    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([
      { remoteEndpoint: target.dwnUrl, status: 'paused' },
    ]);
  });

  it('should apply role pull-only policy at both engine reconciliation boundaries', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    await (engine as any)._followedSourceStore.replace(followed);
    const reconcile = sinon.stub((engine as any)._durableFeedReconciler, 'reconcile').resolves({ pullDrained: true });

    await (engine as any).reconcileTarget(target, { verifyConvergence: true });
    expect(reconcile.firstCall.args[2]).toEqual({ direction: 'pull', verifyConvergence: false });
    expect(await (engine as any).reconcileTarget(target, { direction: 'push' })).toEqual({ aborted: true });

    const [link] = await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID);
    await (engine as any).replicationLinkStore.setStatus(link, 'live');
    const controller = (engine as any).activateLink(linkKey(link), link);
    controller.markReplicationReady();
    await (engine as any).reconcileOwnedTarget(controller, target, { verifyConvergence: true });
    expect(reconcile.secondCall.args[2]).toEqual({ direction: 'pull', verifyConvergence: false });
    expect(await (engine as any).reconcileOwnedTarget(controller, target, { direction: 'push' }))
      .toEqual({ aborted: true });
    expect(reconcile.callCount).toBe(2);

    await controller.dispose();
  });

  it('should resume a paused role pull when the actor delegate registration refreshes', async () => {
    const engine = new SyncEngineLevel({ db });
    const actorDid = 'did:example:member';
    const delegateDid = 'did:example:delegate';
    const options = { delegateDid, protocols: [PROTOCOL] as [string] };
    const followed = source();
    const target = { ...targetFor(followed), delegateDid };
    await (engine as any)._followedSourceStore.replace(followed);
    await (engine as any)._identityStore.set(actorDid, options);
    stubRemoteQuery(engine, {
      status: { code: 401, detail: 'GrantAuthorizationGrantExpired: refresh the delegate grant' },
    });
    const send = (engine as any)._agent.rpc.sendDwnRequest;
    send.onSecondCall().resolves({
      status       : { code: 200 },
      entries      : [],
      drained      : true,
      roleRecordId : followed.id,
    });
    sinon.stub((engine as any)._scopeClosureValidator, 'validateClosure').resolves();
    sinon.stub(engine as any, 'tryPruneSupersededDurableLinksForRegisteredIdentity').resolves();
    sinon.stub((engine as any).targetResolver, 'withCurrentRoleGrant').callsFake(async value => value);

    await expect((engine as any).reconcileTarget(target)).rejects.toThrow('GrantAuthorizationGrantExpired');
    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([
      { remoteEndpoint: target.dwnUrl, status: 'paused', delegateDid },
    ]);

    (engine as any)._runtime = new SyncRuntime(true);
    const initialize = sinon.stub(engine as any, 'initializeLinkTargetWithRetry').callsFake(async value => {
      const result = await (engine as any).reconcileTarget(value);
      return {
        status                 : 'active',
        durableLinkIdentityKey : value.authorizationEpoch,
        result,
      };
    });

    await engine.updateIdentityOptions({ did: actorDid, options });

    expect(initialize.calledOnce).toBe(true);
    expect(initialize.firstCall.args[0]).toMatchObject({ delegateDid });
    expect(await initialize.firstCall.returnValue).toMatchObject({ result: { pullDrained: true } });
    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([
      { remoteEndpoint: target.dwnUrl, status: 'initializing', delegateDid },
    ]);

    (engine as any)._runtime.dispose();
  });

  it('should rebind a live role link when the actor delegate changes', async () => {
    const engine = new SyncEngineLevel({ db });
    const actorDid = 'did:example:member';
    const previousDelegate = 'did:example:delegate-a';
    const delegateDid = 'did:example:delegate-b';
    const followed = source();
    const target = { ...targetFor(followed), delegateDid: previousDelegate };
    const checkpoint = { epoch: 'epoch', position: '7', streamId: 'stream', messageCid: 'cid-7' };
    await (engine as any)._followedSourceStore.replace(followed);
    await (engine as any)._identityStore.set(actorDid, {
      delegateDid : previousDelegate,
      protocols   : [PROTOCOL],
    });
    const link = await createRoleLink(engine, target);
    link.pull.contiguousAppliedToken = checkpoint;
    await (engine as any).replicationLinkStore.persistCheckpoint(link, 'pull');
    await (engine as any).replicationLinkStore.setStatus(link, 'live');
    const controller = (engine as any).activateLink(linkKey(link), link);
    const close = sinon.stub().resolves();
    controller.setLiveSubscription({ close });
    (engine as any)._runtime = new SyncRuntime(true);

    sinon.stub((engine as any)._scopeClosureValidator, 'validateClosure').resolves();
    sinon.stub(engine as any, 'tryPruneSupersededDurableLinksForRegisteredIdentity').resolves();
    const initialize = sinon.stub(engine as any, 'initializeLinkTargetWithRetry').resolves({
      status                 : 'active',
      durableLinkIdentityKey : target.authorizationEpoch,
    });

    await engine.updateIdentityOptions({
      did     : actorDid,
      options : { delegateDid, protocols: [PROTOCOL] },
    });

    expect(controller.isActive).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(initialize.calledOnce).toBe(true);
    expect(initialize.firstCall.args[0]).toMatchObject({
      authorizationEpoch: target.authorizationEpoch,
      delegateDid,
    });
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([{
      authorizationEpoch : target.authorizationEpoch,
      delegateDid,
      pull               : { contiguousAppliedToken: checkpoint },
      status             : 'initializing',
    }]);

    (engine as any)._runtime.dispose();
  });

  it('should not revive a role link forgotten while its authorization is refreshed', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const target = targetFor(followed);
    await internal._identityStore.set(followed.actorDid, { protocols: 'all' });
    await internal._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, target);
    await internal.replicationLinkStore.setStatus(link, 'paused');
    const getOrCreate = internal.getOrCreateReplicationLink.bind(internal);
    sinon.stub(internal, 'getOrCreateReplicationLink').callsFake(async (value: SyncTarget) => {
      const refreshed = await getOrCreate(value);
      await internal._followedSourceStore.delete(followed.id);
      return refreshed;
    });

    await internal.refreshRoleLinksForActor(followed.actorDid);

    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toEqual([]);
  });

  it('should park role work without deleting its source when the actor unregisters', async () => {
    const engine = new SyncEngineLevel({ db });
    const actorDid = 'did:example:member';
    const followed = source();
    const target = targetFor(followed);
    const checkpoint = { epoch: 'epoch', position: '9', streamId: 'stream', messageCid: 'cid-9' };
    await (engine as any)._identityStore.set(actorDid, { protocols: 'all' });
    await (engine as any)._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, target);
    link.pull.contiguousAppliedToken = checkpoint;
    await (engine as any).replicationLinkStore.persistCheckpoint(link, 'pull');
    await (engine as any).replicationLinkStore.setStatus(link, 'live');
    const controller = (engine as any).activateLink(linkKey(link), link);
    const close = sinon.stub().resolves();
    controller.setLiveSubscription({ close });
    controller.markReplicationReady();
    (engine as any)._runtime = new SyncRuntime(true);
    const schedule = sinon.stub(engine as any, 'scheduleFollowedSourceReconciliation');

    await engine.unregisterIdentity(actorDid);

    expect(await engine.getIdentityOptions(actorDid)).toBeUndefined();
    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(close.calledOnce).toBe(true);
    expect(controller.isReplicationReady).toBe(false);
    expect(schedule.notCalled).toBe(true);
    expect((await (engine as any).getSyncTargets()).some(
      (planned: SyncTarget) => planned.authorization.kind === 'role',
    )).toBe(false);
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([{
      authorizationEpoch : target.authorizationEpoch,
      pull               : { contiguousAppliedToken: checkpoint },
      status             : 'paused',
    }]);

    (engine as any)._runtime.dispose();
    await controller.dispose();
  });

  it('should retain deferred role-feed work while the followed source is current', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    await (engine as any)._followedSourceStore.replace(followed);

    const retired = await (engine as any).tryRetireDeferredPull(target, {
      messageCid : 'deferred-role-message',
      protocol   : PROTOCOL,
    }, 'waiting for role support');

    expect(retired).toBe(false);
    expect(await (engine as any)._deferredPullStore.get(
      target.did,
      'deferred-role-message',
      target.dwnUrl,
    )).toMatchObject({ attempts: 1, detail: 'waiting for role support' });
  });

  it('should retain a role feed delete initialWrite as a non-latest dependency', async () => {
    const engine = new SyncEngineLevel({ db });
    const initial = await TestDataGenerator.generateRecordsWrite({ protocol: PROTOCOL });
    const deleted = await TestDataGenerator.generateRecordsDelete({
      author   : initial.author,
      recordId : initial.message.recordId,
    });
    const entries = await (engine as any).syncEntriesFromFeedEntry(targetFor(source()), {
      initialWrite      : initial.message,
      isLatestBaseState : true,
      message           : deleted.message,
      messageCid        : await Message.getCid(deleted.message),
    });

    expect(entries).toEqual([
      { message: initial.message, isLatestBaseState: false },
      { message: deleted.message, isLatestBaseState: true },
    ]);
  });

  it('should delete only the selected role link when contexts share a source tenant', async () => {
    const engine = new SyncEngineLevel({ db });
    const sourceA = source('role-a', 'notebook-a');
    const sourceB = source('role-b', 'notebook-b');
    await (engine as any)._followedSourceStore.replace(sourceA);
    await (engine as any)._followedSourceStore.replace(sourceB);
    const linkA = await createRoleLink(engine, targetFor(sourceA));
    const linkB = await createRoleLink(engine, targetFor(sourceB));
    const keyA = linkKey(linkA);
    const keyB = linkKey(linkB);
    const controllerA = (engine as any).activateLink(keyA, linkA);
    const controllerB = (engine as any).activateLink(keyB, linkB);
    const closeA = sinon.stub().resolves();
    const closeB = sinon.stub().resolves();
    controllerA.setLiveSubscription({ close: closeA });
    controllerB.setLiveSubscription({ close: closeB });
    const timerA = (SyncEngineLevel as any).linkInitRetryTimerKey(keyA);
    const timerB = (SyncEngineLevel as any).linkInitRetryTimerKey(keyB);
    (engine as any)._runtime.armTimeout(timerA, (): void => {}, 60_000);
    (engine as any)._runtime.armTimeout(timerB, (): void => {}, 60_000);

    await engine.deleteFollowedSource(sourceA);
    await Promise.resolve();

    expect(await engine.getFollowedSource(sourceA.id)).toBeUndefined();
    expect(await engine.getFollowedSource(sourceB.id)).toEqual(sourceB);
    expect((engine as any)._linkControllers.has(keyA)).toBe(false);
    expect((engine as any)._linkControllers.get(keyB)).toBe(controllerB);
    expect(closeA.calledOnce).toBe(true);
    expect(closeB.notCalled).toBe(true);
    expect((engine as any)._runtime.hasTimer(timerA)).toBe(false);
    expect((engine as any)._runtime.hasTimer(timerB)).toBe(true);
    expect((await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).map(
      (link: ReplicationLinkState) => link.authorization.kind === 'role' && link.authorization.roleRecordId,
    )).toEqual(['role-b']);

    (engine as any)._runtime.dispose();
    await controllerB.dispose();
  });
});

async function createRoleLink(engine: SyncEngineLevel, target: SyncTarget): Promise<ReplicationLinkState> {
  return (engine as any).replicationLinkStore.getOrCreateLink({
    tenantDid          : target.did,
    remoteEndpoint     : target.dwnUrl,
    scope              : target.scope,
    authorization      : target.authorization,
    authorizationEpoch : target.authorizationEpoch,
    delegateDid        : target.delegateDid,
  });
}

function linkKey(link: ReplicationLinkState): string {
  return buildLinkKey(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);
}

function stubRemoteQuery(engine: SyncEngineLevel, reply: object): void {
  (engine as any)._agent = {
    processDwnRequest : sinon.stub().resolves({ message: {} }),
    rpc               : { sendDwnRequest: sinon.stub().resolves(reply) },
  };
}
