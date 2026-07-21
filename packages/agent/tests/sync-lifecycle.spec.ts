import type { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRunCancelledError } from '../src/sync-runtime-errors.js';
import { SyncRuntime } from '../src/sync-runtime.js';

import { deferred as createDeferred } from './utils/deferred.js';

function getScopeClosureValidator(engine: SyncEngineLevel): SyncScopeClosureValidator {
  return (engine as unknown as { _scopeClosureValidator: SyncScopeClosureValidator })._scopeClosureValidator;
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
    engine['activateLink']('active-link', link);

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
    const durableFeedReconciler = engine['_durableFeedReconciler'];
    sinon.stub(engine as never, 'getSyncTargets').resolves([target]);
    sinon.stub(durableFeedReconciler, 'pull').resolves({});
    sinon.stub(engine as never, 'hasDeadLetter').resolves(false);
    sinon.stub(engine as never, 'getQuotaBlockState').resolves(undefined);
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
        return { hasActionableDiffs: true, pushFailures: result.failures };
      }
      return { hasActionableDiffs: result.kind === 'pushed', pushFailures: [] };
    });
    const applyPushResult = sinon.spy(engine as never, 'applyPushResult');

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
    sinon.stub(engine['ledger'], 'setStatus').callsFake(async (): Promise<void> => {
      link.status = 'repairing';
    });
    sinon.stub(engine['_linkRecoveryCoordinator'] as any, 'runPendingRepairs').callsFake(async (): Promise<void> => {
      repairStarted.resolve();
      await releaseRepair.promise;
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
    const recoveryCoordinator = engine['_linkRecoveryCoordinator'];
    sinon.stub(recoveryCoordinator, 'reconcile').callsFake(async (): Promise<void> => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
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
    const push = runIdentityTask(() => engine['_linkRecoveryCoordinator'].push(controller));
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
    sinon.stub(engine['ledger'], 'setStatus').callsFake(async (): Promise<void> => {
      link.status = 'repairing';
    });
    sinon.stub(engine['_linkRecoveryCoordinator'] as any, 'runPendingRepairs').callsFake(async (): Promise<void> => {
      repairStarted.resolve();
      await releaseRepair.promise;
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
    sinon.stub(engine['ledger'], 'setStatus').callsFake(async (): Promise<void> => {
      bobLink.status = 'repairing';
    });
    sinon.stub(engine['_linkRecoveryCoordinator'] as any, 'runPendingRepairs').callsFake(async (): Promise<void> => {
      repairStarted.resolve();
      await releaseRepair.promise;
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
    const recoveryCoordinator = engine['_linkRecoveryCoordinator'];
    sinon.stub(recoveryCoordinator, 'reconcile').callsFake(async (): Promise<void> => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
    });
    const clearQuotaBlocks = sinon.stub(engine as never, 'clearQuotaBlocksForTenant').resolves();
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
    const push = runIdentityTask(() => engine['_linkRecoveryCoordinator'].push(controller));
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

    // Stop the engine: the current scope is disposed but stays installed.
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
    // sync(): its own fence is captured under the already-disposed scope.
    expect(engine['_lifecycle'].tryAcquireSync()).toBe(true);
    const syncPromise = engine.sync();
    syncPromise.catch((): void => {});

    // A second transition from the stopped state must still be observable:
    // disposal alone cannot flip an already-disposed flag, so the transition
    // installs a NEW disposed scope object.
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

  it('should retry DID-resolution failures while the runtime generation is unchanged', async () => {
    const engine = new SyncEngineLevel({ db });
    const originalBackoff = SyncEngineLevel['DID_RESOLUTION_RETRY_BACKOFF_MS'];
    (SyncEngineLevel as unknown as { DID_RESOLUTION_RETRY_BACKOFF_MS: number[] }).DID_RESOLUTION_RETRY_BACKOFF_MS = [1, 1];
    try {
      const initializeLinkTarget = sinon.stub(engine as never, 'initializeLinkTarget')
        .rejects(new Error('remote DWN rejected request: GetPublicKeyNotFound'));

      const result = await (engine as unknown as {
        initializeLinkTargetWithRetry(target: unknown): Promise<{ status: string }>;
      }).initializeLinkTargetWithRetry({});

      expect(result).toEqual({ status: 'failed' });
      expect(initializeLinkTarget.callCount).toBe(3);
    } finally {
      (SyncEngineLevel as unknown as { DID_RESOLUTION_RETRY_BACKOFF_MS: number[] }).DID_RESOLUTION_RETRY_BACKOFF_MS = originalBackoff;
    }
  });

  it('should stop DID-resolution init retries after a runtime transition', async () => {
    const engine = new SyncEngineLevel({ db });
    const originalBackoff = SyncEngineLevel['DID_RESOLUTION_RETRY_BACKOFF_MS'];
    (SyncEngineLevel as unknown as { DID_RESOLUTION_RETRY_BACKOFF_MS: number[] }).DID_RESOLUTION_RETRY_BACKOFF_MS = [1, 1];
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
      (SyncEngineLevel as unknown as { DID_RESOLUTION_RETRY_BACKOFF_MS: number[] }).DID_RESOLUTION_RETRY_BACKOFF_MS = originalBackoff;
    }
  });
});
