import type { SinonStub } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncLinkRecoveryCoordinatorOperations } from '../src/sync-link-recovery-coordinator.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncLinkController } from '../src/sync-link-controller.js';
import { SyncLinkRecoveryCoordinator } from '../src/sync-link-recovery-coordinator.js';
import { SyncRuntime } from '../src/sync-runtime.js';

import { deferred } from './utils/deferred.js';

type RecoveryOperationStubs = {
  [Operation in keyof SyncLinkRecoveryCoordinatorOperations]: SinonStub;
};

type RecoveryFixture = {
  controllers: Map<string, SyncLinkController>;
  coordinator: SyncLinkRecoveryCoordinator;
  /** Simulate a runtime transition by replacing the current runtime. */
  replaceRuntime(): void;
  operations: RecoveryOperationStubs;
  taskRunner: SinonStub;
};

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example';
const LINK_KEY = `${DID}^${REMOTE}^projection^owner-epoch`;

function link(status: ReplicationLinkState['status'] = 'live'): ReplicationLinkState {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : status === 'live' ? 'online' : 'offline',
    projectionId       : 'projection',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE,
    scope              : { kind: 'full' },
    status,
    tenantDid          : DID,
  };
}

function token(position = '1'): ProgressToken {
  return { epoch: 'epoch', position, streamId: 'stream', messageCid: `cid-${position}` };
}

function createFixture(options: {
  maxRepairAttempts?: number;
  reconcileDelayMs?: number;
  repairBackoffMs?: readonly number[];
} = {}): RecoveryFixture {
  let runtime = new SyncRuntime();
  const controllers = new Map<string, SyncLinkController>();
  const taskRunner = sinon.stub().callsFake(async (operation: () => Promise<void>) => operation());
  const operations: RecoveryOperationStubs = {
    captureIdentityTaskRunner : sinon.stub().returns(taskRunner),
    clearConvergence          : sinon.stub(),
    emitEvent                 : sinon.stub(),
    getController             : sinon.stub().callsFake((linkKey: string) => controllers.get(linkKey)),
    getRuntime                : sinon.stub().callsFake(() => runtime),
    handleDivergence          : sinon.stub().resolves(false),
    openPullSubscription      : sinon.stub().resolves(true),
    openPushSubscription      : sinon.stub().resolves(true),
    reconcileTarget           : sinon.stub().resolves({ converged: true }),
    reportError               : sinon.stub(),
    setStatus                 : sinon.stub().callsFake(async (state, status) => { state.status = status; }),
    warn                      : sinon.stub(),
  };
  const coordinator = new SyncLinkRecoveryCoordinator({ ...options, operations });
  return {
    controllers,
    coordinator,
    replaceRuntime: (): void => {
      runtime.dispose();
      runtime = new SyncRuntime();
    },
    operations,
    taskRunner,
  };
}

function activate(fixture: RecoveryFixture, state = link()): SyncLinkController {
  const controller = new SyncLinkController(LINK_KEY, state);
  fixture.controllers.set(LINK_KEY, controller);
  return controller;
}

async function waitForLastTask(taskRunner: SinonStub): Promise<void> {
  await taskRunner.lastCall?.returnValue;
}

describe('SyncLinkRecoveryCoordinator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('transitions an exact active link to repairing and supervises the first repair', async () => {
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    const stalePull = sinon.stub().resolves();
    const stalePush = sinon.stub().resolves();
    const queuedPull = controller.enqueueDirection('pull', stalePull);
    const queuedPush = controller.enqueueDirection('push', stalePush);
    const runRequestedRepairPasses = sinon.stub(
      fixture.coordinator as any,
      'runRequestedRepairPasses',
    ).resolves();

    await fixture.coordinator.transitionToRepairing(controller);
    await waitForLastTask(fixture.taskRunner);

    expect(state.status).toBe('repairing');
    expect(state.connectivity).toBe('offline');
    expect(await queuedPull).toBeUndefined();
    expect(await queuedPush).toBeUndefined();
    expect(stalePull.notCalled).toBe(true);
    expect(stalePush.notCalled).toBe(true);
    expect(controller.getPendingDirectionCount('pull')).toBe(0);
    expect(controller.getPendingDirectionCount('push')).toBe(0);
    expect(controller.isReplicationReady).toBe(false);
    // The transition publishes the runnable request synchronously; the
    // supervised pass runner runs it without re-marking.
    expect(controller.isPassRequested('repair')).toBe(true);
    expect(runRequestedRepairPasses.calledOnceWithExactly(controller)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type : 'link:status-change',
      from : 'live',
      to   : 'repairing',
    })).toBe(true);

    // A replaced controller is deactivated by activateLink in production;
    // a stale transition through it must be a no-op.
    controller.deactivate();
    fixture.controllers.set(LINK_KEY, new SyncLinkController(LINK_KEY, link()));
    await fixture.coordinator.transitionToRepairing(controller);
    expect(runRequestedRepairPasses.calledOnce).toBe(true);
  });

  it('waits for invalidated directional work to unwind before repair reconciliation starts', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const operationStarted = deferred<void>();
    const releaseOperation = deferred<void>();
    controller.markReplicationReady();
    const staleOperation = controller.enqueueDirection('pull', async (): Promise<void> => {
      operationStarted.resolve();
      await releaseOperation.promise;
    });
    await operationStarted.promise;

    await fixture.coordinator.transitionToRepairing(controller);
    expect(fixture.operations.reconcileTarget.notCalled).toBe(true);

    releaseOperation.resolve();
    await staleOperation;
    await waitForLastTask(fixture.taskRunner);

    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(controller.isReplicationReady).toBe(true);
    controller.deactivate();
  });

  it('does not publish any repair state for a paused link', async () => {
    const fixture = createFixture();
    const state = link('paused');
    const controller = activate(fixture, state);

    await fixture.coordinator.transitionToRepairing(controller);

    expect(controller.isPassRequested('repair')).toBe(false);
    expect(fixture.taskRunner.called).toBe(false);
    expect(state.status).toBe('paused');
  });

  it('pauses a link once and clears subscriptions, timers, directional work, and repair state', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const closePull = sinon.stub().resolves();
    const closePush = sinon.stub().resolves();
    controller.setLiveSubscription({ close: closePull });
    controller.setLocalSubscription({ close: closePush });
    const pendingPull = controller.enqueueDirection('pull', sinon.stub().resolves());
    const pendingPush = controller.enqueueDirection('push', sinon.stub().resolves());
    controller.setRepairRetryTimer(setTimeout(() => undefined, 1000));
    controller.setReconcileTimer(setTimeout(() => undefined, 1000), 1000);

    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);

    expect(state.status).toBe('paused');
    expect(closePull.calledOnce).toBe(true);
    expect(closePush.calledOnce).toBe(true);
    expect(await pendingPull).toBeUndefined();
    expect(await pendingPush).toBeUndefined();
    expect(controller.getPendingDirectionCount('pull')).toBe(0);
    expect(controller.getPendingDirectionCount('push')).toBe(0);
    expect(controller.repairRetryTimer).toBeUndefined();
    expect(controller.reconcileTimer).toBeUndefined();
    expect(fixture.operations.setStatus.calledOnce).toBe(true);
    await clock.runAllAsync();
  });

  it('repairs through durable feeds, restores subscriptions, and schedules retryable push work', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    state.pull.contiguousAppliedToken = token('4');
    const controller = activate(fixture, state);
    const failure = { cid: 'push-failure', detail: 'temporary' };
    fixture.operations.reconcileTarget.resolves({
      admittedCids : ['admitted-cid'],
      converged    : false,
      pushFailures : [failure],
    });

    await fixture.coordinator.repair(controller);

    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    const [ownedController, repairTarget, options, shouldContinue] = fixture.operations.reconcileTarget.firstCall.args;
    expect(ownedController).toBe(controller);
    expect(repairTarget).toEqual(expect.objectContaining({
      did     : DID,
      dwnUrl  : REMOTE,
      linkKey : LINK_KEY,
    }));
    expect(options).toBeUndefined();
    expect(shouldContinue()).toBe(true);
    expect(fixture.operations.openPullSubscription.calledOnceWithExactly(repairTarget, controller)).toBe(true);
    expect(fixture.operations.openPushSubscription.calledOnceWithExactly(repairTarget, controller)).toBe(true);
    expect(state.status).toBe('live');
    expect(state.connectivity).toBe('online');
    expect(controller.isReplicationReady).toBe(true);
    expect(controller.isMailboxBusy('repair')).toBe(false);
    expect(controller.repairAttempts).toBe(0);
    expect(controller.reconcileTimerDueAt).toBe(500);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:completed' })).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'push-retryable',
    })).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'post-repair-gap',
    })).toBe(true);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('emits protocol-scoped repair-completion events without leaking runtime internals', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const protocol = 'https://proto.example/chat';
    const state = link('repairing');
    state.scope = { kind: 'protocolSet', protocols: [protocol] };
    state.connectivity = 'offline';
    const controller = activate(fixture, state);

    await fixture.coordinator.repair(controller);

    const completionEvents = fixture.operations.emitEvent.getCalls()
      .map((call) => call.args[0] as Record<string, unknown>)
      .filter((event) => ['repair:completed', 'link:connectivity-change', 'link:status-change'].includes(event.type as string));
    expect(completionEvents.map((event) => event.type).sort()).toEqual([
      'link:connectivity-change',
      'link:status-change',
      'repair:completed',
    ]);

    for (const event of completionEvents) {
      // The event scope is the link's protocol scope — never the runtime
      // handle, whose enumerable internals must not reach subscribers.
      expect(event.protocol).toBe(protocol);
      expect(event.protocols).toEqual([protocol]);
      expect('_disposed' in event).toBe(false);
      expect('_timers' in event).toBe(false);
      expect('disposed' in event).toBe(false);
    }

    controller.deactivate();
    await clock.runAllAsync();
  });

  it('releases directional reconciliation only after both repaired subscriptions reopen', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const pushOpening = deferred<void>();
    const releasePush = deferred<void>();
    fixture.operations.openPushSubscription.callsFake(async (): Promise<boolean> => {
      pushOpening.resolve();
      await releasePush.promise;
      return true;
    });

    const repairing = fixture.coordinator.repair(controller);
    await pushOpening.promise;

    const reconcile = sinon.stub().resolves('reconciled');
    const queuedReconcile = controller.enqueueDirection('pull', reconcile);
    await Promise.resolve();
    expect(fixture.operations.openPullSubscription.calledOnce).toBe(true);
    expect(fixture.operations.openPushSubscription.calledOnce).toBe(true);
    expect(controller.isReplicationReady).toBe(false);
    expect(reconcile.notCalled).toBe(true);

    releasePush.resolve();
    await repairing;
    expect(controller.isReplicationReady).toBe(true);
    expect(await queuedReconcile).toBe('reconciled');
    expect(reconcile.calledOnce).toBe(true);

    controller.deactivate();
    await clock.runAllAsync();
  });

  it('abandons a repair whose runtime is disposed during durable reconciliation', async () => {
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    let shouldContinue!: () => boolean;
    fixture.operations.reconcileTarget.callsFake(async (_controller, _target, _options, predicate) => {
      shouldContinue = predicate;
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      return { converged: true };
    });

    const repairing = fixture.coordinator.repair(controller);
    await reconcileStarted.promise;
    fixture.replaceRuntime();
    expect(shouldContinue()).toBe(false);
    releaseReconcile.resolve();
    await repairing;

    expect(fixture.operations.openPullSubscription.called).toBe(false);
    expect(fixture.operations.setStatus.called).toBe(false);
    expect(state.status).toBe('repairing');
  });

  it('closes a reopened pull subscription if the link becomes stale before push subscribe', async () => {
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const closePull = sinon.stub().resolves();
    controller.setLiveSubscription({ close: closePull });
    fixture.operations.openPullSubscription.callsFake(async () => {
      fixture.replaceRuntime();
      return true;
    });

    await fixture.coordinator.repair(controller);

    expect(closePull.calledOnce).toBe(true);
    expect(fixture.operations.openPushSubscription.called).toBe(false);
    expect(fixture.operations.setStatus.called).toBe(false);
  });

  it('pauses terminal authorization failures immediately and pauses transient failures at the attempt limit', async () => {
    const fixture = createFixture({ maxRepairAttempts: 3 });
    const terminalState = link('repairing');
    const terminalController = activate(fixture, terminalState);
    fixture.operations.reconcileTarget.rejects(new Error('GrantAuthorizationGrantRevoked'));

    await fixture.coordinator.repair(terminalController);
    expect(terminalState.status).toBe('paused');
    expect(fixture.operations.warn.calledWithMatch('authorization')).toBe(true);

    const transientState = link('repairing');
    const transientController = new SyncLinkController(LINK_KEY, transientState);
    fixture.controllers.set(LINK_KEY, transientController);
    fixture.operations.reconcileTarget.rejects(new Error('offline'));
    await expect(fixture.coordinator.repair(transientController)).rejects.toThrow('offline');
    await expect(fixture.coordinator.repair(transientController)).rejects.toThrow('offline');
    await fixture.coordinator.repair(transientController);

    expect(transientState.status).toBe('paused');
    expect(transientController.repairAttempts).toBe(0);
    expect(fixture.operations.reportError.callCount).toBe(3);
    expect(fixture.operations.warn.calledWithMatch('Max repair attempts reached')).toBe(true);
  });

  it('guards the production repair-retry timer by runtime disposal and consumes it before starting work', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ repairBackoffMs: [1000] });
    const controller = activate(fixture, link('repairing'));
    const runRequestedRepairPasses = sinon.stub(
      fixture.coordinator as any,
      'runRequestedRepairPasses',
    ).resolves();

    fixture.coordinator.scheduleRepairRetry(controller);
    expect(fixture.operations.captureIdentityTaskRunner.calledOnceWithExactly(DID)).toBe(true);
    fixture.operations.captureIdentityTaskRunner.resetHistory();
    fixture.replaceRuntime();
    await clock.tickAsync(1000);
    expect(runRequestedRepairPasses.called).toBe(false);
    expect(controller.isPassRequested('repair')).toBe(false);
    expect(fixture.operations.captureIdentityTaskRunner.notCalled).toBe(true);
    expect(controller.repairRetryTimer).toBeUndefined();

    fixture.coordinator.scheduleRepairRetry(controller);
    await clock.tickAsync(1000);
    await waitForLastTask(fixture.taskRunner);
    expect(controller.isPassRequested('repair')).toBe(true);
    expect(runRequestedRepairPasses.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.repairRetryTimer).toBeUndefined();
  });

  it('keeps the earliest reconcile timer and drives the production callback only for its captured runtime', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    const reconcile = sinon.stub(fixture.coordinator, 'reconcile').resolves();

    expect(fixture.coordinator.scheduleReconcile(controller, 1000)).toBe(true);
    expect(fixture.operations.captureIdentityTaskRunner.calledOnceWithExactly(DID)).toBe(true);
    fixture.operations.captureIdentityTaskRunner.resetHistory();
    expect(fixture.coordinator.scheduleReconcile(controller, 2000)).toBe(false);
    expect(fixture.coordinator.scheduleReconcile(controller, 500)).toBe(true);
    expect(controller.reconcileTimerDueAt).toBe(500);
    await clock.tickAsync(500);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.captureIdentityTaskRunner.calledOnceWithExactly(DID)).toBe(true);
    expect(reconcile.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.reconcileTimer).toBeUndefined();

    fixture.coordinator.scheduleReconcile(controller, 100);
    fixture.replaceRuntime();
    await clock.tickAsync(100);
    expect(reconcile.calledOnce).toBe(true);
    expect(controller.reconcileTimer).toBeUndefined();
  });

  it('routes convergence, divergence, and retryable push work independently', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    fixture.operations.reconcileTarget.onFirstCall().resolves({
      admittedCids : ['applied-cid'],
      converged    : true,
    });

    await fixture.coordinator.reconcile(controller);
    expect(fixture.operations.clearConvergence.calledOnceWithExactly(LINK_KEY)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'reconcile:completed' })).toBe(true);
    expect(fixture.operations.reconcileTarget.firstCall.args[0]).toBe(controller);
    expect(fixture.operations.reconcileTarget.firstCall.args[2]).toEqual({ verifyConvergence: true });
    expect(fixture.operations.reconcileTarget.firstCall.args[3]()).toBe(true);

    fixture.operations.reconcileTarget.onSecondCall().resolves({ converged: false });
    await fixture.coordinator.reconcile(controller);
    expect(fixture.operations.handleDivergence.calledOnce).toBe(true);
    expect(fixture.operations.handleDivergence.firstCall.args).toEqual([
      expect.objectContaining({ did: DID, dwnUrl: REMOTE }),
      { converged: false },
      { link: state, linkKey: LINK_KEY },
    ]);

    const failure = { cid: 'push-cid', detail: 'retry' };
    fixture.operations.reconcileTarget.onThirdCall().resolves({ pushFailures: [failure] });
    await fixture.coordinator.reconcile(controller);
    expect(controller.reconcileTimerDueAt).toBe(5000);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'push-retryable',
    })).toBe(true);
    expect(fixture.operations.handleDivergence.calledOnce).toBe(true);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('coalesces pull wake signals into one trailing durable-feed pass', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const passStarted = deferred<void>();
    const releasePass = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      passStarted.resolve();
      await releasePass.promise;
      return {};
    });
    fixture.operations.reconcileTarget.resolves({});

    const first = fixture.coordinator.pull(controller);
    await passStarted.promise;
    const second = fixture.coordinator.pull(controller);
    const third = fixture.coordinator.pull(controller);
    releasePass.resolve();
    await Promise.all([first, second, third]);

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    for (const call of fixture.operations.reconcileTarget.getCalls()) {
      expect(call.args[0]).toBe(controller);
      expect(call.args[2]).toEqual({ direction: 'pull' });
      expect(call.args[3]()).toBe(true);
    }
  });

  it('schedules verified reconciliation after a durable pull failure', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    fixture.operations.reconcileTarget.rejects(new Error('remote query failed'));

    await fixture.coordinator.pull(controller);

    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(fixture.operations.reportError.firstCall.calledWithMatch('Durable pull pass failed')).toBe(true);
    expect(controller.reconcileTimerDueAt).toBe(5000);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'pull-retryable',
    })).toBe(true);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('coalesces push wake signals into one trailing durable-feed pass', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const passStarted = deferred<void>();
    const releasePass = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      passStarted.resolve();
      await releasePass.promise;
      return {};
    });
    fixture.operations.reconcileTarget.resolves({});

    const first = fixture.coordinator.push(controller);
    await passStarted.promise;
    const second = fixture.coordinator.push(controller);
    const third = fixture.coordinator.push(controller);
    releasePass.resolve();
    await Promise.all([first, second, third]);

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    for (const call of fixture.operations.reconcileTarget.getCalls()) {
      expect(call.args[0]).toBe(controller);
      expect(call.args[2]).toEqual({ direction: 'push' });
      expect(call.args[3]()).toBe(true);
    }
  });

  it('keeps the durable push checkpoint unchanged and schedules verified retry after a push failure', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link();
    state.push.contiguousAppliedToken = token('7');
    const checkpoint = { ...state.push.contiguousAppliedToken };
    const controller = activate(fixture, state);
    fixture.operations.reconcileTarget.resolves({
      pushFailures: [{ cid: 'push-cid', detail: 'remote unavailable' }],
    });

    await fixture.coordinator.push(controller);

    expect(state.push.contiguousAppliedToken).toEqual(checkpoint);
    expect(controller.reconcileTimerDueAt).toBe(5000);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'push-retryable',
    })).toBe(true);
    expect(fixture.operations.clearConvergence.notCalled).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'reconcile:completed' })).toBe(false);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('reports reconciliation failures, schedules retry, and suppresses both after staleness', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    fixture.operations.reconcileTarget.rejects(new Error('offline'));

    await fixture.coordinator.reconcile(controller);
    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(controller.reconcileTimerDueAt).toBe(5000);
    controller.cancelReconcileTimer();

    const started = deferred<void>();
    const release = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      started.resolve();
      await release.promise;
      throw new Error('late failure');
    });
    const reconciling = fixture.coordinator.reconcile(controller);
    await started.promise;
    controller.deactivate();
    release.resolve();
    await reconciling;

    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(controller.reconcileTimer).toBeUndefined();
    await clock.runAllAsync();
  });

  it('serializes a repair behind an in-flight push pass instead of tearing it down', async () => {
    const fixture = createFixture();
    const controller = activate(fixture, link('repairing'));
    const releasePush = deferred<void>();
    const push = controller.enqueue(async (): Promise<void> => {
      await releasePush.promise;
    }, 'push');

    const repairing = fixture.coordinator.repair(controller);
    await Promise.resolve();
    expect(controller.isMailboxBusy('repair')).toBe(true);
    expect(fixture.operations.reconcileTarget.called).toBe(false);

    releasePush.resolve();
    await Promise.all([push, repairing]);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);

    controller.deactivate();
  });

  it('skips a reconciliation pass when a repair is queued behind it', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture, link());
    const releaseGate = deferred<void>();
    const gate = controller.enqueue(async (): Promise<void> => {
      await releaseGate.promise;
    });

    const reconciling = fixture.coordinator.reconcile(controller);
    const repairing = fixture.coordinator.repair(controller);
    releaseGate.resolve();
    await Promise.all([gate, reconciling, repairing]);

    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(fixture.operations.reconcileTarget.firstCall.args[2]).toBeUndefined();
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('abandons an in-flight repair when the link is paused externally', async () => {
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      return { converged: true };
    });

    const repairing = fixture.coordinator.repair(controller);
    await reconcileStarted.promise;
    // A terminal subscription error pauses the link while the repair's
    // durable reconciliation is still in flight.
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    releaseReconcile.resolve();
    await repairing;

    expect(state.status).toBe('paused');
    expect(fixture.operations.openPullSubscription.notCalled).toBe(true);
    expect(fixture.operations.openPushSubscription.notCalled).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:completed' })).toBe(false);
  });

  it('does not revive a link paused in the gap between reopening subscriptions and completion', async () => {
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const pushOpened = deferred<void>();
    fixture.operations.openPushSubscription.callsFake(async (): Promise<boolean> => {
      pushOpened.resolve();
      return true;
    });

    const repairing = fixture.coordinator.repair(controller);
    await pushOpened.promise;
    // Land the pause in the continuation gap between the reopen path's final
    // cancellation check and completeRepair's status write — the window a
    // terminal callback from the freshly reopened subscription occupies.
    await Promise.resolve();
    const pausing = fixture.coordinator.transitionToPaused(LINK_KEY, state);
    await Promise.all([repairing, pausing]);

    expect(state.status).toBe('paused');
    expect(state.connectivity).toBe('offline');
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:completed' })).toBe(false);
    expect(controller.reconcileTimer).toBeUndefined();
  });

  it('stays quiet when reconciliation rejects after an external pause', async () => {
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    const started = deferred<void>();
    const release = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      started.resolve();
      await release.promise;
      throw new Error('socket closed by pause');
    });

    const reconciling = fixture.coordinator.reconcile(controller);
    await started.promise;
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    release.resolve();
    await reconciling;

    expect(fixture.operations.reportError.notCalled).toBe(true);
    expect(controller.reconcileTimer).toBeUndefined();
  });

  it('stays quiet when repair rejects after an external pause', async () => {
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const started = deferred<void>();
    const release = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      started.resolve();
      await release.promise;
      throw new Error('socket closed by pause');
    });

    const repairing = fixture.coordinator.repair(controller);
    await started.promise;
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    release.resolve();
    await repairing;

    expect(fixture.operations.reportError.notCalled).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:failed' })).toBe(false);
    expect(controller.repairRetryTimer).toBeUndefined();
    expect(state.status).toBe('paused');
  });

  it('runs exactly one verification pass when a reconcile timer expires during repair', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ reconcileDelayMs: 100 });
    const state = link('repairing');
    const controller = activate(fixture, state);
    const repairStarted = deferred<void>();
    const releaseRepair = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      repairStarted.resolve();
      await releaseRepair.promise;
      return { converged: true };
    });
    fixture.operations.reconcileTarget.resolves({ converged: true });

    const repairing = fixture.coordinator.repair(controller);
    await repairStarted.promise;
    // An already-armed reconcile timer expires while the repair holds the
    // mailbox, queueing a verification pass right behind it.
    fixture.coordinator.scheduleReconcile(controller);
    await clock.tickAsync(100);
    releaseRepair.resolve();
    await repairing;
    await clock.runAllAsync();

    const verificationPasses = fixture.operations.reconcileTarget.getCalls()
      .filter((call) => (call.args[2] as { verifyConvergence?: boolean } | undefined)?.verifyConvergence === true);
    expect(verificationPasses.length).toBe(1);
    controller.deactivate();
  });

  it('runs exactly two passes when a transition lands mid-repair, even while its status write is pending', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      return { converged: true };
    });
    fixture.operations.reconcileTarget.resolves({ converged: true });

    const repairing = fixture.coordinator.repair(controller);
    await reconcileStarted.promise;
    // The newer transition's status persistence is slow: the trailing turn
    // must nevertheless observe the complete transition
    // because the transition publishes everything before its first await.
    const releaseStatus = deferred<void>();
    fixture.operations.setStatus.callsFake(async (target: ReplicationLinkState, status: string) => {
      target.status = status as ReplicationLinkState['status'];
      if (status === 'repairing') {
        await releaseStatus.promise;
      }
    });
    const transitioning = fixture.coordinator.transitionToRepairing(controller);
    releaseReconcile.resolve();
    await repairing;

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    // Once the transition's persistence resolves, its supervision finds the
    // request already served — no third repair pass (the later scheduled
    // pass is the designed post-repair verification, not a repair).
    releaseStatus.resolve();
    await transitioning;
    expect(state.status).toBe('live');
    controller.deactivate();
    await clock.runAllAsync();
    const repairPasses = fixture.operations.reconcileTarget.getCalls()
      .filter((call) => call.args[2] === undefined);
    expect(repairPasses.length).toBe(2);
  });

  it('hands a superseded pass failure to the trailing repair without burning the attempt budget', async () => {
    const fixture = createFixture({ maxRepairAttempts: 1 });
    const state = link('repairing');
    const controller = activate(fixture, state);
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      throw new Error('socket closed by supersession');
    });
    fixture.operations.reconcileTarget.resolves({ converged: true });

    const repairing = fixture.coordinator.repair(controller);
    await reconcileStarted.promise;
    const transitioning = fixture.coordinator.transitionToRepairing(controller);
    releaseReconcile.resolve();
    await Promise.all([repairing, transitioning]);

    // The stale failure is a quiet handoff: the trailing repair runs
    // immediately, and even at maxRepairAttempts 1
    // the old failure cannot report, arm a retry, or pause the link.
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reportError.notCalled).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:failed' })).toBe(false);
    expect(controller.repairRetryTimer).toBeUndefined();
    expect(state.status).toBe('live');
    controller.deactivate();
  });

  it('runs one trailing repair when a transition lands mid-repair', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const pullOpening = deferred<void>();
    const releasePull = deferred<void>();
    fixture.operations.openPullSubscription.onFirstCall().callsFake(async (): Promise<boolean> => {
      pullOpening.resolve();
      await releasePull.promise;
      return true;
    });

    const repairing = fixture.coordinator.repair(controller);
    await pullOpening.promise;
    // A fresh recovery signal while the first repair is reopening must not be
    // absorbed by the repair already executing.
    await fixture.coordinator.transitionToRepairing(controller);
    releasePull.resolve();
    await repairing;

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(state.status).toBe('live');
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('does not let a superseded repair complete over a newer repair request', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ repairBackoffMs: [1000] });
    const state = link('repairing');
    const controller = activate(fixture, state);
    fixture.operations.reconcileTarget.onSecondCall().rejects(new Error('offline'));
    const pushOpened = deferred<void>();
    fixture.operations.openPushSubscription.onFirstCall().callsFake(async (): Promise<boolean> => {
      pushOpened.resolve();
      return true;
    });

    await fixture.coordinator.transitionToRepairing(controller);
    const firstTask = fixture.taskRunner.firstCall.returnValue;
    await pushOpened.promise;
    // A newer transition takes ownership in the reopen→completion gap. The
    // older pass must not clear progress, write live, or emit completion —
    // the trailing turn begins with the link still repairing so its
    // transient failure feeds the normal retry ladder.
    await Promise.resolve();
    void fixture.coordinator.transitionToRepairing(controller);
    await Promise.all(fixture.taskRunner.getCalls().map((call) => call.returnValue));
    await firstTask;

    expect(state.status).toBe('repairing');
    expect(controller.repairRetryTimer).toBeDefined();
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:completed' })).toBe(false);
    expect(fixture.operations.emitEvent.calledWithMatch({ from: 'repairing', to: 'live' })).toBe(false);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('runs a trailing reconciliation as a new mailbox turn behind an already-queued push', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const order: string[] = [];
    const releasePass = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      order.push(`pass-${fixture.operations.reconcileTarget.callCount}`);
      if (fixture.operations.reconcileTarget.callCount === 1) {
        await releasePass.promise;
      }
      return { converged: true };
    });

    const first = fixture.coordinator.reconcile(controller);
    await Promise.resolve();
    const push = controller.enqueue(async (): Promise<void> => { order.push('push'); }, 'push');
    // The signal lands after the push was queued: its trailing pass must
    // not jump the mailbox queue.
    const second = fixture.coordinator.reconcile(controller);
    releasePass.resolve();
    await Promise.all([first, push, second]);

    expect(order).toEqual(['pass-1', 'push', 'pass-2']);
  });

  it('lets an already-queued push run between the turns of a sustained signal stream', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const order: string[] = [];
    const passStarted = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      order.push(`pass-${fixture.operations.reconcileTarget.callCount}`);
      if (fixture.operations.reconcileTarget.callCount === 1) {
        passStarted.resolve();
      }
      if (fixture.operations.reconcileTarget.callCount <= 3) {
        // Every pass is chased by another signal, sustaining the stream.
        void fixture.coordinator.reconcile(controller);
      }
      return { converged: true };
    });

    const first = fixture.coordinator.reconcile(controller);
    await passStarted.promise;
    const push = controller.enqueue(async (): Promise<void> => { order.push('push'); }, 'push');
    await Promise.all([first, push]);

    // Each trailing pass is its own mailbox turn, so the queued push runs
    // right after the pass that was executing when it was queued — the
    // stream cannot hold the mailbox and starve a durable push pass.
    expect(order).toEqual(['pass-1', 'push', 'pass-2', 'pass-3', 'pass-4']);
  });

  it('lets a successful trailing pass subsume the failed pass retry timer', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    const snapshotTaken = deferred<void>();
    const releasePass = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      snapshotTaken.resolve();
      await releasePass.promise;
      throw new Error('offline');
    });
    fixture.operations.reconcileTarget.resolves({ converged: true });

    const first = fixture.coordinator.reconcile(controller);
    await snapshotTaken.promise;
    const second = fixture.coordinator.reconcile(controller);
    releasePass.resolve();
    await Promise.all([first, second]);

    // The trailing pass already covered the failed pass — after the retry
    // deadline there must be no third full reconciliation.
    await clock.tickAsync(5000);
    await clock.runAllAsync();
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(controller.reconcileTimer).toBeUndefined();
  });

  it('runs one trailing reconciliation pass for signals arriving after the snapshot', async () => {
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    const snapshotTaken = deferred<void>();
    const releasePass = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      snapshotTaken.resolve();
      await releasePass.promise;
      return { converged: true };
    });
    fixture.operations.reconcileTarget.resolves({ converged: true });

    const reconciling = fixture.coordinator.reconcile(controller);
    await snapshotTaken.promise;
    // Two signals land after the running pass queried the remote feed: they
    // are news it cannot have seen, and must coalesce into exactly one
    // trailing pass rather than being absorbed or each running its own.
    const second = fixture.coordinator.reconcile(controller);
    const third = fixture.coordinator.reconcile(controller);
    releasePass.resolve();
    await Promise.all([reconciling, second, third]);

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
  });

  it('deduplicates concurrent repair and reconciliation without leaking in-flight state', async () => {
    const fixture = createFixture();
    const repairController = activate(fixture, link('repairing'));
    const repairStarted = deferred<void>();
    const releaseRepair = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      repairStarted.resolve();
      await releaseRepair.promise;
      return { aborted: true };
    });

    const firstRepair = fixture.coordinator.repair(repairController);
    const secondRepair = fixture.coordinator.repair(repairController);
    await repairStarted.promise;
    releaseRepair.resolve();
    await Promise.all([firstRepair, secondRepair]);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(repairController.isMailboxBusy('repair')).toBe(false);

    const reconcileController = new SyncLinkController(LINK_KEY, link());
    fixture.controllers.set(LINK_KEY, reconcileController);
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      return { converged: true };
    });
    fixture.operations.reconcileTarget.resetHistory();
    const firstReconcile = fixture.coordinator.reconcile(reconcileController);
    const secondReconcile = fixture.coordinator.reconcile(reconcileController);
    await reconcileStarted.promise;
    releaseReconcile.resolve();
    await Promise.all([firstReconcile, secondReconcile]);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(reconcileController.isMailboxBusy('reconcile')).toBe(false);
  });
});
