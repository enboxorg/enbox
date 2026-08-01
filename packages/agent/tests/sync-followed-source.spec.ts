import type { FollowedSyncSource } from '../src/followed-sync-source.js';
import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { Level } from 'level';
import { Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { buildLinkKey } from '../src/sync-link-key.js';
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

  it('should persist a verified source without synchronously draining its history', async () => {
    const engine = new SyncEngineLevel({ db });
    const followed = source();
    const target = targetFor(followed);
    sinon.stub((engine as any).targetResolver, 'buildTargetsForSource').resolves([target]);
    const reconcile = sinon.stub((engine as any)._durableFeedReconciler, 'reconcile');

    await (engine as any).doSetFollowedSource(followed);

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

    await (engine as any).doSetFollowedSource(followed);
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

    await (engine as any).doSetFollowedSource(replacement);

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

    await (engine as any).doSetFollowedSource(updated);

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

    await expect((engine as any).doSetFollowedSource(changed)).rejects.toThrow('different details');
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

    await engine.unregisterIdentity(actorDid);

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

    await engine.deleteFollowedSource(sourceA.id);
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
