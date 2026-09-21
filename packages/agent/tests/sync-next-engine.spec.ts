import type { SyncEvent } from '../src/types/sync.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineNext } from '../src/sync-next/engine.js';

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

  it('should serialize covering work per endpoint while independent endpoints overlap', async () => {
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

    expect(maxShared).toBe(1);
    expect(maxTotal).toBe(2);
  });
});
