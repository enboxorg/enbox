import type { SinonStub } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncLinkRecoveryCoordinatorOperations } from '../src/sync-link-recovery-coordinator.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncLinkController } from '../src/sync-link-controller.js';
import { SyncLinkRecoveryCoordinator } from '../src/sync-link-recovery-coordinator.js';
import { SyncRuntime } from '../src/sync-runtime.js';

type RecoveryOperationStubs = {
  [Operation in keyof SyncLinkRecoveryCoordinatorOperations]: SinonStub;
};

type RecoveryFixture = {
  controllers: Map<string, SyncLinkController>;
  coordinator: SyncLinkRecoveryCoordinator;
  /** Simulate a runtime transition: dispose the current scope, install a fresh one. */
  disposeScope(): void;
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
  postRepairReconcileDelayMs?: number;
  reconcileDelayMs?: number;
  reconcileRetryDelayMs?: number;
  repairBackoffMs?: readonly number[];
} = {}): RecoveryFixture {
  let scope = new SyncRuntime();
  const controllers = new Map<string, SyncLinkController>();
  const taskRunner = sinon.stub().callsFake(async (operation: () => Promise<void>) => operation());
  const operations: RecoveryOperationStubs = {
    captureIdentityTaskRunner : sinon.stub().returns(taskRunner),
    clearConvergence          : sinon.stub(),
    emitEvent                 : sinon.stub(),
    getController             : sinon.stub().callsFake((linkKey: string) => controllers.get(linkKey)),
    getRuntimeScope           : sinon.stub().callsFake(() => scope),
    handleDivergence          : sinon.stub().resolves(false),
    handlePushFailures        : sinon.stub().resolves(),
    openPullSubscription      : sinon.stub().resolves(true),
    openPushSubscription      : sinon.stub().resolves(true),
    reconcileTarget           : sinon.stub().resolves({ converged: true }),
    reportError               : sinon.stub(),
    resetPullCheckpoint       : sinon.stub().resolves(),
    setStatus                 : sinon.stub().callsFake(async (state, status) => { state.status = status; }),
    warn                      : sinon.stub(),
  };
  const coordinator = new SyncLinkRecoveryCoordinator({ ...options, operations });
  return {
    controllers,
    coordinator,
    disposeScope: (): void => {
      scope.dispose();
      scope = new SyncRuntime();
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

  it('transitions an exact active link to repairing and supervises the first repair with its resume token', async () => {
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    controller.startPullDelivery(token());
    const resumeToken = token('10');
    const repair = sinon.stub(fixture.coordinator, 'repair').resolves();

    await fixture.coordinator.transitionToRepairing(controller, { resumeToken });
    await waitForLastTask(fixture.taskRunner);

    expect(state.status).toBe('repairing');
    expect(state.connectivity).toBe('offline');
    expect(controller.pullInflightCount).toBe(0);
    expect(controller.repairResumeToken).toEqual(resumeToken);
    expect(repair.calledOnceWithExactly(controller)).toBe(true);
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
    expect(repair.calledOnce).toBe(true);
  });

  it('pauses a link once and clears subscriptions, timers, pull ordering, repair state, and push state', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const closePull = sinon.stub().resolves();
    const closePush = sinon.stub().resolves();
    controller.setLiveSubscription({ close: closePull });
    controller.setLocalSubscription({ close: closePush });
    controller.startPullDelivery(token());
    const runtime = controller.getOrCreatePushRuntime({ did: DID, dwnUrl: REMOTE });
    runtime.entries.push({ cid: 'push-cid' });
    controller.setPushTimer(runtime, setTimeout(() => undefined, 1000));
    controller.setRepairRetryTimer(setTimeout(() => undefined, 1000));
    controller.setReconcileTimer(setTimeout(() => undefined, 1000), 1000);

    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);

    expect(state.status).toBe('paused');
    expect(closePull.calledOnce).toBe(true);
    expect(closePush.calledOnce).toBe(true);
    expect(controller.pullInflightCount).toBe(0);
    expect(controller.pushRuntime).toBeUndefined();
    expect(controller.repairRetryTimer).toBeUndefined();
    expect(controller.reconcileTimer).toBeUndefined();
    expect(fixture.operations.setStatus.calledOnce).toBe(true);
    await clock.runAllAsync();
  });

  it('repairs through durable feeds, restores subscriptions, folds push failures, and schedules the repair-window gap', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ postRepairReconcileDelayMs: 500 });
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
    const [repairTarget, options, shouldContinue] = fixture.operations.reconcileTarget.firstCall.args;
    expect(repairTarget).toEqual(expect.objectContaining({
      did     : DID,
      dwnUrl  : REMOTE,
      linkKey : LINK_KEY,
    }));
    expect(options).toBeUndefined();
    expect(shouldContinue()).toBe(true);
    expect(fixture.operations.resetPullCheckpoint.calledOnceWithExactly(state, token('4'))).toBe(true);
    expect(fixture.operations.openPullSubscription.calledOnceWithExactly(repairTarget, controller)).toBe(true);
    expect(fixture.operations.openPushSubscription.calledOnceWithExactly(repairTarget, controller)).toBe(true);
    expect(fixture.operations.handlePushFailures.calledOnceWithExactly(controller, [failure])).toBe(true);
    expect(state.status).toBe('live');
    expect(state.connectivity).toBe('online');
    expect(controller.mailboxBusy('repair')).toBe(false);
    expect(controller.repairAttempts).toBe(0);
    expect(controller.reconcileTimerDueAt).toBe(500);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type        : 'reconcile:applied',
      messageCids : ['admitted-cid'],
    })).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:completed' })).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'post-repair-gap',
    })).toBe(true);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('emits protocol-scoped repair-completion events without leaking runtime-scope internals', async () => {
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
      // The event scope is the LINK's protocol scope — never the runtime
      // scope handle, whose enumerable internals must not reach subscribers.
      expect(event.protocol).toBe(protocol);
      expect(event.protocols).toEqual([protocol]);
      expect('_disposed' in event).toBe(false);
      expect('_timers' in event).toBe(false);
      expect('disposed' in event).toBe(false);
    }

    controller.deactivate();
    await clock.runAllAsync();
  });

  it('resets and retries a stale pull cursor when subscription open reports ProgressGap', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const gap = Object.assign(new Error('progress gap'), { isProgressGap: true });
    fixture.operations.openPullSubscription.onFirstCall().rejects(gap);
    fixture.operations.openPullSubscription.onSecondCall().resolves(true);

    await fixture.coordinator.repair(controller);

    expect(fixture.operations.openPullSubscription.calledTwice).toBe(true);
    expect(fixture.operations.resetPullCheckpoint.callCount).toBe(2);
    expect(fixture.operations.resetPullCheckpoint.secondCall.calledWithExactly(state)).toBe(true);
    expect(fixture.operations.warn.calledWithMatch('SyncLinkRecoveryCoordinator: Stale pull resume token')).toBe(true);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('abandons a repair whose runtime scope is disposed during durable reconciliation', async () => {
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    let shouldContinue!: () => boolean;
    fixture.operations.reconcileTarget.callsFake(async (_target, _options, predicate) => {
      shouldContinue = predicate;
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      return { converged: true };
    });

    const repairing = fixture.coordinator.repair(controller);
    await reconcileStarted.promise;
    fixture.disposeScope();
    expect(shouldContinue()).toBe(false);
    releaseReconcile.resolve();
    await repairing;

    expect(fixture.operations.resetPullCheckpoint.called).toBe(false);
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
      fixture.disposeScope();
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

  it('guards the production repair-retry timer by scope disposal and consumes it before starting work', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ repairBackoffMs: [1000] });
    const controller = activate(fixture, link('repairing'));
    const repair = sinon.stub(fixture.coordinator, 'repair').resolves();

    fixture.coordinator.scheduleRepairRetry(controller);
    expect(fixture.operations.captureIdentityTaskRunner.calledOnceWithExactly(DID)).toBe(true);
    fixture.operations.captureIdentityTaskRunner.resetHistory();
    fixture.disposeScope();
    await clock.tickAsync(1000);
    expect(repair.called).toBe(false);
    expect(fixture.operations.captureIdentityTaskRunner.notCalled).toBe(true);
    expect(controller.repairRetryTimer).toBeUndefined();

    fixture.coordinator.scheduleRepairRetry(controller);
    await clock.tickAsync(1000);
    await waitForLastTask(fixture.taskRunner);
    expect(repair.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.repairRetryTimer).toBeUndefined();
  });

  it('keeps the earliest reconcile timer and drives the production callback only for its captured scope', async () => {
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
    fixture.disposeScope();
    await clock.tickAsync(100);
    expect(reconcile.calledOnce).toBe(true);
    expect(controller.reconcileTimer).toBeUndefined();
  });

  it('reconciles applied CIDs and convergence, then routes divergence and push failures independently', async () => {
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    fixture.operations.reconcileTarget.onFirstCall().resolves({
      admittedCids : ['applied-cid'],
      converged    : true,
    });

    await fixture.coordinator.reconcile(controller);
    expect(fixture.operations.clearConvergence.calledOnceWithExactly(LINK_KEY)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type        : 'reconcile:applied',
      messageCids : ['applied-cid'],
    })).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'reconcile:completed' })).toBe(true);
    expect(fixture.operations.reconcileTarget.firstCall.args[1]).toEqual({ verifyConvergence: true });
    expect(fixture.operations.reconcileTarget.firstCall.args[2]()).toBe(true);

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
    expect(fixture.operations.handlePushFailures.calledOnceWithExactly(controller, [failure])).toBe(true);
    expect(fixture.operations.handleDivergence.calledOnce).toBe(true);
  });

  it('reports reconciliation failures, schedules retry, and suppresses both after staleness', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ reconcileRetryDelayMs: 5000 });
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

  it('serializes a repair behind an in-flight mailbox flush instead of tearing it down mid-push', async () => {
    const fixture = createFixture();
    const controller = activate(fixture, link('repairing'));
    const releaseFlush = deferred<void>();
    const flush = controller.enqueue(async (): Promise<void> => {
      await releaseFlush.promise;
    }, 'flush');

    const repairing = fixture.coordinator.repair(controller);
    await Promise.resolve();
    expect(controller.mailboxBusy('repair')).toBe(true);
    expect(fixture.operations.reconcileTarget.called).toBe(false);

    releaseFlush.resolve();
    await Promise.all([flush, repairing]);
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
    expect(fixture.operations.reconcileTarget.firstCall.args[1]).toBeUndefined();
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
      throw new Error('socket closed by pause teardown');
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
      throw new Error('socket closed by pause teardown');
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
      .filter((call) => (call.args[1] as { verifyConvergence?: boolean } | undefined)?.verifyConvergence === true);
    expect(verificationPasses.length).toBe(1);
    controller.deactivate();
  });

  it('runs one trailing repair with the newest resume token when a transition lands mid-repair', async () => {
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
    // A fresh gap is detected while the first repair is reopening: the new
    // transition carries a newer resume token and must not be absorbed by
    // the repair already executing.
    const newerToken = token('42');
    await fixture.coordinator.transitionToRepairing(controller, { resumeToken: newerToken });
    releasePull.resolve();
    await repairing;

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.resetPullCheckpoint.secondCall.args[1]).toEqual(newerToken);
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
    const newerToken = token('42');
    void fixture.coordinator.transitionToRepairing(controller, { resumeToken: newerToken });
    await Promise.all(fixture.taskRunner.getCalls().map((call) => call.returnValue));
    await firstTask;

    expect(state.status).toBe('repairing');
    expect(controller.repairRetryTimer).toBeDefined();
    expect(controller.repairResumeToken).toEqual(newerToken);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:completed' })).toBe(false);
    expect(fixture.operations.emitEvent.calledWithMatch({ from: 'repairing', to: 'live' })).toBe(false);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('runs a trailing reconciliation as a new mailbox turn behind an already-queued flush', async () => {
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
    const flush = controller.enqueue(async (): Promise<void> => { order.push('flush'); }, 'flush');
    // The signal lands after the flush was queued: its trailing pass must
    // not jump the mailbox queue.
    const second = fixture.coordinator.reconcile(controller);
    releasePass.resolve();
    await Promise.all([first, flush, second]);

    expect(order).toEqual(['pass-1', 'flush', 'pass-2']);
  });

  it('lets a successful trailing pass subsume the failed pass retry timer', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ reconcileRetryDelayMs: 5000 });
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
    expect(repairController.mailboxBusy('repair')).toBe(false);

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
    expect(reconcileController.mailboxBusy('reconcile')).toBe(false);
  });
});

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value?: Value): void;
  } {
  let resolve!: (value?: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
