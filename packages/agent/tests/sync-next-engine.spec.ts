import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncEvent, SyncIdentityOptions } from '../src/types/sync.js';

import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '@enbox/dwn-sdk-js';
import { SyncEngineNext } from '../src/sync-next/engine.js';
import { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';
import { syncNextLinkKey, syncNextLogicalTargetId } from '../src/sync-next/ledger-key.js';

function target(did: string, dwnUrl: string): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did,
    dwnUrl,
    projectionId       : `projection-${did}`,
    scope              : { kind: 'full' },
  };
}

describe('SyncEngineNext orchestration', () => {
  let db: Level<string, string>;
  let engine: SyncEngineNext;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-next-engine-spec');
    await db.clear();
    engine = new SyncEngineNext({ db });
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    await engine.close();
  });

  it('should not persist a supplemental endpoint for a pre-aborted drain', async () => {
    const abort = new AbortController();
    abort.abort();

    const result = await engine.drainTo('https://cancelled.example/path/?token=secret#fragment', {
      signal: abort.signal,
    });

    expect(result).toMatchObject({
      endpoint        : 'https://cancelled.example/path',
      completed       : false,
      cancelled       : true,
      topologyChanged : false,
    });
    expect(await (engine as any)._endpointStore.get()).toBeUndefined();
  });

  it('should isolate listener failures from later sync observers', () => {
    const observed: SyncEvent[] = [];
    const unsubscribeThrowing = engine.on((): void => { throw new Error('observer failed'); });
    const unsubscribeHealthy = engine.on((event): void => { observed.push(event); });
    const event: SyncEvent = {
      type      : 'identity:registration-change',
      tenantDid : 'did:example:listener',
    };

    expect(() => (engine as any).emit(event)).not.toThrow();
    expect(observed).toEqual([event]);
    unsubscribeThrowing();
    unsubscribeHealthy();
  });

  it('should own catalog mutations directly and refresh sibling next engines', async () => {
    const dataPath = '__TESTDATA__/sync-next-catalog-wakes';
    const first = new SyncEngineNext({ dataPath, db });
    const second = new SyncEngineNext({ dataPath, db });
    const fakeAgent = { dwn: {}, permissions: {} } as never;
    first.agent = fakeAgent;
    second.agent = fakeAgent;
    sinon.stub(SyncScopeClosureValidator.prototype, 'validateClosure').resolves();
    const did = 'did:example:next-catalog-wake';
    const events: Array<SyncIdentityOptions | undefined> = [];
    let resolveSet!: () => void;
    let resolveRemove!: () => void;
    const setObserved = new Promise<void>(resolve => { resolveSet = resolve; });
    const removeObserved = new Promise<void>(resolve => { resolveRemove = resolve; });
    second.on((event): void => {
      if (event.type !== 'identity:registration-change' || event.tenantDid !== did) {
        return;
      }
      events.push(event.options);
      if (events.length === 1) {
        resolveSet();
      } else if (events.length === 2) {
        resolveRemove();
      }
    });

    try {
      await first.setIdentityOptions({ did, options: { protocols: ['https://proto.example'] } });
      await setObserved;
      await expect(first.ensureIdentityOptions({
        did,
        options: { protocols: ['https://proto.example', 'https://proto.example'] },
      })).resolves.toBe(false);
      await first.removeIdentity(did);
      await removeObserved;

      expect(events).toEqual([{ protocols: ['https://proto.example'] }, undefined]);
      expect((first as any)._control).toBeUndefined();
    } finally {
      for (const next of [first, second]) {
        next['_catalogChannel']?.close();
      }
    }
  });

  it('should accept and remove a role source without delegating to the legacy engine', async () => {
    const roleEngine = new SyncEngineNext({ db });
    roleEngine.agent = { dwn: {}, permissions: {} } as never;
    const actorDid = 'did:example:next-role-actor';
    const followed = {
      acceptanceId   : 'acceptance-role-record',
      actorDid,
      contextId      : 'notebook-a',
      id             : 'role-record',
      protocol       : 'https://role.example/notebook',
      protocolPaths  : ['notebook', 'notebook/note'] as [string, ...string[]],
      protocolRole   : 'notebook/member',
      remoteEndpoint : 'https://owner.example',
      roles          : ['notebook/member'] as [string, ...string[]],
      sourceDid      : 'did:example:next-role-owner',
    };
    const catalog = (roleEngine as any)._catalog;
    sinon.stub(catalog, 'resolveFollowedSource').resolves({ batch: {}, source: followed });
    sinon.stub(catalog, 'admitFollowedSource').resolves();
    await roleEngine.setIdentityOptions({ did: actorDid, options: { protocols: 'all' } });

    const accepted = await roleEngine.followSource({
      actorDid,
      contextId : followed.contextId,
      protocol  : followed.protocol,
      roles     : followed.roles,
      sourceDid : followed.sourceDid,
    });

    expect(accepted).toEqual(followed);
    expect(await roleEngine.getFollowedSource(followed.id)).toEqual(followed);
    const roleInternal = roleEngine as any;
    sinon.stub(roleInternal, 'ensureSession').resolves({
      session: {
        cover: async (): Promise<void> => {
          await roleInternal._identityStore.delete(actorDid);
        },
      },
      subscribed : false,
      target     : await roleInternal.targetResolver.buildTargetForSource(followed),
    });
    sinon.stub(roleInternal, 'disposeSession').resolves();
    expect(await roleEngine.pullFollowedSource(followed)).toBe(false);
    await roleEngine.deleteFollowedSource(followed);
    expect(await roleEngine.getFollowedSource(followed.id)).toBeUndefined();
    expect(await roleEngine.pullFollowedSource(followed)).toBe(false);
    await roleEngine.removeIdentity(actorDid);
  });

  it('should require two unchanged fingerprint observations for convergence', async () => {
    const internal = engine as any;
    const verify = sinon.stub(internal, 'verifyConvergence');
    verify.onFirstCall().resolves({
      converged         : true,
      localFingerprint  : 'first',
      remoteFingerprint : 'first',
    });
    verify.onSecondCall().resolves({
      converged         : true,
      localFingerprint  : 'second',
      remoteFingerprint : 'second',
    });

    const result = await internal.verifyStableConvergence(
      target('did:example:stable', 'https://stable.example'),
    );

    expect(verify.callCount).toBe(2);
    expect(result).toMatchObject({
      converged : false,
      error     : 'SyncEngineNext: feed head changed during convergence proof.',
    });
  });

  it('should give equivalent endpoint URLs one exact durable session identity', async () => {
    const internal = engine as any;
    const createSession = sinon.stub(internal, 'createSession').callsFake(async (syncTarget: SyncTarget) => ({
      session    : {},
      subscribed : false,
      target     : syncTarget,
    }));
    const canonical = target('did:example:normalized-link', 'https://dwn.example/path');
    const equivalent = { ...canonical, dwnUrl: 'https://dwn.example/path/' };

    const [first, second] = await Promise.all([
      internal.ensureSession(canonical),
      internal.ensureSession(equivalent),
    ]);

    expect(first).toBe(second);
    expect(first.target.dwnUrl).toBe('https://dwn.example/path');
    expect(createSession.calledOnce).toBe(true);
  });

  it('should coalesce subscription retries and honor Retry-After', async () => {
    const clock = sinon.useFakeTimers();
    const internal = engine as any;
    const refresh = sinon.stub(internal, 'scheduleLiveRefresh');
    internal._live = true;

    internal.scheduleSubscriptionRetry(new RateLimitError(1));
    internal.scheduleSubscriptionRetry(new RateLimitError(1));
    await clock.tickAsync(999);
    expect(refresh.notCalled).toBe(true);
    await clock.tickAsync(1);
    expect(refresh.calledOnce).toBe(true);

    internal._live = false;
  });

  it('should refresh a followed source after structured terminal authorization', async () => {
    const internal = engine as any;
    const roleTarget: SyncTarget = {
      ...target('did:example:owner', 'https://role.example'),
      authorization: {
        actorDid     : 'did:example:member',
        kind         : 'role',
        protocolRole : 'notebook/member',
        roleRecordId : 'role-record',
      },
    };
    const refresh = sinon.stub(internal, 'refreshFollowedSource').resolves();

    expect(internal.recoverRoleAuthorization(roleTarget, {
      code   : DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
      detail : 'subscription authorization failed during delivery',
    })).toBe(true);
    await Promise.resolve();

    expect(refresh.calledOnceWithExactly(roleTarget)).toBe(true);
  });

  it('should include foreign role targets authorized by a scoped identity', async () => {
    const actorDid = 'did:example:member';
    const roleTarget: SyncTarget = {
      ...target('did:example:shared-owner', 'https://shared-context.example'),
      authorization: {
        actorDid,
        kind         : 'role',
        protocolRole : 'notebook/editor',
        roleRecordId : 'role-record',
      },
    };
    const cover = sinon.stub().resolves();
    const internal = engine as any;
    sinon.stub(internal._identityStore, 'get').resolves({ protocols: 'all' });
    sinon.stub(internal._planner, 'getTargets').resolves([roleTarget]);
    sinon.stub(internal, 'pruneSupersededLinks').resolves();
    sinon.stub(internal, 'ensureSession').resolves({
      session    : { cover },
      subscribed : false,
      target     : roleTarget,
    });
    sinon.stub(internal, 'disposeSession').resolves();

    await engine.sync('pull', { did: actorDid });

    expect(cover.calledOnceWith('pull')).toBe(true);
  });

  it('should dispose owned and foreign-role sessions when their actor identity stops', async () => {
    const actorDid = 'did:example:actor';
    const disposeOwned = sinon.stub().resolves();
    const disposeRole = sinon.stub().resolves();
    const disposeOther = sinon.stub().resolves();
    const internal = engine as any;
    internal._sessions.set('owned', {
      session : { dispose: disposeOwned },
      target  : target(actorDid, 'https://owned.example'),
    });
    internal._sessions.set('role', {
      session : { dispose: disposeRole },
      target  : {
        ...target('did:example:source', 'https://source.example'),
        authorization: {
          actorDid,
          kind         : 'role',
          protocolRole : 'notebook/editor',
          roleRecordId : 'role-record',
        },
      },
    });
    internal._sessions.set('other', {
      session : { dispose: disposeOther },
      target  : target('did:example:other', 'https://other.example'),
    });

    await internal.disposeIdentitySessions(actorDid);

    expect(disposeOwned.calledOnce).toBe(true);
    expect(disposeRole.calledOnce).toBe(true);
    expect(disposeOther.notCalled).toBe(true);
    internal._sessions.clear();
  });

  it('should coalesce callers arriving during one covering run into one follow-up', async () => {
    const syncTarget = target('did:example:coalesce', 'https://coalesce.example');
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let runs = 0;
    const cover = sinon.stub().callsFake(async (): Promise<void> => {
      runs++;
      if (runs === 1) {
        markStarted();
        await firstGate;
      }
    });
    const internal = engine as any;
    sinon.stub(internal._planner, 'getTargets').resolves([syncTarget]);
    sinon.stub(internal, 'pruneSupersededLinks').resolves();
    sinon.stub(internal, 'ensureSession').resolves({
      session    : { cover },
      subscribed : false,
      target     : syncTarget,
    });
    sinon.stub(internal, 'disposeSession').resolves();

    const first = engine.sync('pull');
    await firstStarted;
    const second = engine.sync('pull');
    const third = engine.sync('pull');

    expect(second).toBe(third);
    releaseFirst();
    await Promise.all([first, second, third]);
    expect(cover.callCount).toBe(2);
  });

  it('should cancel a queued follow-up when the runtime stops', async () => {
    const syncTarget = target('did:example:stop', 'https://stop.example');
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const cover = sinon.stub().callsFake(async (): Promise<void> => {
      markStarted();
      await firstGate;
    });
    const internal = engine as any;
    sinon.stub(internal._planner, 'getTargets').resolves([syncTarget]);
    sinon.stub(internal, 'pruneSupersededLinks').resolves();
    sinon.stub(internal, 'ensureSession').resolves({
      session    : { cover },
      subscribed : false,
      target     : syncTarget,
    });
    sinon.stub(internal, 'disposeSession').resolves();

    const first = engine.sync('pull');
    await firstStarted;
    const queued = engine.sync('pull');
    void queued.catch((): void => {});
    const stopping = engine.stopSync();
    releaseFirst();

    await Promise.all([first, stopping]);
    await expect(queued).rejects.toThrow('cancelled by a runtime transition');
    expect(cover.calledOnce).toBe(true);
  });

  it('should let watermark covers interleave while endpoint operations remain separately bounded', async () => {
    const targets = [
      target('did:example:a1', 'https://shared.example'),
      target('did:example:a2', 'https://shared.example/'),
      target('did:example:b1', 'https://independent.example'),
    ];
    const activeByEndpoint = new Map<string, number>();
    let maxShared = 0;
    let activeTotal = 0;
    let maxTotal = 0;
    const internal = engine as any;
    sinon.stub(internal._planner, 'getTargets').resolves(targets);
    sinon.stub(internal, 'pruneSupersededLinks').resolves();
    sinon.stub(internal, 'ensureSession').callsFake(async (syncTarget: SyncTarget) => ({
      session: {
        cover: async (): Promise<void> => {
          const endpoint = new URL(syncTarget.dwnUrl).hostname;
          const endpointActive = (activeByEndpoint.get(endpoint) ?? 0) + 1;
          activeByEndpoint.set(endpoint, endpointActive);
          activeTotal++;
          maxShared = endpoint === 'shared.example' ? Math.max(maxShared, endpointActive) : maxShared;
          maxTotal = Math.max(maxTotal, activeTotal);
          await new Promise(resolve => { setTimeout(resolve, 10); });
          activeByEndpoint.set(endpoint, endpointActive - 1);
          activeTotal--;
        },
      },
      subscribed : false,
      target     : syncTarget,
    }));
    sinon.stub(internal, 'disposeSession').resolves();

    await engine.sync('pull');

    expect(maxShared).toBe(2);
    expect(maxTotal).toBe(3);
  });

  it('should report offline and degraded state from one tenant-scoped ledger snapshot', async () => {
    const syncTarget = target('did:example:status-next', 'https://status.example');
    const internal = engine as any;
    await internal._ledger.getOrCreateLink({
      authorization      : syncTarget.authorization,
      authorizationEpoch : syncTarget.authorizationEpoch,
      projectionId       : syncTarget.projectionId,
      remoteEndpoint     : syncTarget.dwnUrl,
      scope              : syncTarget.scope,
      tenantDid          : syncTarget.did,
    });
    await internal._ledger.commitPushPage({
      authorizationEpoch : syncTarget.authorizationEpoch,
      projectionId       : syncTarget.projectionId,
      remoteEndpoint     : syncTarget.dwnUrl,
      tenantDid          : syncTarget.did,
    }, {
      delivery: [{
        messageCid : 'pending-cid',
        outcome    : { blockScope: 'endpoint', reason: 'transport' },
        source     : { epoch: 'epoch', messageCid: 'pending-cid', position: '1', streamId: 'stream' },
      }],
      handledThrough : { epoch: 'epoch', position: '1', streamId: 'stream' },
      settled        : [],
    });
    const key = syncNextLinkKey({
      authorizationEpoch : syncTarget.authorizationEpoch,
      projectionId       : syncTarget.projectionId,
      remoteEndpoint     : syncTarget.dwnUrl,
      tenantDid          : syncTarget.did,
    });
    internal._sessions.set(key, {
      session    : { isOnline: false, isPullCurrent: false },
      subscribed : true,
      target     : syncTarget,
    });

    const status = await engine.getIdentitySyncStatus(syncTarget.did);

    expect(status.connectivity).toBe('offline');
    expect(status.health.syncHealthy).toBe(false);
    expect(status.remotes).toMatchObject([{
      connectivity : 'offline',
      state        : 'offline',
    }]);
    internal._sessions.delete(key);
    await internal._ledger.deleteForTenant(syncTarget.did);
  });

  it('should retire obsolete-epoch delivery rows instead of orphaning them', async () => {
    const oldTarget = target('did:example:epoch-next', 'https://epoch.example');
    const replacement = { ...oldTarget, authorizationEpoch: 'replacement-epoch' };
    const internal = engine as any;
    await internal._ledger.getOrCreateLink({
      authorization      : oldTarget.authorization,
      authorizationEpoch : oldTarget.authorizationEpoch,
      projectionId       : oldTarget.projectionId,
      remoteEndpoint     : oldTarget.dwnUrl,
      scope              : oldTarget.scope,
      tenantDid          : oldTarget.did,
    });
    await internal._ledger.commitPushPage({
      authorizationEpoch : oldTarget.authorizationEpoch,
      projectionId       : oldTarget.projectionId,
      remoteEndpoint     : oldTarget.dwnUrl,
      tenantDid          : oldTarget.did,
    }, {
      delivery: [{
        messageCid : 'old-obligation',
        outcome    : { blockScope: 'endpoint', reason: 'transport' },
        source     : { epoch: 'epoch', messageCid: 'old-obligation', position: '1', streamId: 'stream' },
      }],
      handledThrough : { epoch: 'epoch', position: '1', streamId: 'stream' },
      settled        : [],
    });
    sinon.stub(internal._planner, 'lastResolutionComplete').get(() => true);

    await internal.pruneSupersededLinks([replacement]);

    expect(await internal._ledger.getLink({
      authorizationEpoch : oldTarget.authorizationEpoch,
      projectionId       : oldTarget.projectionId,
      remoteEndpoint     : oldTarget.dwnUrl,
      tenantDid          : oldTarget.did,
    })).toBeUndefined();
    expect(await internal._ledger.getDeliveryForTenant(oldTarget.did)).toEqual([]);
    await internal._ledger.deleteForTenant(oldTarget.did);
  });

  it('should purge sparse state when an explicit scope change removes its logical target', async () => {
    const oldTarget = target('did:example:scope-next', 'https://scope.example');
    const replacement = { ...oldTarget, projectionId: 'replacement-projection' };
    const internal = engine as any;
    await internal._ledger.getOrCreateLink({
      authorization      : oldTarget.authorization,
      authorizationEpoch : oldTarget.authorizationEpoch,
      projectionId       : oldTarget.projectionId,
      remoteEndpoint     : oldTarget.dwnUrl,
      scope              : oldTarget.scope,
      tenantDid          : oldTarget.did,
    });
    await internal._ledger.commitPullPage({
      authorizationEpoch : oldTarget.authorizationEpoch,
      projectionId       : oldTarget.projectionId,
      remoteEndpoint     : oldTarget.dwnUrl,
      tenantDid          : oldTarget.did,
    }, {
      handledThrough : { epoch: 'epoch', position: '1', streamId: 'stream' },
      quarantine     : [{
        encryptedPayload : 'retired-scope-input',
        messageCid       : 'retired-scope-cid',
        source           : {
          epoch      : 'epoch',
          messageCid : 'retired-scope-cid',
          position   : '1',
          streamId   : 'stream',
        },
      }],
      settled: [],
    });
    sinon.stub(internal._planner, 'lastResolutionComplete').get(() => true);

    await internal.pruneSupersededLinks([replacement]);

    expect(await internal._ledger.getQuarantineForTenant(oldTarget.did)).toEqual([]);
    await internal._ledger.deleteForTenant(oldTarget.did);
  });

  it('should not create durable state while rebuilding a missing link', async () => {
    const current = target('did:example:missing-rebuild', 'https://rebuild.example');
    const internal = engine as any;
    sinon.stub(internal._planner, 'getTargets').resolves([current]);
    sinon.stub(internal._planner, 'lastResolutionComplete').get(() => true);

    await expect(engine.rebuildRemoteDirection({
      direction      : 'pull',
      remoteEndpoint : current.dwnUrl,
      tenantDid      : current.did,
    })).rejects.toThrow('no durable checkpoint');

    expect(await internal._ledger.getAllLinks()).toEqual([]);
  });

  it('should reset current pull progress before purging corrupt logical-target quarantine', async () => {
    const current = target('did:example:rebuild-next', 'https://rebuild.example');
    const peer = { ...current, dwnUrl: 'https://peer.example' };
    const retired = { ...current, authorizationEpoch: 'retired-epoch', dwnUrl: 'https://old.example' };
    const internal = engine as any;
    for (const syncTarget of [current, peer, retired]) {
      await internal._ledger.getOrCreateLink({
        authorization      : syncTarget.authorization,
        authorizationEpoch : syncTarget.authorizationEpoch,
        projectionId       : syncTarget.projectionId,
        remoteEndpoint     : syncTarget.dwnUrl,
        scope              : syncTarget.scope,
        tenantDid          : syncTarget.did,
      });
      await internal._ledger.commitPullPage({
        authorizationEpoch : syncTarget.authorizationEpoch,
        projectionId       : syncTarget.projectionId,
        remoteEndpoint     : syncTarget.dwnUrl,
        tenantDid          : syncTarget.did,
      }, {
        handledThrough : { epoch: 'epoch', position: '1', streamId: 'stream' },
        quarantine     : [{
          encryptedPayload : 'corrupt',
          messageCid       : `pending-${syncTarget.authorizationEpoch}`,
          source           : {
            epoch      : 'epoch',
            messageCid : `pending-${syncTarget.authorizationEpoch}`,
            position   : '1',
            streamId   : 'stream',
          },
        }],
        settled: [],
      });
    }
    await internal._ledger.retireLink({
      authorizationEpoch : retired.authorizationEpoch,
      projectionId       : retired.projectionId,
      remoteEndpoint     : retired.dwnUrl,
      tenantDid          : retired.did,
    });
    const cover = sinon.stub().resolves();
    sinon.stub(internal._planner, 'getTargets').resolves([current, peer]);
    sinon.stub(internal._planner, 'lastResolutionComplete').get(() => true);
    sinon.stub(internal, 'ensureSession').resolves({
      session    : { cover },
      subscribed : false,
      target     : current,
    });
    sinon.stub(internal, 'disposeSession').resolves();
    const logicalTargetId = syncNextLogicalTargetId(current.did, current.projectionId);
    expect(await internal._ledger.getQuarantineForLogicalTarget(logicalTargetId)).toHaveLength(3);

    await engine.rebuildRemoteDirection({
      direction      : 'pull',
      remoteEndpoint : current.dwnUrl,
      tenantDid      : current.did,
    });

    const rebuilt = await internal._ledger.getLink({
      authorizationEpoch : current.authorizationEpoch,
      projectionId       : current.projectionId,
      remoteEndpoint     : current.dwnUrl,
      tenantDid          : current.did,
    });
    expect(rebuilt.pullHandledThrough).toBeUndefined();
    const rebuiltPeer = await internal._ledger.getLink({
      authorizationEpoch : peer.authorizationEpoch,
      projectionId       : peer.projectionId,
      remoteEndpoint     : peer.dwnUrl,
      tenantDid          : peer.did,
    });
    expect(rebuiltPeer.pullHandledThrough).toBeUndefined();
    expect(await internal._ledger.getQuarantineForLogicalTarget(logicalTargetId)).toEqual([]);
    expect(cover.calledOnceWith('pull')).toBe(true);
    await internal._ledger.deleteForTenant(current.did);
  });
});
