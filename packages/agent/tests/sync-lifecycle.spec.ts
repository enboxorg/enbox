import sinon from 'sinon';

import { Level } from 'level';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SyncEngineLevel lifecycle', () => {
  let db: Level<string, string>;

  beforeEach(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-lifecycle-spec');
    await db.open();
  });

  afterEach(async () => {
    sinon.restore();
    if (db.status === 'open') {
      await db.clear();
    }
    if (db.status !== 'closed') {
      await db.close();
    }
  });

  it('should stop scheduling and wait for an active sync before closing storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const syncStarted = createDeferred();
    const releaseSync = createDeferred();
    sinon.stub(engine as never, 'getSyncTargets').callsFake(async (): Promise<[]> => {
      syncStarted.resolve();
      await releaseSync.promise;
      return [];
    });

    const syncPromise = engine.sync();
    await syncStarted.promise;
    engine['_syncIntervalId'] = setInterval(() => {}, 60_000);

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(engine['_syncIntervalId']).toBeUndefined();
    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releaseSync.resolve();
    await Promise.all([syncPromise, closePromise]);

    expect(db.status).toBe('closed');
  });

  it('should wait for an active sync before clearing durable state', async () => {
    const engine = new SyncEngineLevel({ db });
    const registeredIdentities = db.sublevel<string, string>('registeredIdentities');
    await registeredIdentities.put('did:example:alice', JSON.stringify({ protocols: 'all' }));

    const syncStarted = createDeferred();
    const releaseSync = createDeferred();
    sinon.stub(engine as never, 'getSyncTargets').callsFake(async (): Promise<[]> => {
      syncStarted.resolve();
      await releaseSync.promise;
      return [];
    });

    const syncPromise = engine.sync();
    await syncStarted.promise;
    engine['_syncIntervalId'] = setInterval(() => {}, 60_000);

    const clearPromise = engine.clear();
    await Promise.resolve();

    expect(engine['_syncIntervalId']).toBeUndefined();
    expect(await engine.getIdentityOptions('did:example:alice')).toBeDefined();

    releaseSync.resolve();
    await Promise.all([syncPromise, clearPromise]);

    expect(await engine.getIdentityOptions('did:example:alice')).toBeUndefined();
    expect(db.status).toBe('open');
  });

  it('should keep storage open while teardown races a mid-feed push', async () => {
    const engine = new SyncEngineLevel({ db });
    const pushStarted = createDeferred();
    const releasePush = createDeferred();
    const target = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'authorization-1',
      did                : 'did:example:alice',
      dwnUrl             : 'https://dwn.example.com',
      projectionId       : '',
      scope              : { kind: 'full' as const },
    };
    const link = await engine['ledger'].getOrCreateLink({
      tenantDid          : target.did,
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
    });
    target.projectionId = link.projectionId;
    await engine['ledger'].setStatus(link, 'live');
    engine['_activeLinks'].set('active-link', link);

    const internal = engine as unknown as {
      pushLocalFeedEntry(
        runTarget: typeof target,
        entry: { messageCid: string },
        shouldContinue?: () => boolean,
      ): Promise<
        | { kind: 'aborted' }
        | { kind: 'failed'; failures: unknown[] }
        | { kind: 'pushed' }
        | { kind: 'skipped' }
      >;
    };
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    sinon.stub(engine as never, 'pullRemoteFeedForSyncTarget').resolves({});
    sinon.stub(engine as never, 'hasAdmissionDeadLetter').resolves(false);
    sinon.stub(engine as never, 'getQuotaBlockState').resolves(undefined);
    sinon.stub(engine as never, 'getQuotaBlockedInitialCidsForFeedEntry').resolves([]);
    sinon.stub(engine as never, 'pushMessages').callsFake(async (): Promise<{ failed: never[]; succeeded: string[] }> => {
      pushStarted.resolve();
      await releasePush.promise;
      return { failed: [], succeeded: ['cid-1'] };
    });
    sinon.stub(engine as never, 'pushLocalFeedForSyncTarget').callsFake(async (
      runTarget: typeof target,
      _options: unknown,
      shouldContinue?: () => boolean,
    ): Promise<Record<string, unknown>> => {
      const result = await internal.pushLocalFeedEntry(runTarget, { messageCid: 'cid-1' }, shouldContinue);
      if (result.kind === 'aborted') {
        return { aborted: true };
      }
      if (result.kind === 'failed') {
        return { hasActionableDiffs: true, pushFailures: result.failures };
      }
      return { hasActionableDiffs: result.kind === 'pushed', pushFailures: [] };
    });
    const transitionPushResult = sinon.spy(engine as never, 'transitionPushResult');

    const syncPromise = engine.sync();
    await pushStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    try {
      expect(engine['_activeLinks'].size).toBe(0);
      expect(transitionPushResult.called).toBe(false);
      expect(closeCompleted).toBe(false);
      expect(db.status).toBe('open');
    } finally {
      releasePush.resolve();
      await Promise.all([syncPromise, closePromise]);
    }

    expect(transitionPushResult.calledOnce).toBe(true);
    expect(db.status).toBe('closed');
  });

  it('should wait for a fire-and-forget repair before closing storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const repairStarted = createDeferred();
    const releaseRepair = createDeferred();
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const link = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-1',
      connectivity       : 'unknown',
      projectionId       : 'projection-1',
      pull               : {},
      push               : {},
      remoteEndpoint     : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      status             : 'initializing',
      tenantDid          : 'did:example:alice',
    };

    engine['_activeLinks'].set(linkKey, link as never);
    sinon.stub(engine as never, 'setLinkOfflineStatus').callsFake(async (): Promise<void> => {
      link.status = 'repairing';
    });
    sinon.stub(engine as never, 'doRepairLink').callsFake(async (): Promise<void> => {
      repairStarted.resolve();
      await releaseRepair.promise;
    });

    await (engine as unknown as {
      transitionToRepairing(linkKey: string, linkState: unknown): Promise<void>;
    }).transitionToRepairing(linkKey, link);
    await repairStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releaseRepair.resolve();
    await closePromise;

    expect(db.status).toBe('closed');
  });

  it('should wait for a scheduled reconcile before closing storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const reconcileStarted = createDeferred();
    const releaseReconcile = createDeferred();
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const link = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-1',
      connectivity       : 'online',
      projectionId       : 'projection-1',
      pull               : {},
      push               : {},
      remoteEndpoint     : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      status             : 'live',
      tenantDid          : 'did:example:alice',
    };

    engine['_activeLinks'].set(linkKey, link as never);
    sinon.stub(engine as never, 'doReconcileLink').callsFake(async (): Promise<void> => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
    });

    const scheduled = (engine as unknown as {
      scheduleReconcile(linkKey: string, delay: number): boolean;
    }).scheduleReconcile(linkKey, 0);
    expect(scheduled).toBe(true);
    await reconcileStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releaseReconcile.resolve();
    await closePromise;

    expect(db.status).toBe('closed');
  });

  it('should wait for a scheduled push flush before closing storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const pushStarted = createDeferred();
    const releasePush = createDeferred();
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const pushRuntime = {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example.com',
      entries    : [],
      retryCount : 0,
    };

    engine['_pushRuntimes'].set(linkKey, pushRuntime as never);
    sinon.stub(engine as never, 'flushPendingPushesForLink').callsFake(async (): Promise<void> => {
      pushStarted.resolve();
      await releasePush.promise;
    });

    (engine as unknown as {
      schedulePushRetry(
        targetKey: string,
        runtime: unknown,
        pending: { entries: Array<{ cid: string }>; retryCount: number },
      ): void;
    }).schedulePushRetry(linkKey, pushRuntime, { entries: [{ cid: 'cid-1' }], retryCount: 0 });
    await pushStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releasePush.resolve();
    await closePromise;

    expect(db.status).toBe('closed');
  });

  it('should serialize stop behind an in-progress start transition', async () => {
    const engine = new SyncEngineLevel({ db });
    const startEntered = createDeferred();
    const releaseStart = createDeferred();
    sinon.stub(engine as never, 'startLiveSync').callsFake(async (): Promise<void> => {
      startEntered.resolve();
      await releaseStart.promise;
    });

    const startPromise = engine.startSync({ interval: '5m', mode: 'live' });
    await startEntered.promise;

    let stopCompleted = false;
    const stopPromise = engine.stopSync().then((): void => { stopCompleted = true; });
    await Promise.resolve();

    expect(stopCompleted).toBe(false);
    expect(engine['_syncMode']).toBe('live');

    releaseStart.resolve();
    await Promise.all([startPromise, stopPromise]);

    expect(engine['_syncMode']).toBeUndefined();
  });

  it('should ignore a stale live integrity callback after stop', async () => {
    const engine = new SyncEngineLevel({ db });
    const sync = sinon.stub(engine, 'sync').resolves();
    const generation = engine['_engineGeneration'];

    await engine.stopSync();
    await (engine as unknown as {
      runLiveIntegrityCheck(generation: number): Promise<void>;
    }).runLiveIntegrityCheck(generation);

    expect(sync.called).toBe(false);
  });
});
