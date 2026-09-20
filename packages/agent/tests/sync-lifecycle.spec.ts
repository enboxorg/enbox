import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncLinkController } from '../src/sync-link-controller.js';
import type { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { Level } from 'level';
import { runWithCrossContextLock } from '@enbox/common';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLinkKey } from '../src/sync-link-key.js';
import { computeProjectionId } from '../src/types/sync.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRuntime } from '../src/sync-runtime.js';
import { SyncPushFailuresError, SyncRunCancelledError } from '../src/sync-runtime-errors.js';

import { deferred as createDeferred } from './utils/deferred.js';

function getScopeClosureValidator(engine: SyncEngineLevel): SyncScopeClosureValidator {
  return (engine as unknown as { _scopeClosureValidator: SyncScopeClosureValidator })._scopeClosureValidator;
}

function activateAdministrativeLink(
  engine: SyncEngineLevel,
  did: string,
  status: 'initializing',
): { controller: SyncLinkController; target: SyncTarget } {
  const target: SyncTarget = {
    did,
    dwnUrl             : 'https://dwn.example.com',
    scope              : { kind: 'full' },
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    projectionId       : 'projection-id',
  };
  const link: ReplicationLinkState = {
    authorization      : target.authorization,
    authorizationEpoch : target.authorizationEpoch,
    connectivity       : 'unknown',
    projectionId       : target.projectionId,
    pull               : {},
    push               : {},
    remoteEndpoint     : target.dwnUrl,
    scope              : target.scope,
    status,
    tenantDid          : target.did,
  };
  const linkKey = `${target.did}^${target.dwnUrl}^${target.projectionId}^${target.authorizationEpoch}`;
  const controller = (engine as unknown as {
    activateLink(key: string, state: ReplicationLinkState): SyncLinkController;
  }).activateLink(linkKey, link);
  return { controller, target };
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
    const runtime = engine['_runtime'];
    runtime.armInterval('syncInterval', () => {}, 60_000);

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(runtime.disposed).toBe(true);
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
    const runtime = engine['_runtime'];
    runtime.armInterval('syncInterval', () => {}, 60_000);

    const clearPromise = engine.clear();
    await Promise.resolve();

    expect(runtime.disposed).toBe(true);
    expect(await engine.getIdentityOptions('did:example:alice')).toBeDefined();

    releaseSync.resolve();
    await Promise.all([syncPromise, clearPromise]);

    expect(await engine.getIdentityOptions('did:example:alice')).toBeUndefined();
    expect(db.status).toBe('open');
  });

  it('should time out close without closing storage later after the active sync settles', async () => {
    const clock = sinon.useFakeTimers();
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
    const closePromise = engine.close({ timeout: 100 });
    const closeOutcome = closePromise.catch((error: unknown): unknown => error);

    await clock.tickAsync(100);
    expect((await closeOutcome as Error).message).toContain('within 100 milliseconds');
    expect(db.status).toBe('open');

    releaseSync.resolve();
    await syncPromise;
    await clock.tickAsync(0);
    expect(db.status).toBe('open');

    await engine.close({ timeout: 100 });
    expect(db.status).toBe('closed');
  });

  it('should retain a timed-out subscription close across lifecycle retries', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const closeStarted = createDeferred();
    const releaseClose = createDeferred();
    const { controller } = activateAdministrativeLink(engine, 'did:example:alice', 'initializing');
    controller.setLiveSubscription({
      close: async (): Promise<void> => {
        closeStarted.resolve();
        await releaseClose.promise;
      },
    });

    const closePromise = engine.close({ timeout: 100 });
    const closeOutcome = closePromise.catch((error: unknown): unknown => error);
    await closeStarted.promise;
    await clock.tickAsync(100);

    expect((await closeOutcome as Error).message).toContain('Live subscriptions did not close');
    expect(db.status).toBe('open');

    const retryPromise = engine.close({ timeout: 100 });
    const retryOutcome = retryPromise.catch((error: unknown): unknown => error);
    await clock.tickAsync(100);

    expect((await retryOutcome as Error).message).toContain('Live subscriptions did not close');
    expect(db.status).toBe('open');

    releaseClose.resolve();
    await clock.tickAsync(0);
    expect(db.status).toBe('open');

    await engine.close({ timeout: 100 });
    expect(db.status).toBe('closed');
  });

  it('should share one close deadline across subscription and sync-lock waits', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const closeStarted = createDeferred();
    const releaseClose = createDeferred();
    const { controller } = activateAdministrativeLink(engine, 'did:example:alice', 'initializing');
    controller.setLiveSubscription({
      close: async (): Promise<void> => {
        closeStarted.resolve();
        await releaseClose.promise;
      },
    });
    expect(engine['_lifecycle'].tryAcquireSync()).toBe(true);

    let closeSettled = false;
    const closePromise = engine.close({ timeout: 100 });
    const closeOutcome = closePromise.then(
      (): unknown => { closeSettled = true; },
      (error: unknown): unknown => {
        closeSettled = true;
        return error;
      },
    );
    await closeStarted.promise;
    await clock.tickAsync(80);
    releaseClose.resolve();
    await clock.tickAsync(0);

    await clock.tickAsync(19);
    expect(closeSettled).toBe(false);
    await clock.tickAsync(1);

    expect((await closeOutcome as Error).message).toContain('within 100 milliseconds');
    expect(db.status).toBe('open');
    engine['_lifecycle'].releaseSync();
    await clock.tickAsync(0);
    expect(db.status).toBe('open');
  });

  it('should never run a close that times out behind an earlier lifecycle transition', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const startEntered = createDeferred();
    const releaseStart = createDeferred();
    sinon.stub(engine as never, 'startLiveSync').callsFake(async (): Promise<void> => {
      startEntered.resolve();
      await releaseStart.promise;
    });

    const startPromise = engine.startSync({ interval: '5m' });
    await startEntered.promise;
    const closePromise = engine.close({ timeout: 100 });
    const closeOutcome = closePromise.catch((error: unknown): unknown => error);
    await clock.tickAsync(100);

    expect((await closeOutcome as Error).message).toContain('Earlier lifecycle transition');
    expect(db.status).toBe('open');

    releaseStart.resolve();
    await startPromise;
    await clock.tickAsync(0);
    expect(db.status).toBe('open');

    await engine.close({ timeout: 100 });
    expect(db.status).toBe('closed');
  });

  it('should time out clear without deleting durable state later after background work settles', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    const releaseTask = createDeferred();
    const taskStarted = createDeferred();
    await engine.setIdentityOptions({ did, options: { protocols: 'all' } });

    const task = engine['_lifecycle'].runBackgroundTask(async (): Promise<void> => {
      taskStarted.resolve();
      await releaseTask.promise;
    });
    await taskStarted.promise;

    const clearPromise = engine.clear({ timeout: 100 });
    const clearOutcome = clearPromise.catch((error: unknown): unknown => error);
    await clock.tickAsync(100);

    expect((await clearOutcome as Error).message).toContain('within 100 milliseconds');
    expect(await engine.getIdentityOptions(did)).toBeDefined();

    releaseTask.resolve();
    await task;
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toBeDefined();

    await engine.clear({ timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toBeUndefined();
  });

  it('should reject an invalid lifecycle timeout before changing runtime or storage state', async () => {
    const engine = new SyncEngineLevel({ db });
    const runtime = engine['_runtime'];

    await expect(engine.close({ timeout: Number.POSITIVE_INFINITY })).rejects.toThrow(
      'Lifecycle timeout must be between 0 and 2147483647 milliseconds',
    );

    expect(engine['_runtime']).toBe(runtime);
    expect(runtime.disposed).toBe(false);
    expect(db.status).toBe('open');
  });

  it('should cancel a registration that times out behind another sync owner', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    expect(engine['_lifecycle'].tryAcquireSync()).toBe(true);

    const registration = engine.setIdentityOptions(
      { did, options: { protocols: 'all' } },
      { timeout: 100 },
    );
    const registrationOutcome = registration.catch((error: unknown): unknown => error);
    await clock.tickAsync(100);

    expect((await registrationOutcome as Error).message).toContain('within 100 milliseconds');
    engine['_lifecycle'].releaseSync();
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toBeUndefined();

    await engine.setIdentityOptions({ did, options: { protocols: 'all' } }, { timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toBeDefined();
  });

  it('should cancel a registration that times out behind a cross-context identity mutation', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    const releaseLock = createDeferred();
    const lockStarted = createDeferred();
    const lockName = `enbox:sync-identity:${engine['_lockNamespace']}:${did}`;
    const heldLock = runWithCrossContextLock(lockName, async (): Promise<void> => {
      lockStarted.resolve();
      await releaseLock.promise;
    });
    await lockStarted.promise;

    const registration = engine.setIdentityOptions(
      { did, options: { protocols: 'all' } },
      { timeout: 100 },
    );
    const registrationOutcome = registration.catch((error: unknown): unknown => error);
    await clock.tickAsync(100);

    expect((await registrationOutcome as Error).message).toContain('within 100 milliseconds');
    releaseLock.resolve();
    await heldLock;
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toBeUndefined();

    await engine.setIdentityOptions({ did, options: { protocols: 'all' } }, { timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toBeDefined();
  });

  it('should not persist a registration after its preparation times out', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    const releaseValidation = createDeferred();
    const validationStarted = createDeferred();
    sinon.stub(getScopeClosureValidator(engine), 'validateClosure').callsFake(async (): Promise<void> => {
      validationStarted.resolve();
      await releaseValidation.promise;
    });

    const registration = engine.setIdentityOptions(
      { did, options: { protocols: 'all' } },
      { timeout: 100 },
    );
    const registrationOutcome = registration.catch((error: unknown): unknown => error);
    await validationStarted.promise;
    await clock.tickAsync(100);

    expect((await registrationOutcome as Error).message).toContain('preparation did not complete');
    expect(await engine.getIdentityOptions(did)).toBeUndefined();

    releaseValidation.resolve();
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toBeUndefined();

    await engine.setIdentityOptions({ did, options: { protocols: 'all' } }, { timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toBeDefined();
  });

  it('should preserve an identity when stopped-runtime work does not drain before unregister timeout', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    const releaseTask = createDeferred();
    const taskStarted = createDeferred();
    await engine.setIdentityOptions({ did, options: { protocols: 'all' } });

    const taskGroup = engine['_lifecycle'].getIdentityTaskGroup(did);
    const settleStarted = createDeferred();
    const settleTaskGroup = taskGroup.settle.bind(taskGroup);
    sinon.stub(taskGroup, 'settle').callsFake(async (timeout?: number): Promise<boolean> => {
      settleStarted.resolve();
      return settleTaskGroup(timeout);
    });
    const task = engine['_lifecycle'].runIdentityTask(taskGroup, async (): Promise<void> => {
      taskStarted.resolve();
      await releaseTask.promise;
    });
    await taskStarted.promise;

    const unregister = engine.removeIdentity(did, { timeout: 100 });
    const unregisterOutcome = unregister.catch((error: unknown): unknown => error);
    await settleStarted.promise;
    await clock.tickAsync(100);

    expect((await unregisterOutcome as Error).message).toContain('within 100 milliseconds');
    expect(await engine.getIdentityOptions(did)).toBeDefined();

    releaseTask.resolve();
    await task;
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toBeDefined();

    await engine.removeIdentity(did, { timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toBeUndefined();
  });

  it('should finish unregister atomically after its preparation consumes almost all of the deadline', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    await engine.setIdentityOptions({ did, options: { protocols: 'all' } });

    const identityStore = engine['_identityStore'];
    const getIdentity = identityStore.get.bind(identityStore);
    const getIdentityStub = sinon.stub(identityStore, 'get').callsFake(getIdentity);
    getIdentityStub.onFirstCall().callsFake(async (identityDid: string): Promise<Awaited<ReturnType<typeof getIdentity>>> => {
      await new Promise(resolve => { setTimeout(resolve, 99); });
      return getIdentity(identityDid);
    });

    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    sinon.stub(engine['_quotaManager'], 'clearTenant').callsFake(async (): Promise<void> => {
      commitStarted.resolve();
      await releaseCommit.promise;
    });
    sinon.stub(engine as never, 'pruneSupersededDurableLinksForIdentity').resolves();

    let unregisterSettled = false;
    const unregister = engine.removeIdentity(did, { timeout: 100 }).then((): void => {
      unregisterSettled = true;
    });
    await clock.tickAsync(99);
    await commitStarted.promise;

    await clock.tickAsync(1_000);
    expect(unregisterSettled).toBe(false);
    expect(await getIdentity(did)).toBeDefined();

    releaseCommit.resolve();
    await unregister;

    expect(unregisterSettled).toBe(true);
    expect(await getIdentity(did)).toBeUndefined();
  });

  it('should preserve old identity options when live work does not drain before update timeout', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    const oldOptions = { protocols: 'all' as const };
    const updatedOptions = { protocols: 'all' as const, delegateDid: 'did:example:delegate' };
    const releaseTask = createDeferred();
    const taskStarted = createDeferred();
    await engine.setIdentityOptions({ did, options: oldOptions });
    sinon.stub(getScopeClosureValidator(engine), 'validateClosure').resolves();
    sinon.stub(engine as never, 'tryPruneSupersededDurableLinksForRegisteredIdentity').resolves();

    const taskGroup = engine['_lifecycle'].getIdentityTaskGroup(did);
    const settleStarted = createDeferred();
    const settleTaskGroup = taskGroup.settle.bind(taskGroup);
    sinon.stub(taskGroup, 'settle').callsFake(async (timeout?: number): Promise<boolean> => {
      settleStarted.resolve();
      return settleTaskGroup(timeout);
    });
    const task = engine['_lifecycle'].runIdentityTask(taskGroup, async (): Promise<void> => {
      taskStarted.resolve();
      await releaseTask.promise;
    });
    await taskStarted.promise;

    const update = engine.setIdentityOptions(
      { did, options: updatedOptions },
      { timeout: 100 },
    );
    const updateOutcome = update.catch((error: unknown): unknown => error);
    await settleStarted.promise;
    await clock.tickAsync(100);

    expect((await updateOutcome as Error).message).toContain('within 100 milliseconds');
    expect(await engine.getIdentityOptions(did)).toEqual(oldOptions);

    releaseTask.resolve();
    await task;
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toEqual(oldOptions);

    await engine.setIdentityOptions({ did, options: updatedOptions }, { timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toEqual(updatedOptions);
  });

  it('should keep storage open while stop races a mid-feed push', async () => {
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
    const link = await engine['replicationLinkStore'].getOrCreateLink({
      tenantDid          : target.did,
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
    });
    target.projectionId = link.projectionId;
    await engine['replicationLinkStore'].setStatus(link, 'live');
    engine['activateLink']('active-link', link);

    const internal = engine as unknown as {
      pushLocalFeedEntry(
        runTarget: typeof target,
        entry: { messageCid: string },
        pushContext: { pushFeedEntry(): Promise<{ acknowledged: never[]; failed: never[]; succeeded: string[] }> },
        shouldContinue?: () => boolean,
      ): Promise<
        | { kind: 'aborted' }
        | { kind: 'failed'; failures: unknown[] }
        | { kind: 'processed' }
      >;
    };
    const durableFeedReconciler = engine['_durableFeedReconciler'];
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    sinon.stub(durableFeedReconciler, 'pull').resolves({});
    sinon.stub(engine as never, 'hasPushDeadLetter').resolves(false);
    sinon.stub(engine['_quotaManager'], 'getState').resolves(undefined);
    sinon.stub(engine as never, 'getQuotaBlockedInitialCidsForFeedEntry').resolves([]);
    const pushContext = {
      pushFeedEntry: async (): Promise<{ acknowledged: never[]; failed: never[]; succeeded: string[] }> => {
        pushStarted.resolve();
        await releasePush.promise;
        return { acknowledged: [], failed: [], succeeded: ['cid-1'] };
      },
    };
    sinon.stub(durableFeedReconciler, 'push').callsFake(async (
      runTarget: typeof target,
      _link: typeof link,
      _options: unknown,
      shouldContinue?: () => boolean,
    ): Promise<Record<string, unknown>> => {
      const result = await internal.pushLocalFeedEntry(runTarget, { messageCid: 'cid-1' }, pushContext, shouldContinue);
      if (result.kind === 'aborted') {
        return { aborted: true };
      }
      if (result.kind === 'failed') {
        return { pushFailures: result.failures };
      }
      return { pushFailures: [] };
    });
    const applyPushResult = sinon.spy(engine['_quotaManager'], 'applyPushResult');

    const syncPromise = engine.sync();
    await pushStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    try {
      expect(engine['_linkControllers'].size).toBe(0);
      expect(applyPushResult.called).toBe(false);
      expect(closeCompleted).toBe(false);
      expect(db.status).toBe('open');
    } finally {
      releasePush.resolve();
      await Promise.all([syncPromise, closePromise]);
    }

    expect(applyPushResult.calledOnce).toBe(true);
    expect(db.status).toBe('closed');
  });

  it('should wait for fire-and-forget pull work before closing storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const pullStarted = createDeferred();
    const releasePull = createDeferred();
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
      status             : 'live',
      tenantDid          : 'did:example:alice',
    };

    const controller = engine['activateLink'](linkKey, link as never);
    controller.markReplicationReady();
    sinon.stub(engine as never, 'reconcileOwnedTarget').callsFake(async (): Promise<{ pullDrained: true; pullLocallyComplete: true }> => {
      pullStarted.resolve();
      await releasePull.promise;
      return { pullDrained: true, pullLocallyComplete: true };
    });

    (engine as any).requestLinkDirection(controller, 'pull');
    await pullStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releasePull.resolve();
    await closePromise;

    expect(db.status).toBe('closed');
  });

  it('should retry only a failed direction and keep retry delay in memory', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const tenantDid = 'did:example:direction-retry';
    const remoteEndpoint = 'https://direction-retry.example.com';
    const link = await internal.replicationLinkStore.getOrCreateLink({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint,
      scope              : { kind: 'full' },
      tenantDid,
    });
    await internal.replicationLinkStore.setStatus(link, 'live');
    const linkKey = buildLinkKey(tenantDid, remoteEndpoint, link.projectionId, link.authorizationEpoch);
    internal._runtime = new SyncRuntime(true);
    const controller = internal.activateLink(linkKey, link);
    controller.markReplicationReady();
    let pullAttempts = 0;
    let pushAttempts = 0;
    sinon.stub(internal, 'reconcileOwnedTarget').callsFake(async (
      _controller: SyncLinkController,
      _target: SyncTarget,
      options: { direction: 'pull' | 'push' },
    ): Promise<Record<string, unknown>> => {
      if (options.direction === 'pull') {
        pullAttempts++;
        if (pullAttempts === 1) {
          throw new Error('offline');
        }
        return { pullDrained: true, pullLocallyComplete: true };
      }
      pushAttempts++;
      return { pushFailures: [] };
    });
    sinon.stub(console, 'error');

    internal.requestLinkDirection(controller, 'pull');
    internal.requestLinkDirection(controller, 'push');
    expect(await internal._lifecycle.waitForBackgroundTasks()).toBe(true);

    expect(pullAttempts).toBe(1);
    expect(pushAttempts).toBe(1);
    expect(internal._runtime.hasTimer(`syncRetry:pull:${linkKey}`)).toBe(true);
    expect(internal._runtime.hasTimer(`syncRetry:push:${linkKey}`)).toBe(false);
    expect((await internal.replicationLinkStore.getAllLinks())[0]).not.toHaveProperty('recovery');

    await clock.tickAsync(1_000);
    expect(await internal._lifecycle.waitForBackgroundTasks()).toBe(true);

    expect(pullAttempts).toBe(2);
    expect(pushAttempts).toBe(1);
    expect(internal._runtime.hasTimer(`syncRetry:pull:${linkKey}`)).toBe(false);

    await engine.close();
  });

  it('should retain a coalesced wake when a caller-specific reconciliation aborts', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const target: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : 'did:example:aborted-call',
      dwnUrl             : 'https://aborted-call.example.com',
      projectionId       : 'projection-id',
      scope              : { kind: 'full' },
    };
    const link: ReplicationLinkState = {
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      connectivity       : 'online',
      projectionId       : target.projectionId,
      pull               : {},
      push               : {},
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      status             : 'live',
      tenantDid          : target.did,
    };
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    internal._runtime = new SyncRuntime(true);
    const controller = internal.activateLink(linkKey, link);
    controller.markReplicationReady();
    controller.setRetryNotBefore(['pull'], Date.now() + 60_000);
    controller.executor.request('pull');
    const reconcile = sinon.stub(internal, 'reconcileOwnedTarget').resolves({ aborted: true });
    sinon.stub(internal, 'getOrCreateReplicationLink').resolves(link);

    expect(await internal.reconcileTarget(target, { direction: 'pull' })).toEqual({ aborted: true });

    expect(reconcile.calledOnce).toBe(true);
    expect(controller.executor.hasPending('pull')).toBe(true);
    expect(internal._runtime.hasTimer(`syncRetry:pull:${linkKey}`)).toBe(true);
    await engine.close();
  });

  it('should preserve a quota-owned Retry-After timer across unrelated push success', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const target: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : 'did:example:quota-timer',
      dwnUrl             : 'https://quota-timer.example.com',
      projectionId       : 'projection-id',
      scope              : { kind: 'full' },
    };
    const link: ReplicationLinkState = {
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      connectivity       : 'online',
      projectionId       : target.projectionId,
      pull               : {},
      push               : {},
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      status             : 'live',
      tenantDid          : target.did,
    };
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    const nextProbeAt = new Date(Date.now() + 60_000).toISOString();
    internal._runtime = new SyncRuntime(true);
    const controller = internal.activateLink(linkKey, link);
    controller.markReplicationReady();
    sinon.stub(internal._quotaManager, 'getNextProbeAtForTarget').resolves(nextProbeAt);
    sinon.stub(internal, 'reconcileOwnedTarget').resolves({ pushFailures: [] });
    internal.scheduleQuotaProbeForActiveLink(linkKey, link, nextProbeAt);

    internal.requestLinkDirection(controller, 'push');
    expect(await internal._lifecycle.waitForBackgroundTasks()).toBe(true);

    expect(internal._runtime.hasTimer(`syncQuotaProbe:${linkKey}`)).toBe(true);
    expect(internal._runtime.hasTimer(`syncRetry:push:${linkKey}`)).toBe(false);
    await engine.close();
  });

  it('should close only the failed subscription direction', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const tenantDid = 'did:example:subscription-failure';
    const remoteEndpoint = 'https://subscription-failure.example.com';
    const link = await internal.replicationLinkStore.getOrCreateLink({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint,
      scope              : { kind: 'full' },
      tenantDid,
    });
    await internal.replicationLinkStore.setStatus(link, 'live');
    const linkKey = buildLinkKey(tenantDid, remoteEndpoint, link.projectionId, link.authorizationEpoch);
    internal._runtime = new SyncRuntime(true);
    const controller = internal.activateLink(linkKey, link);
    const closeStarted = createDeferred();
    const releaseClose = createDeferred();
    const closePull = sinon.stub().callsFake(async (): Promise<void> => {
      closeStarted.resolve();
      await releaseClose.promise;
    });
    const closePush = sinon.stub().resolves();
    controller.setLiveSubscription({ close: closePull });
    controller.setLocalSubscription({ close: closePush });
    const request = sinon.stub(internal, 'requestLinkDirection');
    const reopen = sinon.stub(internal, 'scheduleSubscriptionReopen');

    const failure = internal.handleLinkSubscriptionFailure(controller, 'pull');
    await closeStarted.promise;

    expect(closePull.calledOnce).toBe(true);
    expect(closePush.notCalled).toBe(true);
    expect(controller.hasLiveSubscription).toBe(false);
    expect(controller.hasLocalSubscription).toBe(true);
    expect(request.calledOnceWithExactly(controller, 'pull')).toBe(true);
    expect(reopen.calledOnceWithExactly(controller, 'pull')).toBe(true);
    expect(controller.link.status).toBe('live');
    expect(controller.link.connectivity).toBe('offline');
    releaseClose.resolve();
    await failure;

    await engine.close();
  });

  it('should run Retry now through the normal reconciler without a live controller', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const tenantDid = 'did:example:controllerless-retry';
    const scope = { kind: 'full' } as const;
    const target: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : tenantDid,
      dwnUrl             : 'https://controllerless-retry.example.com',
      projectionId       : await computeProjectionId(tenantDid, scope),
      scope,
    };
    sinon.stub(internal, 'getSyncTargets').resolves([target]);
    const reconcile = sinon.stub(internal._durableFeedReconciler, 'reconcile').resolves({
      pullDrained         : true,
      pullLocallyComplete : true,
      pushFailures        : [],
    });

    await engine.retryRemoteNow(target.did, target.dwnUrl);

    expect((await internal.replicationLinkStore.getAllLinks()).filter(
      (link: ReplicationLinkState) => link.tenantDid === target.did,
    )).toHaveLength(1);
    expect(reconcile.calledOnceWithMatch(
      target,
      sinon.match({ tenantDid, remoteEndpoint: target.dwnUrl }),
      undefined,
    )).toBe(true);
    await engine.close();
  });

  it('should let Retry now subsume an existing delayed work mark', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const target: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : 'did:example:active-retry',
      dwnUrl             : 'https://active-retry.example.com',
      projectionId       : 'projection-id',
      scope              : { kind: 'full' },
    };
    const link: ReplicationLinkState = {
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      connectivity       : 'online',
      projectionId       : target.projectionId,
      pull               : {},
      push               : {},
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      status             : 'live',
      tenantDid          : target.did,
    };
    const linkKey = buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
    internal._runtime = new SyncRuntime(true);
    const controller = internal.activateLink(linkKey, link);
    controller.markReplicationReady();
    controller.setLiveSubscription({ close: sinon.stub().resolves() });
    controller.setLocalSubscription({ close: sinon.stub().resolves() });
    controller.setRetryNotBefore(['pull'], Date.now() + 60_000);
    controller.executor.request('pull');
    sinon.stub(internal, 'getSyncTargets').resolves([target]);
    sinon.stub(internal, 'getOrCreateReplicationLink').resolves(link);
    const reconcile = sinon.stub(internal, 'reconcileOwnedTarget').resolves({
      pullDrained         : true,
      pullLocallyComplete : true,
      pushFailures        : [],
    });

    await engine.retryRemoteNow(target.did, target.dwnUrl);

    expect(reconcile.calledOnce).toBe(true);
    expect(controller.executor.hasPending('pull')).toBe(false);
    await engine.close();
  });

  it('should not retry a durable authorization pause without new authority', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const tenantDid = 'did:example:paused-retry';
    const remoteEndpoint = 'https://paused-retry.example.com';
    const link = await internal.replicationLinkStore.getOrCreateLink({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint,
      scope              : { kind: 'full' },
      tenantDid,
    });
    await internal.replicationLinkStore.setStatus(link, 'paused');
    const target: SyncTarget = {
      authorization      : link.authorization,
      authorizationEpoch : link.authorizationEpoch,
      did                : link.tenantDid,
      dwnUrl             : link.remoteEndpoint,
      projectionId       : link.projectionId,
      scope              : link.scope,
    };
    sinon.stub(internal, 'getSyncTargets').resolves([target]);
    const reconcile = sinon.stub(internal._durableFeedReconciler, 'reconcile').resolves({});

    await engine.retryRemoteNow(tenantDid, remoteEndpoint);

    expect(reconcile.notCalled).toBe(true);
    expect(link.status).toBe('paused');
    await engine.close();
  });

  it('should retain controller-less push obligations after Retry now fails', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const tenantDid = 'did:example:push-retry';
    const remoteEndpoint = 'https://push-retry.example.com';
    const link = await internal.replicationLinkStore.getOrCreateLink({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      remoteEndpoint,
      scope              : { kind: 'full' },
      tenantDid,
    });
    const target: SyncTarget = {
      authorization      : link.authorization,
      authorizationEpoch : link.authorizationEpoch,
      did                : link.tenantDid,
      dwnUrl             : link.remoteEndpoint,
      projectionId       : link.projectionId,
      scope              : link.scope,
    };
    sinon.stub(internal, 'getSyncTargets').resolves([target]);
    const reconcile = sinon.stub(internal._durableFeedReconciler, 'reconcile');
    reconcile.onFirstCall().resolves({
      pullDrained         : true,
      pullLocallyComplete : true,
      pushFailures        : [{ cid: 'rejected-cid', detail: 'remote unavailable' }],
    });
    reconcile.onSecondCall().resolves({
      pullDrained         : true,
      pullLocallyComplete : true,
      pushFailures        : [],
    });

    await expect(engine.retryRemoteNow(tenantDid, remoteEndpoint)).rejects.toBeInstanceOf(SyncPushFailuresError);
    expect(reconcile.calledOnce).toBe(true);
    expect((await internal.replicationLinkStore.getAllLinks()).find(
      (storedLink: ReplicationLinkState) => storedLink.tenantDid === tenantDid,
    )).toMatchObject({
      push   : {},
      status : 'initializing',
    });

    await engine.retryRemoteNow(tenantDid, remoteEndpoint);
    expect(reconcile.callCount).toBe(2);

    await engine.close();
  });

  it('should keep controller-less followed-link retries pull-only', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const sourceDid = 'did:example:followed-source';
    const remoteEndpoint = 'https://followed-source.example.com';
    const link = await internal.replicationLinkStore.getOrCreateLink({
      authorization: {
        kind         : 'role',
        actorDid     : 'did:example:member',
        protocolRole : 'notebook/viewer',
        roleRecordId : 'role-record',
      },
      authorizationEpoch : 'role-epoch',
      remoteEndpoint,
      scope              : {
        kind          : 'context',
        contextId     : 'notebook-a',
        protocol      : 'https://example.com/notebooks',
        protocolPaths : ['notebook', 'notebook/page'],
      },
      tenantDid: sourceDid,
    });
    const target: SyncTarget = {
      authorization      : link.authorization,
      authorizationEpoch : link.authorizationEpoch,
      did                : link.tenantDid,
      dwnUrl             : link.remoteEndpoint,
      projectionId       : link.projectionId,
      scope              : link.scope,
    };
    sinon.stub(internal, 'getSyncTargets').resolves([target]);
    const pull = sinon.stub(internal._durableFeedReconciler, 'pull').resolves({ pullDrained: true });
    const pushLocalPages = sinon.stub(internal._durableFeedReconciler, 'pushLocalPages').resolves({});

    await engine.retryRemoteNow(sourceDid, remoteEndpoint);

    expect(pull.calledOnce).toBe(true);
    expect(pushLocalPages.notCalled).toBe(true);

    await engine.close();
  });

  it('should keep the lifecycle lock until every started endpoint retry settles', async () => {
    const engine = new SyncEngineLevel({ db });
    const internal = engine as any;
    const tenantDid = 'did:example:parallel-retry';
    const remoteEndpoint = 'https://parallel-retry.example.com';
    const targets: SyncTarget[] = ['a', 'b'].map((suffix) => ({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : tenantDid,
      dwnUrl             : remoteEndpoint,
      projectionId       : `projection-${suffix}`,
      scope              : { kind: 'protocolSet', protocols: [`https://example.com/protocol-${suffix}`] },
    }));
    sinon.stub(internal, 'getSyncTargets').resolves(targets);
    sinon.stub(internal, 'getExistingReplicationLink').callsFake(async (target: SyncTarget) => ({
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      connectivity       : 'unknown',
      projectionId       : target.projectionId,
      pull               : {},
      push               : {},
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      status             : 'initializing',
      tenantDid          : target.did,
    }));
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred();
    const failure = new Error('first retry failed');
    sinon.stub(internal, 'reconcileTarget').callsFake(async (target: SyncTarget) => {
      if (target.projectionId === 'projection-a') {
        throw failure;
      }
      secondStarted.resolve();
      await releaseSecond.promise;
      return {};
    });
    let settled = false;
    let retryError: unknown;

    const retry = engine.retryRemoteNow(tenantDid, remoteEndpoint).catch((error: unknown): void => {
      settled = true;
      retryError = error;
    });
    await secondStarted.promise;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(internal._lifecycle.isSyncInProgress).toBe(true);
    releaseSecond.resolve();
    await retry;

    expect(retryError).toBe(failure);
    expect(internal._lifecycle.isSyncInProgress).toBe(false);
    await engine.close();
  });

  it('should wait for a scheduled pull before closing storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const pullStarted = createDeferred();
    const releasePull = createDeferred();
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

    const controller = engine['activateLink'](linkKey, link as never);
    controller.markReplicationReady();
    sinon.stub(engine as never, 'reconcileOwnedTarget').callsFake(async (): Promise<{ pullDrained: true; pullLocallyComplete: true }> => {
      pullStarted.resolve();
      await releasePull.promise;
      return { pullDrained: true, pullLocallyComplete: true };
    });

    (engine as any).scheduleLinkDirection(controller, 'pull', 0);
    await pullStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releasePull.resolve();
    await closePromise;

    expect(db.status).toBe('closed');
  });

  it('should wait for an in-flight durable push pass before closing storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const pushStarted = createDeferred();
    const releasePush = createDeferred();
    const linkKey = 'did:example:alice^https://dwn.example.com^projection-1^authorization-1';
    const did = 'did:example:alice';
    const controller = engine['activateLink'](linkKey, {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-1',
      connectivity       : 'online',
      projectionId       : 'projection-1',
      pull               : {},
      push               : {},
      remoteEndpoint     : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      status             : 'live',
      tenantDid          : did,
    });
    controller.markReplicationReady();
    sinon.stub(engine as never, 'reconcileOwnedTarget').callsFake(async (): Promise<Record<string, unknown>> => {
      pushStarted.resolve();
      await releasePush.promise;
      return { pushFailures: [] };
    });

    const runIdentityTask = (engine as any)._lifecycle.captureIdentityTaskRunner(did);
    controller.executor.request('push');
    const push = runIdentityTask(() => (engine as any).resumeLinkExecutor(controller));
    await pushStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releasePush.resolve();
    await Promise.all([push, closePromise]);

    expect(db.status).toBe('closed');
  });

  it('should wait for an in-flight link retry without letting it reactivate after close starts', async () => {
    const engine = new SyncEngineLevel({ db });
    const retryStarted = createDeferred();
    const releaseRetry = createDeferred();
    const target = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'authorization-1',
      did                : 'did:example:alice',
      dwnUrl             : 'https://dwn.example.com',
      scope              : { kind: 'full' as const },
    };
    sinon.stub(engine as never, 'getOrCreateReplicationLink').callsFake(async () => {
      retryStarted.resolve();
      await releaseRetry.promise;
      return {
        authorization      : target.authorization,
        authorizationEpoch : target.authorizationEpoch,
        connectivity       : 'unknown',
        projectionId       : 'projection-1',
        pull               : {},
        push               : {},
        remoteEndpoint     : target.dwnUrl,
        scope              : target.scope,
        status             : 'initializing',
        tenantDid          : target.did,
      };
    });

    (engine as unknown as {
      scheduleLinkInitRetry(retryTarget: typeof target, linkKey: string, delayMs: number): void;
    }).scheduleLinkInitRetry(target, `${target.did}^${target.dwnUrl}^projection-1^authorization-1`, 0);
    await retryStarted.promise;

    let closeCompleted = false;
    const closePromise = engine.close().then((): void => { closeCompleted = true; });
    await Promise.resolve();

    expect(closeCompleted).toBe(false);
    expect(db.status).toBe('open');

    releaseRetry.resolve();
    await closePromise;

    expect(db.status).toBe('closed');
    expect(engine['_linkControllers'].size).toBe(0);
  });

  it('should serialize competing option sets for the same identity', async () => {
    const engine = new SyncEngineLevel({ db });
    const validationStarted = createDeferred();
    const releaseValidation = createDeferred();
    const validateScope = sinon.stub(getScopeClosureValidator(engine), 'validateClosure');
    const readIdentityOptions = engine.getIdentityOptions.bind(engine);
    let firstRegistrationReleased = false;
    let identityOptionsReads = 0;
    sinon.stub(engine, 'getIdentityOptions').callsFake(async (did: string) => {
      identityOptionsReads++;
      // Before the fix, the competing call reaches this read while the first
      // registration is still validating and observes the identity as absent.
      if (identityOptionsReads > 1 && !firstRegistrationReleased) {
        return undefined;
      }
      return readIdentityOptions(did);
    });
    validateScope.onFirstCall().callsFake(async (): Promise<void> => {
      validationStarted.resolve();
      await releaseValidation.promise;
    });
    validateScope.onSecondCall().resolves();

    const firstSet = engine.setIdentityOptions({
      did     : 'did:example:alice',
      options : { protocols: ['old'] },
    });
    await validationStarted.promise;

    const competingSet = engine.setIdentityOptions({
      did     : 'did:example:alice',
      options : { protocols: ['new'] },
    });
    await Promise.resolve();

    firstRegistrationReleased = true;
    releaseValidation.resolve();
    await firstSet;
    await competingSet;

    expect(await readIdentityOptions('did:example:alice')).toEqual({ protocols: ['new'] });
  });

  it('should wait for a lock-owning sync before starting an identity mutation', async () => {
    const engine = new SyncEngineLevel({ db });
    const syncStarted = createDeferred();
    const releaseSync = createDeferred();
    sinon.stub(engine as never, 'getSyncTargets').callsFake(async (): Promise<[]> => {
      syncStarted.resolve();
      await releaseSync.promise;
      return [];
    });
    sinon.stub(engine, 'getIdentityOptions').resolves(undefined);
    const validateScope = sinon.spy(getScopeClosureValidator(engine), 'validateClosure');

    const syncPromise = engine.sync();
    await syncStarted.promise;
    const registrationPromise = engine.setIdentityOptions({
      did     : 'did:example:alice',
      options : { protocols: 'all' },
    });
    await Promise.resolve();
    await Promise.resolve();

    try {
      expect(validateScope.called).toBe(false);
    } finally {
      releaseSync.resolve();
      await Promise.all([syncPromise, registrationPromise]);
    }

    expect(validateScope.calledOnce).toBe(true);
  });

  it('should keep link state until in-flight pull work drains during unregister', async () => {
    const engine = new SyncEngineLevel({ db });
    const pullStarted = createDeferred();
    const releasePull = createDeferred();
    const removeStarted = createDeferred();
    const did = 'did:example:alice';
    const linkKey = `${did}^https://dwn.example.com^projection-1^authorization-1`;
    const link = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-1',
      connectivity       : 'unknown',
      projectionId       : 'projection-1',
      pull               : {},
      push               : {},
      remoteEndpoint     : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      status             : 'live',
      tenantDid          : did,
    };

    await engine.setIdentityOptions({ did, options: { protocols: 'all' } });
    engine['_runtime'] = new SyncRuntime(true);
    const controller = engine['activateLink'](linkKey, link as never);
    controller.markReplicationReady();
    sinon.stub(engine as never, 'reconcileOwnedTarget').callsFake(async (): Promise<{ pullDrained: true; pullLocallyComplete: true }> => {
      pullStarted.resolve();
      await releasePull.promise;
      return { pullDrained: true, pullLocallyComplete: true };
    });
    const removeIdentity = engine['removeIdentityFromLiveSync'].bind(engine);
    sinon.stub(engine as never, 'removeIdentityFromLiveSync').callsFake(async (identityDid: string): Promise<void> => {
      const removal = removeIdentity(identityDid);
      removeStarted.resolve();
      await removal;
    });

    (engine as any).requestLinkDirection(controller, 'pull');
    await pullStarted.promise;

    const unregisterPromise = engine.removeIdentity(did);
    await removeStarted.promise;

    try {
      expect(engine['_linkControllers'].has(linkKey)).toBe(true);
      expect(await engine.getIdentityOptions(did)).toBeDefined();
    } finally {
      releasePull.resolve();
      await unregisterPromise;
    }

    expect(engine['_linkControllers'].has(linkKey)).toBe(false);
    expect(await engine.getIdentityOptions(did)).toBeUndefined();
  });

  it('should not wait for another identity\'s in-flight work during hot-remove', async () => {
    const engine = new SyncEngineLevel({ db });
    const pullStarted = createDeferred();
    const releasePull = createDeferred();
    const aliceDid = 'did:example:alice';
    const bobDid = 'did:example:bob';
    const aliceLinkKey = `${aliceDid}^https://dwn.example.com^projection-1^authorization-1`;
    const bobLinkKey = `${bobDid}^https://dwn.example.com^projection-1^authorization-1`;
    const aliceLink = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-1',
      connectivity       : 'online',
      projectionId       : 'projection-1',
      pull               : {},
      push               : {},
      remoteEndpoint     : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      status             : 'live',
      tenantDid          : aliceDid,
    };
    const bobLink = { ...aliceLink, tenantDid: bobDid };

    engine['activateLink'](aliceLinkKey, aliceLink as never);
    const bobController = engine['activateLink'](bobLinkKey, bobLink as never);
    bobController.markReplicationReady();
    sinon.stub(engine as never, 'reconcileOwnedTarget').callsFake(async (): Promise<{ pullDrained: true; pullLocallyComplete: true }> => {
      pullStarted.resolve();
      await releasePull.promise;
      return { pullDrained: true, pullLocallyComplete: true };
    });

    (engine as any).requestLinkDirection(bobController, 'pull');
    await pullStarted.promise;

    const removal = (engine as unknown as {
      removeIdentityFromLiveSync(identityDid: string): Promise<void>;
    }).removeIdentityFromLiveSync(aliceDid);
    const removalState = await Promise.race([
      removal.then((): 'removed' => 'removed'),
      new Promise<'blocked'>((resolve) => { setTimeout((): void => { resolve('blocked'); }, 50); }),
    ]);

    try {
      expect(removalState).toBe('removed');
      expect(engine['_linkControllers'].has(aliceLinkKey)).toBe(false);
      expect(engine['_linkControllers'].has(bobLinkKey)).toBe(true);
    } finally {
      releasePull.resolve();
      await removal;
      await engine.stopSync();
    }
  });

  it('should defer replacement links until in-flight pull work drains during update', async () => {
    const engine = new SyncEngineLevel({ db });
    const pullStarted = createDeferred();
    const releasePull = createDeferred();
    const removeStarted = createDeferred();
    const did = 'did:example:alice';
    const linkKey = `${did}^https://dwn.example.com^projection-1^authorization-1`;
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
      tenantDid          : did,
    };

    await engine.setIdentityOptions({ did, options: { protocols: 'all' } });
    engine['_runtime'] = new SyncRuntime(true);
    const controller = engine['activateLink'](linkKey, link as never);
    controller.markReplicationReady();
    sinon.stub(engine as never, 'reconcileOwnedTarget').callsFake(async (): Promise<{ pullDrained: true; pullLocallyComplete: true }> => {
      pullStarted.resolve();
      await releasePull.promise;
      return { pullDrained: true, pullLocallyComplete: true };
    });
    const clearQuotaBlocks = sinon.stub(engine['_quotaManager'], 'clearTenant').resolves();
    const addIdentity = sinon.stub(engine as never, 'addIdentityToLiveSync').resolves(new Set());
    const removeIdentity = engine['removeIdentityFromLiveSync'].bind(engine);
    sinon.stub(engine as never, 'removeIdentityFromLiveSync').callsFake(async (identityDid: string): Promise<void> => {
      const removal = removeIdentity(identityDid);
      removeStarted.resolve();
      await removal;
    });

    (engine as any).requestLinkDirection(controller, 'pull');
    await pullStarted.promise;

    const updatedOptions = { protocols: 'all' as const, delegateDid: 'did:example:delegate' };
    const updatePromise = engine.setIdentityOptions({ did, options: updatedOptions });
    await removeStarted.promise;

    try {
      expect(engine['_linkControllers'].has(linkKey)).toBe(true);
      expect(clearQuotaBlocks.called).toBe(false);
      expect(addIdentity.called).toBe(false);
    } finally {
      releasePull.resolve();
      await updatePromise;
    }

    expect(engine['_linkControllers'].has(linkKey)).toBe(false);
    expect(clearQuotaBlocks.calledOnce).toBe(true);
    expect(addIdentity.calledOnce).toBe(true);
    expect(await engine.getIdentityOptions(did)).toEqual(updatedOptions);
  });

  it('should keep the replication link active until an in-flight durable push drains during unregister', async () => {
    const engine = new SyncEngineLevel({ db });
    const pushStarted = createDeferred();
    const releasePush = createDeferred();
    const removeStarted = createDeferred();
    const did = 'did:example:alice';
    const linkKey = `${did}^https://dwn.example.com^projection-1^authorization-1`;
    const controller = engine['activateLink'](linkKey, {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-1',
      connectivity       : 'online',
      projectionId       : 'projection-1',
      pull               : {},
      push               : {},
      remoteEndpoint     : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      status             : 'live',
      tenantDid          : did,
    });
    controller.markReplicationReady();

    await engine.setIdentityOptions({ did, options: { protocols: 'all' } });
    engine['_runtime'] = new SyncRuntime(true);
    sinon.stub(engine as never, 'reconcileOwnedTarget').callsFake(async (): Promise<Record<string, unknown>> => {
      pushStarted.resolve();
      await releasePush.promise;
      return { pushFailures: [] };
    });
    const removeIdentity = engine['removeIdentityFromLiveSync'].bind(engine);
    sinon.stub(engine as never, 'removeIdentityFromLiveSync').callsFake(async (identityDid: string): Promise<void> => {
      const removal = removeIdentity(identityDid);
      removeStarted.resolve();
      await removal;
    });

    const runIdentityTask = (engine as any)._lifecycle.captureIdentityTaskRunner(did);
    controller.executor.request('push');
    const push = runIdentityTask(() => (engine as any).resumeLinkExecutor(controller));
    await pushStarted.promise;

    const unregisterPromise = engine.removeIdentity(did);
    await removeStarted.promise;

    try {
      expect(engine['_linkControllers'].get(linkKey)).toBe(controller);
      expect(controller.isActive).toBe(true);
      expect(await engine.getIdentityOptions(did)).toBeDefined();
    } finally {
      releasePush.resolve();
      await Promise.all([push, unregisterPromise]);
    }

    expect(engine['_linkControllers'].has(linkKey)).toBe(false);
    expect(await engine.getIdentityOptions(did)).toBeUndefined();
  });

  it('should serialize stop behind an in-progress start transition', async () => {
    const engine = new SyncEngineLevel({ db });
    const startEntered = createDeferred();
    const releaseStart = createDeferred();
    sinon.stub(engine as never, 'startLiveSync').callsFake(async (): Promise<void> => {
      startEntered.resolve();
      await releaseStart.promise;
    });

    const startPromise = engine.startSync({ interval: '5m' });
    await startEntered.promise;

    let stopCompleted = false;
    const stopPromise = engine.stopSync().then((): void => { stopCompleted = true; });
    await Promise.resolve();

    expect(stopCompleted).toBe(false);
    expect(engine['_runtime'].live).toBe(true);

    releaseStart.resolve();
    await Promise.all([startPromise, stopPromise]);

    expect(engine['_runtime'].live).toBe(false);
  });

  it('should ignore a stale settle-check callback after stop', async () => {
    const engine = new SyncEngineLevel({ db });
    const sync = sinon.stub(engine, 'sync').resolves();
    const staleRuntime = engine['_runtime'];

    await engine.stopSync();
    await (engine as unknown as {
      runSettleCheck(runtime: unknown): Promise<void>;
    }).runSettleCheck(staleRuntime);

    expect(sync.called).toBe(false);
  });

  it('should let one-shot sync skip an initializing link while its baseline owns reconciliation', async () => {
    const engine = new SyncEngineLevel({ db });
    const { controller, target } = activateAdministrativeLink(engine, 'did:example:sync-initializing', 'initializing');

    sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
    sinon.stub(engine as any, 'getOrCreateReplicationLink').resolves(controller.link);
    const reconcile = sinon.stub(engine['_durableFeedReconciler'], 'reconcile').resolves({
      pushFailures: [],
    });

    try {
      await engine.sync();

      expect(reconcile.notCalled).toBe(true);
      const acquiredSync = engine['_lifecycle'].tryAcquireSync();
      if (acquiredSync) {
        engine['_lifecycle'].releaseSync();
      }
      expect(acquiredSync).toBe(true);

      // Initialization remains the sole owner of the baseline. An
      // administrative executor call must fail fast instead of parking.
      const initializationTurn = sinon.stub().resolves();
      expect(await controller.executor.enqueue(initializationTurn)).toBeUndefined();
      expect(initializationTurn.notCalled).toBe(true);
    } finally {
      await controller.dispose();
    }
  });

  it('should skip a settle tick entirely while the pass, including its re-initialization, is in flight', async () => {
    const engine = new SyncEngineLevel({ db });
    engine['_runtime'] = new SyncRuntime(true);

    const settleStub = sinon.stub((engine as any)._runCoordinator, 'settle').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([{
      did                : 'did:example:settle-skip',
      dwnUrl             : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      projectionId       : 'projection-id',
    }]);
    sinon.stub(engine as any, 'openLinkSubscriptions').resolves('readyForLive');
    sinon.stub(engine as any, 'establishLinkBaseline').resolves();
    sinon.stub(engine as any, 'markLinkLive').resolves();

    const reachedLinkStorage = createDeferred();
    const releaseLinkStorage = createDeferred();
    sinon.stub(engine as any, 'getOrCreateReplicationLink').callsFake(async (): Promise<any> => {
      reachedLinkStorage.resolve();
      await releaseLinkStorage.promise;
      return {
        tenantDid          : 'did:example:settle-skip',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-id',
        authorizationEpoch : 'owner-epoch',
        scope              : { kind: 'full' },
        authorization      : { kind: 'owner' },
        status             : 'initializing',
        connectivity       : 'unknown',
        pull               : {},
        push               : {},
      };
    });

    const firstPass = (engine as unknown as {
      runSettleCheck(runtime: unknown): Promise<void>;
    }).runSettleCheck(engine['_runtime']);
    await reachedLinkStorage.promise;

    // The pass holds the exclusive sync lock through the re-initialization:
    // a second settle tick arriving now must skip entirely rather than
    // start another convergence run.
    await (engine as unknown as {
      runSettleCheck(runtime: unknown): Promise<void>;
    }).runSettleCheck(engine['_runtime']);
    expect(settleStub.callCount).toBe(1);

    releaseLinkStorage.resolve();
    await firstPass;
    expect(settleStub.callCount).toBe(1);

    await engine.stopSync();
  });

  it('should leave a rate-limited link to its Retry-After ladder instead of re-attempting from the settle pass', async () => {
    const engine = new SyncEngineLevel({ db });
    engine['_runtime'] = new SyncRuntime(true);
    const did = 'did:example:settle-ratelimited';
    const target = {
      did,
      dwnUrl             : 'https://dwn.example.com',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      projectionId       : 'projection-id',
    };
    const linkKey = `${did}^https://dwn.example.com^projection-id^owner-epoch`;

    sinon.stub((engine as any)._runCoordinator, 'settle').resolves();
    sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
    const initStub = sinon.stub(engine as any, 'initializeLinkTarget');
    initStub.resolves({ status: 'active', durableLinkIdentityKey: 'key' });

    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

    // A 429 with Retry-After 60s parked this link on the retry ladder.
    (engine as any).scheduleLinkInitRetry(target, linkKey, 60_000);

    await (engine as unknown as {
      runSettleCheck(runtime: unknown): Promise<void>;
    }).runSettleCheck(engine['_runtime']);

    // The pending Retry-After ladder owns the link: the settle pass must
    // neither re-attempt it nor cancel the retry timer.
    expect(initStub.notCalled).toBe(true);
    expect((engine as any).hasLinkInitRetriesForDid(did)).toBe(true);

    await clock.tickAsync(60_000);
    clock.restore();

    // Exactly the ladder's retry fires once the window elapses.
    expect(initStub.calledOnce).toBe(true);
    expect(initStub.firstCall.args[0]).toBe(target);
    expect((engine as any).hasLinkInitRetriesForDid(did)).toBe(false);
  });

  it('should exclude one-shot sync from the clear() destructive phase and cancel the joined run', async () => {
    const engine = new SyncEngineLevel({ db });
    const registeredIdentities = db.sublevel<string, string>('registeredIdentities');
    await registeredIdentities.put('did:example:alice', JSON.stringify({ protocols: 'all' }));

    const wipeStarted = createDeferred();
    const releaseWipe = createDeferred();
    sinon.stub(engine as never, 'clearSyncDb').callsFake(async (): Promise<void> => {
      wipeStarted.resolve();
      await releaseWipe.promise;
    });
    const getSyncTargets = sinon.stub(engine as never, 'getSyncTargets').resolves([]);

    const clearPromise = engine.clear();
    await wipeStarted.promise;

    // A sync admitted mid-wipe must not start its run inside the destructive
    // phase: without the exclusive lock it would reach getSyncTargets before
    // its first suspension.
    const syncPromise = engine.sync();
    expect(getSyncTargets.called).toBe(false);

    releaseWipe.resolve();
    await clearPromise;

    // The joined run raced the wipe rather than following it — it cancels
    // through the queued-run convention instead of running on wiped state.
    await expect(syncPromise).rejects.toThrow(SyncRunCancelledError);
    expect(getSyncTargets.called).toBe(false);

    // A sync issued after clear() completes runs normally.
    await engine.sync();
    expect(getSyncTargets.called).toBe(true);
  });

  it('should cancel a sync joined during the close() destructive phase instead of failing on closed storage', async () => {
    const engine = new SyncEngineLevel({ db });
    const registeredIdentities = db.sublevel<string, string>('registeredIdentities');
    await registeredIdentities.put('did:example:alice', JSON.stringify({ protocols: 'all' }));

    const closeStarted = createDeferred();
    const releaseClose = createDeferred();
    const dbClose = sinon.stub(db, 'close').callsFake(async (): Promise<void> => {
      closeStarted.resolve();
      await releaseClose.promise;
      await dbClose.wrappedMethod.call(db);
    });
    const getSyncTargets = sinon.stub(engine as never, 'getSyncTargets').resolves([]);

    const closePromise = engine.close();
    await closeStarted.promise;

    const syncPromise = engine.sync();
    releaseClose.resolve();
    await closePromise;

    // The joined run must cancel with the typed queued-run error instead of
    // executing against the closed database and surfacing an internal
    // storage error to the caller.
    await expect(syncPromise).rejects.toThrow(SyncRunCancelledError);
    expect(getSyncTargets.called).toBe(false);
    expect(db.status).toBe('closed');
  });

  it('should cancel a joined sync even when the destructive close() operation fails', async () => {
    const engine = new SyncEngineLevel({ db });
    const registeredIdentities = db.sublevel<string, string>('registeredIdentities');
    await registeredIdentities.put('did:example:alice', JSON.stringify({ protocols: 'all' }));

    const closeStarted = createDeferred();
    const releaseClose = createDeferred();
    sinon.stub(db, 'close').callsFake(async (): Promise<void> => {
      closeStarted.resolve();
      await releaseClose.promise;
      throw new Error('close failed');
    });
    const getSyncTargets = sinon.stub(engine as never, 'getSyncTargets').resolves([]);

    const closePromise = engine.close();
    closePromise.catch((): void => {});
    await closeStarted.promise;

    // The failed destructive operation surfaces to the close() caller, while
    // the joiner that raced a half-destroyed engine still cancels cleanly:
    // the disposed-scope install lives in the finally, so a throwing
    // operation cannot leave queued work runnable against partially
    // destroyed state. Plain catch handlers pre-attach so neither rejection
    // is ever unhandled.
    const syncPromise = engine.sync();
    syncPromise.catch((): void => {});
    releaseClose.resolve();

    await expect(closePromise).rejects.toThrow('close failed');
    await expect(syncPromise).rejects.toThrow(SyncRunCancelledError);
    expect(getSyncTargets.called).toBe(false);
  });

  it('should trip stopped-state fences and cancel a stopped-state queued sync on the next transition', async () => {
    const engine = new SyncEngineLevel({ db });
    const registeredIdentities = db.sublevel<string, string>('registeredIdentities');
    await registeredIdentities.put('did:example:alice', JSON.stringify({ protocols: 'all' }));
    const getSyncTargets = sinon.stub(engine as never, 'getSyncTargets').resolves([]);

    // Stop the engine: the current runtime is disposed but stays installed.
    await engine.stopSync();
    const stoppedRuntime = engine['_runtime'];
    expect(stoppedRuntime.disposed).toBe(true);

    // A fence captured in the stopped state must hold — stopped-state work
    // (a retryRemoteNow, a queued sync) is legitimate until a transition.
    const stoppedFence = (engine as unknown as {
      captureTransitionFence(): () => boolean;
    }).captureTransitionFence();
    expect(stoppedFence()).toBe(true);

    // Hold the exclusive lock (as a stopped-state retry would) and queue a
    // sync(): its own fence is captured under the already-disposed runtime.
    expect(engine['_lifecycle'].tryAcquireSync()).toBe(true);
    const syncPromise = engine.sync();
    syncPromise.catch((): void => {});

    // A second transition from the stopped state must still be observable:
    // disposal alone cannot flip an already-disposed flag, so the transition
    // installs a NEW disposed runtime object.
    const stopPromise = engine.stopSync();
    engine['_lifecycle'].releaseSync();
    await stopPromise;

    const runtimeAfter = engine['_runtime'];
    expect(runtimeAfter).not.toBe(stoppedRuntime);
    expect(runtimeAfter.disposed).toBe(true);
    expect(stoppedFence()).toBe(false);

    // The queued run's fence tripped: it cancels without ever running.
    await expect(syncPromise).rejects.toThrow(SyncRunCancelledError);
    expect(getSyncTargets.called).toBe(false);
  });

  it('should retry DID-resolution failures while the runtime is unchanged', async () => {
    const engine = new SyncEngineLevel({ db });
    const originalBackoff = SyncEngineLevel['TRANSIENT_INIT_RETRY_BACKOFF_MS'];
    (SyncEngineLevel as unknown as { TRANSIENT_INIT_RETRY_BACKOFF_MS: number[] }).TRANSIENT_INIT_RETRY_BACKOFF_MS = [1, 1];
    try {
      const initializeLinkTarget = sinon.stub(engine as never, 'initializeLinkTarget')
        .rejects(new Error('remote DWN rejected request: GetPublicKeyNotFound'));

      const result = await (engine as unknown as {
        initializeLinkTargetWithRetry(target: unknown): Promise<{ status: string }>;
      }).initializeLinkTargetWithRetry({});

      expect(result).toEqual({ status: 'failed' });
      expect(initializeLinkTarget.callCount).toBe(3);
    } finally {
      (SyncEngineLevel as unknown as { TRANSIENT_INIT_RETRY_BACKOFF_MS: number[] }).TRANSIENT_INIT_RETRY_BACKOFF_MS = originalBackoff;
    }
  });

  it('should stop DID-resolution init retries after a runtime transition', async () => {
    const engine = new SyncEngineLevel({ db });
    const originalBackoff = SyncEngineLevel['TRANSIENT_INIT_RETRY_BACKOFF_MS'];
    (SyncEngineLevel as unknown as { TRANSIENT_INIT_RETRY_BACKOFF_MS: number[] }).TRANSIENT_INIT_RETRY_BACKOFF_MS = [1, 1];
    try {
      const initializeLinkTarget = sinon.stub(engine as never, 'initializeLinkTarget')
        .callsFake(async (): Promise<never> => {
          // Simulate stopSync/clear/close racing the backoff window.
          engine['_runtime'].dispose();
          throw new Error('remote DWN rejected request: GetPublicKeyNotFound');
        });

      const result = await (engine as unknown as {
        initializeLinkTargetWithRetry(target: unknown): Promise<{ status: string }>;
      }).initializeLinkTargetWithRetry({});

      expect(result).toEqual({ status: 'failed' });
      expect(initializeLinkTarget.callCount).toBe(1);
    } finally {
      (SyncEngineLevel as unknown as { TRANSIENT_INIT_RETRY_BACKOFF_MS: number[] }).TRANSIENT_INIT_RETRY_BACKOFF_MS = originalBackoff;
    }
  });
});
