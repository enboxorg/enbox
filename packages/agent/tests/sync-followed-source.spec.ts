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
import { FollowedSourceNotReadyError, RoleReplicationSupportError } from '../src/sync-role-replication-support.js';

const SOURCE_DID = 'did:example:owner';
const PROTOCOL = 'https://example.com/notebooks';

const ROLES: FollowedSyncSourceInput['roles'] = [
  'notebook/collaborator',
  'notebook/viewer',
];

function protocolPathsFor(role: string): [string, ...string[]] {
  return role === 'notebook/collaborator'
    ? ['notebook', 'notebook/page', 'notebook/page/delta']
    : ['notebook', 'notebook/page'];
}

function source(
  id = 'role-a',
  contextId = 'notebook-a',
  protocolRole: FollowedSyncSource['protocolRole'] = 'notebook/viewer',
): FollowedSyncSource {
  return {
    acceptanceId   : `acceptance-${id}`,
    id,
    sourceDid      : SOURCE_DID,
    remoteEndpoint : 'https://owner.example.com',
    actorDid       : 'did:example:member',
    protocol       : PROTOCOL,
    contextId,
    protocolRole,
    protocolPaths  : protocolPathsFor(protocolRole),
    roles          : ROLES,
  };
}

function targetFor(followed: FollowedSyncSource, dwnUrl = followed.remoteEndpoint): SyncTarget {
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
    roles     : ROLES,
    sourceDid : followed.sourceDid,
  };
}

function supportBatch(roleRecordId: string): RoleReplicationSupportBatch {
  return {
    dependencies       : [],
    protocolDefinition : {} as any,
    roleRecordId,
    root               : { message: { descriptor: {} }, isLatestBaseState: true } as any,
    rootCid            : `root-${roleRecordId}`,
  };
}

async function storeFollowedSource(engine: SyncEngineLevel, followed: FollowedSyncSource): Promise<void> {
  const internal = engine as any;
  const replaced = await internal.commitFollowedSource(followed);
  await internal.removeFollowedSourceLinksForSources(replaced);
  internal.activateFollowedSource(followed, undefined);
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

  it('should resolve the context root for an exact nested role context', () => {
    expect(resolveFollowedSyncRoleRoot('notebook-a/page-a', 'notebook/page/viewer'))
      .toEqual({ protocolPath: 'notebook/page' });
  });

  it('should pull one followed source from its accepted endpoint under the sync lock', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const target = targetFor(followed);
    await internal._identityStore.set(followed.actorDid, { protocols: 'all' });
    await internal._followedSourceStore.replace(followed);
    const buildTarget = sinon.stub(internal.targetResolver, 'buildTargetForSource').resolves(target);
    const reconcile = sinon.stub(internal, 'reconcileTarget').callsFake(async (): Promise<{ pullDrained: true }> => {
      expect(internal._lifecycle.isSyncInProgress).toBe(true);
      return { pullDrained: true };
    });

    await expect(engine.pullFollowedSource(followed)).resolves.toBe(true);

    expect(buildTarget.calledOnceWithExactly(followed, undefined)).toBe(true);
    expect(reconcile.calledOnceWithMatch(target, { direction: 'pull' }, sinon.match.func)).toBe(true);
  });

  it('should join in-flight link initialization before pulling a followed source', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const target = targetFor(followed);
    await internal._identityStore.set(followed.actorDid, { protocols: 'all' });
    await internal._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, target);
    target.projectionId = link.projectionId;
    sinon.stub(internal.targetResolver, 'buildTargetForSource').resolves(target);
    internal._runtime = new SyncRuntime(true);

    const initializationStarted = deferred();
    const releaseInitialization = deferred();
    const initialize = sinon.stub(internal, 'initializeActivatedLinkTarget').callsFake(async (
      _target: SyncTarget,
      _linkKey: string,
      link: ReplicationLinkState,
      controller: any,
    ) => {
      initializationStarted.resolve();
      await releaseInitialization.promise;
      await internal.replicationLinkStore.setStatus(link, 'live');
      controller.markReplicationReady();
      return { status: 'active', durableLinkIdentityKey: target.authorizationEpoch };
    });
    const reconcile = sinon.stub(internal, 'reconcileOwnedTarget').resolves({ pullDrained: true });

    const initializing = internal.initializeLinkTarget(target);
    await initializationStarted.promise;
    const pulling = engine.pullFollowedSource(followed);
    await Promise.resolve();

    expect(initialize.calledOnce).toBe(true);
    expect(reconcile.notCalled).toBe(true);

    releaseInitialization.resolve();
    await initializing;
    expect(await pulling).toBe(true);
    expect(initialize.calledOnce).toBe(true);
    expect(reconcile.calledOnce).toBe(true);

    internal._runtime.dispose();
  });

  it('should not report currentness after the followed-source acceptance changes mid-pull', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await internal._identityStore.set(followed.actorDid, { protocols: 'all' });
    await internal._followedSourceStore.replace(followed);
    sinon.stub(internal.targetResolver, 'buildTargetForSource').resolves(targetFor(followed));
    sinon.stub(internal, 'reconcileTarget').callsFake(async (): Promise<{ pullDrained: true }> => {
      await internal._followedSourceStore.replace({ ...followed, acceptanceId: 'replacement-acceptance' });
      return { pullDrained: true };
    });

    await expect(engine.pullFollowedSource(followed)).resolves.toBe(false);
  });

  it('should mark an exact followed source pull-pending after a remote mutation', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await internal._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, targetFor(followed));
    const controller = internal.activateLink(linkKey(link), link);
    expect(controller.markPullCurrent(controller.replicationGeneration)).toBe(true);

    await expect(engine.markFollowedSourcePullPending(followed)).resolves.toBe(true);

    expect(controller.isPullCurrent).toBe(false);
    expect(controller.executor.hasPending('pull')).toBe(true);
    await expect(engine.markFollowedSourcePullPending({ ...followed, acceptanceId: 'retired' })).resolves.toBe(false);
  });

  it('should prepare a followed source without holding the sync lock', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const delegateDid = 'did:example:delegate';
    await internal._identityStore.set(followed.actorDid, { delegateDid, protocols: 'all' });
    sinon.stub(internal, 'resolveFollowedSource').callsFake(async (
      _input: FollowedSyncSourceInput,
      resolvedDelegateDid: string | undefined,
    ) => {
      expect(internal._lifecycle.isSyncInProgress).toBe(false);
      expect(resolvedDelegateDid).toBe(delegateDid);
      return {
        batch  : supportBatch(followed.id),
        source : followed,
      };
    });
    sinon.stub(internal, 'admitFollowedSource').callsFake(async () => {
      expect(internal._lifecycle.isSyncInProgress).toBe(true);
    });

    await expect(engine.followSource(sourceInput(followed))).resolves.toEqual(followed);
    expect(await engine.listFollowedSources()).toEqual([followed]);
  });

  it('should commit a replacement without reading the obsolete-link store', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const previous = source();
    const replacement = source('role-b', previous.contextId, 'notebook/collaborator');
    await internal._identityStore.set(previous.actorDid, { protocols: 'all' });
    await internal._followedSourceStore.replace(previous);
    const previousTarget = targetFor(previous);
    const link = await createRoleLink(engine, previousTarget);
    previousTarget.projectionId = link.projectionId;
    const controller = internal.activateLink(linkKey(link), link);
    sinon.stub(internal, 'resolveFollowedSource').resolves({
      batch  : supportBatch(replacement.id),
      source : replacement,
    });
    sinon.stub(internal, 'admitFollowedSource').resolves();
    sinon.stub(internal.targetResolver, 'buildTargetForSource').resolves(previousTarget);
    const readLinks = sinon.stub(internal.replicationLinkStore, 'getLinksForTenant');

    await expect(engine.followSource(sourceInput(previous))).resolves.toEqual(replacement);

    expect(readLinks.notCalled).toBe(true);
    expect(controller.isActive).toBe(false);
    expect(internal._linkControllers.has(linkKey(link))).toBe(false);
    expect(await engine.getFollowedSource(previous.id)).toBeUndefined();
    expect(await engine.getFollowedSource(replacement.id)).toEqual(replacement);
    readLinks.restore();
    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toEqual([]);
  });

  it('should reject a followed source whose actor is not registered for sync', async () => {
    const engine = new SyncEngineLevel({ db });
    const resolve = sinon.stub(engine as any, 'resolveFollowedSource');

    await expect(engine.followSource(sourceInput())).rejects.toBeInstanceOf(FollowedSourceNotReadyError);

    expect(resolve.notCalled).toBe(true);
    expect(await engine.listFollowedSources()).toEqual([]);
  });

  it('should report an initially absent role as not ready for invitation propagation', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await internal._identityStore.set(followed.actorDid, { protocols: 'all' });
    sinon.stub(internal, 'resolveFollowedSource').rejects(
      new FollowedSourceNotReadyError('none of the requested roles is available yet'),
    );

    await expect(engine.followSource(sourceInput(followed))).rejects.toBeInstanceOf(FollowedSourceNotReadyError);
    expect(await engine.listFollowedSources()).toEqual([]);
  });

  it('should let a destructive lifecycle transition fence in-flight followed-source preparation', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await internal._identityStore.set(followed.actorDid, { protocols: 'all' });
    const resolutionStarted = deferred();
    const releaseResolution = deferred();
    sinon.stub(internal, 'resolveFollowedSource').callsFake(async () => {
      resolutionStarted.resolve();
      await releaseResolution.promise;
      return {
        batch  : supportBatch(followed.id),
        source : followed,
      };
    });
    sinon.stub(internal, 'admitFollowedSource').resolves();

    const following = engine.followSource(sourceInput(followed));
    await resolutionStarted.promise;
    await engine.clear();
    expect(await engine.listFollowedSources()).toEqual([]);
    releaseResolution.resolve();

    await expect(following).rejects.toBeInstanceOf(FollowedSourceNotReadyError);
    expect(await engine.listFollowedSources()).toEqual([]);
  });

  it('should apply followed-context changes from a sibling engine', async () => {
    const dataPath = '__TESTDATA__/sync-followed-source-cross-context';
    const first = new SyncEngineLevel({ dataPath, db });
    const second = new SyncEngineLevel({ dataPath, db });
    const secondInternal = second as any;
    const previous = source('role-a');
    const replacement = source('role-b', previous.contextId, 'notebook/collaborator');
    const events: Array<string | undefined> = [];
    await secondInternal._identityStore.set(previous.actorDid, { protocols: 'all' });
    const activate = sinon.spy(secondInternal, 'activateFollowedSource');
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

      await storeFollowedSource(first, replacement);
      await waitFor(async () => {
        const links = await secondInternal.replicationLinkStore.getLinksForTenant(SOURCE_DID);
        return events.includes(replacement.id) &&
          activate.calledWith(replacement, undefined) &&
          !secondInternal._linkControllers.has(previousLinkKey) &&
          links.length === 0;
      });

      await first.deleteFollowedSource(replacement);
      await waitFor(() => events.includes(undefined));
      expect(events).toContain(undefined);
    } finally {
      (first as any).closeWakePublishers();
      secondInternal.closeWakePublishers();
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
      (first as any).closeWakePublishers();
      (second as any).closeWakePublishers();
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

    await internal.removeObsoleteFollowedSourceLinks();

    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toHaveLength(1);
  });

  it('should remove only the obsolete scope when one role record has two durable links', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const currentTarget = targetFor(followed);
    const obsoleteTarget: SyncTarget = {
      ...currentTarget,
      scope: { ...currentTarget.scope, protocolPaths: ['notebook'] },
    };
    await internal._followedSourceStore.replace(followed);
    await createRoleLink(engine, currentTarget);
    await createRoleLink(engine, obsoleteTarget);

    await internal.removeObsoleteFollowedSourceLinks();

    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([{
      scope: currentTarget.scope,
    }]);
  });

  it('should retire a link outside the source accepted endpoint', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = { ...source(), remoteEndpoint: 'https://current.example.com' };
    const oldTarget = targetFor(followed, 'https://old.example.com');
    await internal._followedSourceStore.replace(followed);
    const oldLink = await createRoleLink(engine, oldTarget);
    const controller = internal.activateLink(linkKey(oldLink), oldLink);

    expect(await engine.getReplicationLinks(SOURCE_DID)).toEqual([]);
    await internal.removeObsoleteFollowedSourceLinks();

    expect(controller.isActive).toBe(false);
    expect(internal._linkControllers.has(linkKey(oldLink))).toBe(false);
    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toEqual([]);
  });

  it('should retain role links when registered-identity target discovery fails', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const healthy = source('role-healthy', 'notebook-healthy');
    const unavailableIdentity = 'did:example:unavailable-identity';
    await internal._identityStore.set(unavailableIdentity, { protocols: 'all' });
    await internal._followedSourceStore.replace(healthy);
    await internal.replicationLinkStore.getOrCreateLink({
      tenantDid          : unavailableIdentity,
      remoteEndpoint     : 'https://member.example.com',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
    });
    const healthyLink = await createRoleLink(engine, targetFor(healthy));
    const healthyTarget = { ...targetFor(healthy), projectionId: healthyLink.projectionId };
    sinon.stub(internal.targetResolver, 'buildTargetResolutions').rejects(new Error('identity unavailable'));
    sinon.stub(internal.targetResolver, 'buildTargetForSource').resolves(healthyTarget);
    sinon.stub(console, 'warn');

    const links = await engine.getReplicationLinks();

    expect(links).toHaveLength(2);
    expect(links.some(link => link.tenantDid === unavailableIdentity && link.followedSourceId === undefined)).toBe(true);
    expect(links.filter(link => link.followedSourceId !== undefined).map(link => link.followedSourceId))
      .toEqual([healthy.id]);
  });

  it('should publish a catalog change received while obsolete-link cleanup is pending', async () => {
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
    await internal.refreshFollowedSourceState();

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
    const reconcile = sinon.stub((engine as any)._durableFeedReconciler, 'reconcile');

    await storeFollowedSource(engine, followed);

    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(reconcile.notCalled).toBe(true);
  });

  it('should persist before hot-adding the accepted target', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    const order: string[] = [];
    sinon.stub((engine as any).targetResolver, 'buildTargetForSource').resolves(target);
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

  it('should replace an older role authorization for the same followed context', async () => {
    const engine = new SyncEngineLevel({ db });
    const previous = source('role-a');
    const replacement = source('role-b', 'notebook-a', 'notebook/collaborator');
    const target = targetFor(replacement);
    await (engine as any)._followedSourceStore.replace(previous);
    const previousTarget = targetFor(previous);
    const previousLink = await createRoleLink(engine, previousTarget);
    previousTarget.projectionId = previousLink.projectionId;
    sinon.stub((engine as any).targetResolver, 'buildTargetForSource').callsFake(
      async (candidate: FollowedSyncSource): Promise<SyncTarget> =>
        candidate.id === previous.id ? previousTarget : target,
    );

    await storeFollowedSource(engine, replacement);

    expect(await engine.getFollowedSource(previous.id)).toBeUndefined();
    expect(await engine.listFollowedSources()).toEqual([replacement]);
    expect((await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).every(
      (link: ReplicationLinkState) => link.authorization.kind !== 'role' || link.authorization.roleRecordId !== previous.id,
    )).toBe(true);
  });

  it('should replace the active link when the same role record gains a new readable path', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await internal._followedSourceStore.replace(followed);
    const previousTarget = targetFor(followed);
    const previousLink = await createRoleLink(engine, previousTarget);
    previousTarget.projectionId = previousLink.projectionId;
    sinon.stub(internal.targetResolver, 'buildTargetForSource').resolves(previousTarget);
    const changed: FollowedSyncSource = {
      ...followed,
      acceptanceId  : 'acceptance-evolved',
      protocolPaths : ['notebook', 'notebook/page', 'notebook/page/delta'],
    };

    const replaced = await internal.commitFollowedSource(changed);
    expect(replaced).toEqual([followed]);
    await internal.removeFollowedSourceLinksForSources(replaced);

    expect(await engine.getFollowedSource(followed.id)).toEqual(changed);
    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toHaveLength(0);
  });

  it('should reject a different signed role-record tuple under the same record ID', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await internal._followedSourceStore.replace(followed);

    await expect(internal.commitFollowedSource({
      ...followed,
      acceptanceId : 'acceptance-different-context',
      contextId    : 'notebook-b',
    })).rejects.toThrow('already registered with different details');
    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
  });

  it('should pause the accepted endpoint when a query reports a replacement role record', async () => {
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

  it('should pause the accepted endpoint when it cannot find the role record', async () => {
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

  it('should pause before advancing past a role-feed entry that cannot be admitted', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    const message = {
      descriptor: {
        interface        : 'Protocols',
        method           : 'Configure',
        messageTimestamp : '2026-07-21T00:00:00.000000Z',
      },
    } as any;
    const messageCid = await Message.getCid(message);
    const previousCheckpoint = { epoch: 'epoch', position: '1', streamId: 'stream', messageCid: 'cid-before' };
    await (engine as any)._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, target);
    link.pull.contiguousAppliedToken = previousCheckpoint;
    await (engine as any).replicationLinkStore.persistCheckpoint(link, 'pull');
    stubRemoteQuery(engine, {
      status       : { code: 200 },
      entries      : [{ isLatestBaseState: true, message, messageCid }],
      cursor       : { epoch: 'epoch', position: '2', streamId: 'stream', messageCid },
      drained      : true,
      roleRecordId : followed.id,
    });
    (engine as any)._agent.dwn = {
      applyReplicatedMessage: sinon.stub().resolves({ kind: 'Invalid', reason: 'bad signature' }),
    };

    await expect((engine as any).reconcileTarget(target, { direction: 'pull' }))
      .rejects.toThrow(`role feed message ${messageCid} could not be admitted`);

    expect(await (engine as any)._deadLetterStore.get(
      target.did,
      messageCid,
      target.dwnUrl,
    )).toBeUndefined();
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([{
      pull   : { contiguousAppliedToken: previousCheckpoint },
      status : 'paused',
    }]);
  });

  it('should pause invalid role support without advancing the checkpoint', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const target = targetFor(followed);
    const checkpoint = { epoch: 'epoch', position: '1', streamId: 'stream', messageCid: 'cid-before' };
    await internal._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, target);
    link.pull.contiguousAppliedToken = checkpoint;
    await internal.replicationLinkStore.persistCheckpoint(link, 'pull');
    await internal.replicationLinkStore.setStatus(link, 'live');
    const controller = internal.activateLink(linkKey(link), link);
    controller.markReplicationReady();
    internal._runtime = new SyncRuntime(true);
    sinon.stub(internal._durableFeedReconciler, 'reconcile')
      .rejects(new RoleReplicationSupportError('unrelated support entry'));
    const scheduleRefresh = sinon.spy(internal, 'scheduleFollowedSourceRefresh');
    const report = sinon.stub(console, 'error');

    controller.executor.request('reconcile');
    await internal._linkRecoveryCoordinator.resume(controller);

    expect(report.calledOnce).toBe(true);
    expect(scheduleRefresh.notCalled).toBe(true);
    expect(internal._runtime.hasTimers((key: string): boolean => key.startsWith('syncReconcile:'))).toBe(false);
    expect(await internal._deadLetterStore.getForTenant(SOURCE_DID)).toEqual([]);
    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([{
      pull   : { contiguousAppliedToken: checkpoint },
      status : 'paused',
    }]);

    internal._runtime.dispose();
    await controller.dispose();
  });

  it('should retain an aged deferred role-feed entry for a later retry', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    const messageCid = 'cid-aged-deferred';
    const previousCheckpoint = { epoch: 'epoch', position: '1', streamId: 'stream', messageCid: 'cid-before' };
    await (engine as any)._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, target);
    link.pull.contiguousAppliedToken = previousCheckpoint;
    await (engine as any).replicationLinkStore.persistCheckpoint(link, 'pull');
    const agedAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
    await (engine as any)._deferredPullStore.put(target.did, messageCid, target.dwnUrl, {
      attempts        : 1,
      detail          : 'waiting for dependency',
      firstDeferredAt : agedAt,
      lastDeferredAt  : agedAt,
    });
    stubRemoteQuery(engine, {
      status       : { code: 200 },
      entries      : [{ messageCid, protocol: PROTOCOL }],
      cursor       : { epoch: 'epoch', position: '2', streamId: 'stream', messageCid },
      drained      : true,
      roleRecordId : followed.id,
    });
    sinon.stub(engine as any, 'admitRemoteFeedEntry').resolves({
      kind   : 'deferred',
      detail : 'waiting for dependency',
    });

    await expect((engine as any).reconcileTarget(target, { direction: 'pull' })).resolves.toMatchObject({
      deferredPull: { detail: 'waiting for dependency', messageCid },
    });

    expect(await (engine as any)._deadLetterStore.get(target.did, messageCid, target.dwnUrl)).toBeUndefined();
    expect(await (engine as any)._deferredPullStore.get(target.did, messageCid, target.dwnUrl)).toMatchObject({
      attempts        : 2,
      firstDeferredAt : agedAt,
    });
    expect(await (engine as any).replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([{
      pull   : { contiguousAppliedToken: previousCheckpoint },
      status : 'initializing',
    }]);
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

    await engine.setIdentityOptions({ did: actorDid, options });

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

    await engine.setIdentityOptions({
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

    await engine.removeIdentity(actorDid);

    expect(await engine.getIdentityOptions(actorDid)).toBeUndefined();
    expect(await engine.getFollowedSource(followed.id)).toEqual(followed);
    expect(close.calledOnce).toBe(true);
    expect(controller.isReplicationReady).toBe(false);
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

  it('should preserve another actor role link when its source identity unregisters', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    const target = targetFor(followed);
    await internal._identityStore.set(SOURCE_DID, { protocols: 'all' });
    await internal._followedSourceStore.replace(followed);
    const link = await createRoleLink(engine, target);
    const checkpoint = { epoch: 'epoch', position: '11', streamId: 'stream', messageCid: 'cid-11' };
    link.pull.contiguousAppliedToken = checkpoint;
    await internal.replicationLinkStore.persistCheckpoint(link, 'pull');

    await engine.removeIdentity(SOURCE_DID);

    expect(await engine.getIdentityOptions(SOURCE_DID)).toBeUndefined();
    expect(await internal.replicationLinkStore.getLinksForTenant(SOURCE_DID)).toMatchObject([{
      authorization : { actorDid: followed.actorDid, kind: 'role' },
      pull          : { contiguousAppliedToken: checkpoint },
    }]);
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

  it('should advance past a retained non-latest role-feed write', async () => {
    const engine = new SyncEngineLevel({ db });
    const retained = await TestDataGenerator.generateRecordsWrite({ protocol: PROTOCOL });
    const hydrate = sinon.spy(engine as any, 'readRoleReplicationSupport');

    const outcome = await (engine as any).admitRemoteFeedEntry(targetFor(source()), {
      isLatestBaseState : false,
      message           : retained.message,
      messageCid        : await Message.getCid(retained.message),
    });

    expect(outcome).toEqual({ kind: 'echo' });
    expect(hydrate.notCalled).toBe(true);
  });

  it('should not discard a role-feed write whose latest-state annotation is absent', async () => {
    const engine = new SyncEngineLevel({ db });
    const retained = await TestDataGenerator.generateRecordsWrite({ protocol: PROTOCOL });
    const continued = sinon.stub(engine as any, 'syncEntriesFromFeedEntry').rejects(new Error('continued'));

    await expect((engine as any).admitRemoteFeedEntry(targetFor(source()), {
      message    : retained.message,
      messageCid : await Message.getCid(retained.message),
    })).rejects.toThrow('continued');

    expect(continued.calledOnce).toBe(true);
  });

  it('should delete only the selected role link when contexts share a source tenant', async () => {
    const engine = new SyncEngineLevel({ db });
    const sourceA = source('role-a', 'notebook-a');
    const sourceB = source('role-b', 'notebook-b');
    await (engine as any)._followedSourceStore.replace(sourceA);
    await (engine as any)._followedSourceStore.replace(sourceB);
    const targetA = targetFor(sourceA);
    const targetB = targetFor(sourceB);
    const linkA = await createRoleLink(engine, targetA);
    const linkB = await createRoleLink(engine, targetB);
    targetA.projectionId = linkA.projectionId;
    targetB.projectionId = linkB.projectionId;
    sinon.stub((engine as any).targetResolver, 'buildTargetForSource').callsFake(
      async (candidate: FollowedSyncSource): Promise<SyncTarget> => candidate.id === sourceA.id ? targetA : targetB,
    );
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

  it('should deactivate and forget a followed source when durable link cleanup fails', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const followed = source();
    await internal._followedSourceStore.replace(followed);
    const target = targetFor(followed);
    const link = await createRoleLink(engine, target);
    target.projectionId = link.projectionId;
    sinon.stub(internal.targetResolver, 'buildTargetForSource').resolves(target);
    const controller = internal.activateLink(linkKey(link), link);
    sinon.stub(internal.replicationLinkStore, 'deleteLink').rejects(new Error('link store unavailable'));

    await expect(engine.deleteFollowedSource(followed)).resolves.toBeUndefined();

    expect(controller.isActive).toBe(false);
    expect(internal._linkControllers.has(linkKey(link))).toBe(false);
    expect(await engine.getFollowedSource(followed.id)).toBeUndefined();
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
