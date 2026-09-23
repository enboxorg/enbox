import type { SyncEvent } from '../src/types/sync.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { DwnErrorCode } from '@enbox/dwn-sdk-js';
import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import { SyncEngineNext } from '../src/sync-next/engine.js';
import { SyncNextCatalog } from '../src/sync-next/catalog.js';
import { syncNextLinkKey } from '../src/sync-next/ledger-key.js';
import { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

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
    db = new Level<string, string>('__TESTDATA__/sync-next-engine-orchestration-v2-spec');
    await db.open();
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
      endpoint  : 'https://cancelled.example/path',
      completed : false,
      cancelled : true,
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

  it('should invalidate sibling target plans after catalog mutations', async () => {
    const dataPath = '__TESTDATA__/sync-next-catalog-wakes';
    const first = new SyncEngineNext({ dataPath, db });
    const second = new SyncEngineNext({ dataPath, db });
    const fakeAgent = { dwn: {}, permissions: {} } as never;
    first.agent = fakeAgent;
    second.agent = fakeAgent;
    sinon.stub(SyncScopeClosureValidator.prototype, 'validateClosure').resolves();
    const did = 'did:example:next-catalog-wake';
    let resolveSet!: () => void;
    let resolveRemove!: () => void;
    const setObserved = new Promise<void>(resolve => { resolveSet = resolve; });
    const removeObserved = new Promise<void>(resolve => { resolveRemove = resolve; });
    let wakes = 0;
    sinon.stub(second as any, 'scheduleLiveRefresh').callsFake((): void => {
      if (++wakes === 1) {
        resolveSet();
      } else {
        resolveRemove();
      }
    });

    try {
      await first.setIdentityOptions({ did, options: { protocols: ['https://proto.example'] } });
      await setObserved;
      await first.removeIdentity(did);
      await removeObserved;

      expect((second as any)._planner.topologyGeneration).toBe(2);
    } finally {
      for (const next of [first, second]) {
        next['_catalogChannel']?.close();
      }
    }
  });

  it('should remove a registration after confirming its approval is revoked', async () => {
    const grant = {
      grant: {
        id             : 'grant-a',
        grantor        : 'did:example:owner',
        grantee        : 'did:example:delegate',
        dateExpires    : '2040-01-01T00:00:00.000000Z',
        connectSession : { id: 'session-a', createdAt: '2026-01-01T00:00:00.000000Z' },
      },
    };
    const fetchGrants = sinon.stub();
    fetchGrants.onFirstCall().resolves([grant]);
    fetchGrants.onSecondCall().resolves([]);
    fetchGrants.onThirdCall().resolves([grant]);
    const identityStore = { delete: sinon.stub().resolves() };
    const beforePause = sinon.stub().resolves();
    const catalog = new SyncNextCatalog(
      {} as never,
      { fetchGrants } as never,
      identityStore as never,
      {} as never,
      {} as never,
      'pause-test',
    );

    expect(await catalog.pauseIdentity({
      did              : 'did:example:owner',
      delegateDid      : 'did:example:delegate',
      connectSessionId : 'session-a',
    }, beforePause)).toBe(true);
    expect(beforePause.calledOnce).toBe(true);
    expect(identityStore.delete.calledOnceWithExactly('did:example:owner')).toBe(true);
    expect(beforePause.calledBefore(identityStore.delete)).toBe(true);
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

  it('should coalesce subscription retries and honor Retry-After', async () => {
    const clock = sinon.useFakeTimers();
    const internal = engine as any;
    const refresh = sinon.stub(internal, 'scheduleLiveRefresh');
    internal._live = true;

    internal.scheduleLiveRetry(new RateLimitError(1));
    internal.scheduleLiveRetry(new RateLimitError(1));
    await clock.tickAsync(999);
    expect(refresh.notCalled).toBe(true);
    await clock.tickAsync(1);
    expect(refresh.calledOnce).toBe(true);

    internal._live = false;
  });

  it('should retry only the selected normalized remote', async () => {
    const internal = engine as any;
    const cover = sinon.stub(internal, 'runCoveringSync').resolves();
    const clear = sinon.spy(internal._endpointGate, 'clear');

    await engine.retryRemoteNow('did:example:retry', 'https://retry.example/path/?ignored=1');

    expect(clear.calledOnceWithExactly('https://retry.example/path')).toBe(true);
    expect(cover.calledOnceWithExactly(
      undefined,
      { did: 'did:example:retry' },
      'https://retry.example/path',
    )).toBe(true);
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

  it('should cancel a coalesced covering run when the runtime stops', async () => {
    const syncTarget = target('did:example:stop', 'https://stop.example');
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const cover = sinon.stub().callsFake(async (_direction, shouldContinue): Promise<void> => {
      markStarted();
      await firstGate;
      if (!shouldContinue()) {
        throw new DOMException('Covering sync cancelled.', 'AbortError');
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
    const queued = engine.sync('pull');
    const stopping = engine.stopSync();
    const firstError = first.catch((error: unknown): unknown => error);
    const queuedError = queued.catch((error: unknown): unknown => error);
    releaseFirst();

    const [firstFailure, queuedFailure] = await Promise.all([firstError, queuedError, stopping]);
    expect(firstFailure).toBeInstanceOf(AggregateError);
    expect(queuedFailure).toBe(firstFailure);
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

});
