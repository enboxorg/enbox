import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncLinkController } from '../src/sync-link-controller.js';
import type { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { Level } from 'level';
import { runWithCrossContextLock } from '@enbox/common';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRunCancelledError } from '../src/sync-runtime-errors.js';
import { SyncRuntime } from '../src/sync-runtime.js';

import { deferred as createDeferred } from './utils/deferred.js';

function getScopeClosureValidator(engine: SyncEngineLevel): SyncScopeClosureValidator {
  return (engine as unknown as { _scopeClosureValidator: SyncScopeClosureValidator })._scopeClosureValidator;
}

function activateAdministrativeLink(
  engine: SyncEngineLevel,
  did: string,
  status: 'initializing' | 'repairing',
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
    connectivity       : status === 'repairing' ? 'offline' : 'unknown',
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
    await engine.registerIdentity({ did, options: { protocols: 'all' } });

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

    const registration = engine.registerIdentity(
      { did, options: { protocols: 'all' } },
      { timeout: 100 },
    );
    const registrationOutcome = registration.catch((error: unknown): unknown => error);
    await clock.tickAsync(100);

    expect((await registrationOutcome as Error).message).toContain('within 100 milliseconds');
    engine['_lifecycle'].releaseSync();
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toBeUndefined();

    await engine.registerIdentity({ did, options: { protocols: 'all' } }, { timeout: 100 });
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

    const registration = engine.registerIdentity(
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

    await engine.registerIdentity({ did, options: { protocols: 'all' } }, { timeout: 100 });
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

    const registration = engine.registerIdentity(
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

    await engine.registerIdentity({ did, options: { protocols: 'all' } }, { timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toBeDefined();
  });

  it('should preserve an identity when stopped-runtime work does not drain before unregister timeout', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    const releaseTask = createDeferred();
    const taskStarted = createDeferred();
    await engine.registerIdentity({ did, options: { protocols: 'all' } });

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

    const unregister = engine.unregisterIdentity(did, { timeout: 100 });
    const unregisterOutcome = unregister.catch((error: unknown): unknown => error);
    await settleStarted.promise;
    await clock.tickAsync(100);

    expect((await unregisterOutcome as Error).message).toContain('within 100 milliseconds');
    expect(await engine.getIdentityOptions(did)).toBeDefined();

    releaseTask.resolve();
    await task;
    await clock.tickAsync(0);
    expect(await engine.getIdentityOptions(did)).toBeDefined();

    await engine.unregisterIdentity(did, { timeout: 100 });
    expect(await engine.getIdentityOptions(did)).toBeUndefined();
  });

  it('should finish unregister atomically after its preparation consumes almost all of the deadline', async () => {
    const clock = sinon.useFakeTimers();
    const engine = new SyncEngineLevel({ db });
    const did = 'did:example:alice';
    await engine.registerIdentity({ did, options: { protocols: 'all' } });

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
    const unregister = engine.unregisterIdentity(did, { timeout: 100 }).then((): void => {
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
    await engine.registerIdentity({ did, options: oldOptions });
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

    const update = engine.updateIdentityOptions(
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

    await engine.updateIdentityOptions({ did, options: updatedOptions }, { timeout: 100 });
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
    sinon.stub(engine as never, 'hasDeadLetter').resolves(false);
    sinon.stub(engine['_quotaManager'], 'getState').resolves(undefined);
    sinon.stub(engine as never, 'getQuotaBlockedInitialCidsForFeedEntry').resolves([]);
    sinon.stub(engine as never, 'pushMessages').callsFake(async (): Promise<{ acknowledged: never[]; failed: never[]; succeeded: string[] }> => {
      pushStarted.resolve();
      await releasePush.promise;
      return { acknowledged: [], failed: [], succeeded: ['cid-1'] };
    });
    sinon.stub(durableFeedReconciler, 'push').callsFake(async (
      runTarget: typeof target,
      _link: typeof link,
      _options: unknown,
      shouldContinue?: () => boolean,
    ): Promise<Record<string, unknown>> => {
      const result = await internal.pushLocalFeedEntry(runTarget, { messageCid: 'cid-1' }, shouldContinue);
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

    const controller = engine['activateLink'](linkKey, link as never);
    sinon.stub(engine['replicationLinkStore'], 'setStatus').callsFake(async (): Promise<void> => {
      link.status = 'repairing';
    });
    sinon.stub(engine['_durableFeedReconciler'], 'reconcile').callsFake(async (): Promise<{ aborted: true }> => {
      repairStarted.resolve();
      await releaseRepair.promise;
      return { aborted: true };
    });

    await engine['_linkRecoveryCoordinator'].transitionToRepairing(controller);
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

    const controller = engine['activateLink'](linkKey, link as never);
    controller.markReplicationReady();
    const recoveryCoordinator = engine['_linkRecoveryCoordinator'];
    sinon.stub(engine['_durableFeedReconciler'], 'reconcile').callsFake(async (): Promise<{ converged: true }> => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      return { converged: true };
    });

    const scheduled = recoveryCoordinator.scheduleReconcile(controller, 0);
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
    const push = runIdentityTask(() => engine['_linkRecoveryCoordinator'].resume(controller));
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

  it('should serialize competing registrations for the same identity', async () => {
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

    const firstRegistration = engine.registerIdentity({
      did     : 'did:example:alice',
      options : { protocols: 'all' },
    });
    await validationStarted.promise;

    const competingRegistration = engine.registerIdentity({
      did     : 'did:example:alice',
      options : { protocols: 'all' },
    });
    const competingOutcome = competingRegistration.then(
      (): Error | undefined => undefined,
      (error: Error): Error => error,
    );
    await Promise.resolve();

    firstRegistrationReleased = true;
    releaseValidation.resolve();
    await firstRegistration;
    expect((await competingOutcome)?.message).toContain('is already registered');
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
    const registrationPromise = engine.registerIdentity({
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

  it('should keep link state until an in-flight repair drains during unregister', async () => {
    const engine = new SyncEngineLevel({ db });
    const repairStarted = createDeferred();
    const releaseRepair = createDeferred();
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
      status             : 'initializing',
      tenantDid          : did,
    };

    await engine.registerIdentity({ did, options: { protocols: 'all' } });
    engine['_runtime'] = new SyncRuntime(true);
    engine['activateLink'](linkKey, link as never);
    sinon.stub(engine['replicationLinkStore'], 'setStatus').callsFake(async (): Promise<void> => {
      link.status = 'repairing';
    });
    sinon.stub(engine['_durableFeedReconciler'], 'reconcile').callsFake(async (): Promise<{ aborted: true }> => {
      repairStarted.resolve();
      await releaseRepair.promise;
      return { aborted: true };
    });
    const removeIdentity = engine['removeIdentityFromLiveSync'].bind(engine);
    sinon.stub(engine as never, 'removeIdentityFromLiveSync').callsFake(async (identityDid: string): Promise<void> => {
      const removal = removeIdentity(identityDid);
      removeStarted.resolve();
      await removal;
    });

    await engine['_linkRecoveryCoordinator'].transitionToRepairing(
      engine['_linkControllers'].get(linkKey)!,
    );
    await repairStarted.promise;

    const unregisterPromise = engine.unregisterIdentity(did);
    await removeStarted.promise;

    try {
      expect(engine['_linkControllers'].has(linkKey)).toBe(true);
      expect(await engine.getIdentityOptions(did)).toBeDefined();
    } finally {
      releaseRepair.resolve();
      await unregisterPromise;
    }

    expect(engine['_linkControllers'].has(linkKey)).toBe(false);
    expect(await engine.getIdentityOptions(did)).toBeUndefined();
  });

  it('should not wait for another identity\'s in-flight work during hot-remove', async () => {
    const engine = new SyncEngineLevel({ db });
    const repairStarted = createDeferred();
    const releaseRepair = createDeferred();
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
    const bobLink = { ...aliceLink, tenantDid: bobDid, status: 'initializing' };

    engine['activateLink'](aliceLinkKey, aliceLink as never);
    engine['activateLink'](bobLinkKey, bobLink as never);
    sinon.stub(engine['replicationLinkStore'], 'setStatus').callsFake(async (): Promise<void> => {
      bobLink.status = 'repairing';
    });
    sinon.stub(engine['_durableFeedReconciler'], 'reconcile').callsFake(async (): Promise<{ aborted: true }> => {
      repairStarted.resolve();
      await releaseRepair.promise;
      return { aborted: true };
    });

    await engine['_linkRecoveryCoordinator'].transitionToRepairing(
      engine['_linkControllers'].get(bobLinkKey)!,
    );
    await repairStarted.promise;

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
      releaseRepair.resolve();
      await removal;
      await engine.stopSync();
    }
  });

  it('should defer replacement links until an in-flight reconcile drains during update', async () => {
    const engine = new SyncEngineLevel({ db });
    const reconcileStarted = createDeferred();
    const releaseReconcile = createDeferred();
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

    await engine.registerIdentity({ did, options: { protocols: 'all' } });
    engine['_runtime'] = new SyncRuntime(true);
    const controller = engine['activateLink'](linkKey, link as never);
    controller.markReplicationReady();
    const recoveryCoordinator = engine['_linkRecoveryCoordinator'];
    sinon.stub(engine['_durableFeedReconciler'], 'reconcile').callsFake(async (): Promise<{ converged: true }> => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      return { converged: true };
    });
    const clearQuotaBlocks = sinon.stub(engine['_quotaManager'], 'clearTenant').resolves();
    const addIdentity = sinon.stub(engine as never, 'addIdentityToLiveSync').resolves(new Set());
    const removeIdentity = engine['removeIdentityFromLiveSync'].bind(engine);
    sinon.stub(engine as never, 'removeIdentityFromLiveSync').callsFake(async (identityDid: string): Promise<void> => {
      const removal = removeIdentity(identityDid);
      removeStarted.resolve();
      await removal;
    });

    const scheduled = recoveryCoordinator.scheduleReconcile(controller, 0);
    expect(scheduled).toBe(true);
    await reconcileStarted.promise;

    const updatedOptions = { protocols: 'all' as const, delegateDid: 'did:example:delegate' };
    const updatePromise = engine.updateIdentityOptions({ did, options: updatedOptions });
    await removeStarted.promise;

    try {
      expect(engine['_linkControllers'].has(linkKey)).toBe(true);
      expect(clearQuotaBlocks.called).toBe(false);
      expect(addIdentity.called).toBe(false);
    } finally {
      releaseReconcile.resolve();
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

    await engine.registerIdentity({ did, options: { protocols: 'all' } });
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
    const push = runIdentityTask(() => engine['_linkRecoveryCoordinator'].resume(controller));
    await pushStarted.promise;

    const unregisterPromise = engine.unregisterIdentity(did);
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

  it('should skip a repairing link without parking the settle pass behind reconciliation readiness', async () => {
    const engine = new SyncEngineLevel({ db });
    engine['_runtime'] = new SyncRuntime(true);
    const { controller, target } = activateAdministrativeLink(engine, 'did:example:settle-repairing', 'repairing');
    const repairRetryTimerKey = `syncRepairRetry:${controller.linkKey}`;
    engine['_runtime'].armTimeout(repairRetryTimerKey, () => {}, 60_000);

    sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
    sinon.stub(engine as any, 'getOrCreateReplicationLink').resolves(controller.link);
    sinon.stub(engine as any, 'reinitializeOrphanedLinkTargets').resolves();
    sinon.stub(engine as any, 'scheduleFollowedSourceReconciliation');
    const verifyConvergence = sinon.stub(engine['_durableFeedReconciler'], 'verifyConvergence').resolves({
      converged    : true,
      pushFailures : [],
    });
    const reconcile = sinon.stub(engine['_durableFeedReconciler'], 'reconcile').resolves({
      pushFailures: [],
    });

    try {
      await (engine as unknown as {
        runSettleCheck(runtime: SyncRuntime): Promise<void>;
      }).runSettleCheck(engine['_runtime']);

      expect(verifyConvergence.notCalled).toBe(true);
      expect(reconcile.notCalled).toBe(true);
      expect(engine['_runtime'].hasTimer(repairRetryTimerKey)).toBe(true);

      // The settle pass released the engine-wide lock, and the link executor
      // can still run the pending repair retry.
      const acquiredSync = engine['_lifecycle'].tryAcquireSync();
      if (acquiredSync) {
        engine['_lifecycle'].releaseSync();
      }
      expect(acquiredSync).toBe(true);
      const repairTurn = sinon.stub().resolves();
      controller.executor.request('repair');
      await controller.executor.drain(repairTurn);
      expect(repairTurn.calledOnceWithExactly('repair')).toBe(true);
    } finally {
      engine['_runtime'].dispose();
      await controller.dispose();
    }
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
