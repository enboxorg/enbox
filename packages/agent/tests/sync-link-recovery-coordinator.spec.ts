import type { SinonStub, SinonStubbedInstance } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncLinkRecoveryCoordinatorOperations } from '../src/sync-link-recovery-coordinator.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncFeedConvergenceManager } from '../src/sync-feed-convergence-manager.js';
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
  feedConvergenceManager: SinonStubbedInstance<SyncFeedConvergenceManager>;
  getRuntime(): SyncRuntime;
  /** Simulate a runtime transition by replacing the current runtime. */
  replaceRuntime(): void;
  operations: RecoveryOperationStubs;
  taskRunner: SinonStub;
};

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example';
const LINK_KEY = `${DID}^${REMOTE}^projection^owner-epoch`;
const RECONCILE_TIMER_KEY = `syncReconcile:${LINK_KEY}`;
const REPAIR_RETRY_TIMER_KEY = `syncRepairRetry:${LINK_KEY}`;

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
  const feedConvergenceManager = sinon.createStubInstance(SyncFeedConvergenceManager);
  feedConvergenceManager.handleVerifiedDivergence.resolves(false);
  const operations: RecoveryOperationStubs = {
    captureIdentityTaskRunner : sinon.stub().returns(taskRunner),
    emitEvent                 : sinon.stub(),
    getController             : sinon.stub().callsFake((linkKey: string) => controllers.get(linkKey)),
    getRuntime                : sinon.stub().callsFake(() => runtime),
    markPullPending           : sinon.stub().callsFake((controller: SyncLinkController) => {
      controller.markPullPending();
    }),
    openPullSubscription : sinon.stub().resolves(true),
    openPushSubscription : sinon.stub().resolves(true),
    reconcileTarget      : sinon.stub().resolves({ converged: true }),
    reportError          : sinon.stub(),
    setStatus            : sinon.stub().callsFake(async (state, status) => { state.status = status; }),
    warn                 : sinon.stub(),
  };
  const coordinator = new SyncLinkRecoveryCoordinator({ ...options, feedConvergenceManager, operations });
  return {
    controllers,
    coordinator,
    feedConvergenceManager,
    getRuntime     : (): SyncRuntime => runtime,
    replaceRuntime : (): void => {
      runtime.dispose();
      runtime = new SyncRuntime();
    },
    operations,
    taskRunner,
  };
}

function activate(fixture: RecoveryFixture, state = link()): SyncLinkController {
  const controller = new SyncLinkController(LINK_KEY, state);
  if (state.status === 'live') {
    controller.markReplicationReady();
  }
  fixture.controllers.set(LINK_KEY, controller);
  return controller;
}

async function waitForLastTask(taskRunner: SinonStub): Promise<void> {
  await taskRunner.lastCall?.returnValue;
}

/** Exercise repair through the production transition and supervised executor path. */
async function runRepair(fixture: RecoveryFixture, controller: SyncLinkController): Promise<void> {
  await fixture.coordinator.transitionToRepairing(controller);
  await waitForLastTask(fixture.taskRunner);
}

/** Exercise a durable wake through the production mark-and-resume path. */
function runWake(
  fixture: RecoveryFixture,
  controller: SyncLinkController,
  kind: 'pull' | 'push',
): Promise<void> {
  controller.executor.request(kind);
  return fixture.coordinator.resume(controller);
}

/** Exercise full reconciliation through the production mark-and-resume path. */
function runReconcile(fixture: RecoveryFixture, controller: SyncLinkController): Promise<void> {
  controller.executor.request('reconcile');
  return fixture.coordinator.resume(controller);
}

describe('SyncLinkRecoveryCoordinator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('publishes repair work before supervising the exact active link', async () => {
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    controller.executor.request('pull');
    controller.executor.request('push');
    fixture.taskRunner.callsFake(async (): Promise<void> => {});

    await fixture.coordinator.transitionToRepairing(controller);

    expect(state.status).toBe('repairing');
    expect(state.connectivity).toBe('offline');
    expect(controller.isReplicationReady).toBe(false);
    expect(controller.executor.hasPending('repair')).toBe(true);
    expect(controller.executor.hasPending('pull')).toBe(true);
    expect(controller.executor.hasPending('push')).toBe(true);
    expect(fixture.taskRunner.calledOnce).toBe(true);
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
    expect(fixture.taskRunner.calledOnce).toBe(true);
  });

  it('marks pull currentness unavailable before repair status persistence settles', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    controller.markPullCurrent(controller.replicationGeneration);
    const persistStatus = deferred<void>();
    fixture.operations.setStatus.callsFake(async (state, status) => {
      await persistStatus.promise;
      state.status = status;
    });
    fixture.taskRunner.callsFake(async (): Promise<void> => {});

    const transition = fixture.coordinator.transitionToRepairing(controller);

    expect(fixture.operations.markPullPending.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.isPullCurrent).toBe(false);
    expect(controller.link.connectivity).toBe('offline');
    persistStatus.resolve();
    await transition;
  });

  it('serializes repair behind an in-flight caller operation', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const operationStarted = deferred<void>();
    const releaseOperation = deferred<void>();
    const staleOperation = fixture.coordinator.execute(controller, async (): Promise<void> => {
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

    expect(controller.executor.hasPending('repair')).toBe(false);
    expect(fixture.taskRunner.called).toBe(false);
    expect(state.status).toBe('paused');
  });

  it('runs an awaited call in its caller ownership boundary', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const operation = sinon.stub().resolves('result');

    expect(await fixture.coordinator.execute(controller, operation)).toBe('result');
    expect(operation.calledOnce).toBe(true);
    expect(fixture.operations.captureIdentityTaskRunner.notCalled).toBe(true);
  });

  it('pauses a link once and clears subscriptions, timers, caller work, and repair state', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    const closePull = sinon.stub().resolves();
    const closePush = sinon.stub().resolves();
    controller.setLiveSubscription({ close: closePull });
    controller.setLocalSubscription({ close: closePush });
    const pull = sinon.stub().resolves();
    const push = sinon.stub().resolves();
    const pendingPull = controller.executor.enqueue(pull);
    const pendingPush = controller.executor.enqueue(push);
    fixture.getRuntime().armTimeout(REPAIR_RETRY_TIMER_KEY, () => undefined, 1000);
    fixture.getRuntime().armTimeout(RECONCILE_TIMER_KEY, () => undefined, 1000);

    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);

    expect(state.status).toBe('paused');
    expect(closePull.calledOnce).toBe(true);
    expect(closePush.calledOnce).toBe(true);
    expect(await pendingPull).toBeUndefined();
    expect(await pendingPush).toBeUndefined();
    expect(pull.notCalled).toBe(true);
    expect(push.notCalled).toBe(true);
    expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(false);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
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
      converged    : false,
      pushFailures : [failure],
    });

    await runRepair(fixture, controller);

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
    expect(controller.executor.hasWork('repair')).toBe(false);
    expect(controller.repairAttempts).toBe(0);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
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

    await runRepair(fixture, controller);

    const completionEvents = fixture.operations.emitEvent.getCalls()
      .map((call) => call.args[0] as Record<string, unknown>)
      .filter((event) => ['repair:completed', 'link:connectivity-change', 'link:status-change']
        .includes(event.type as string));
    expect(completionEvents.some((event) => event.type === 'repair:completed')).toBe(true);
    expect(completionEvents.some((event) =>
      event.type === 'link:connectivity-change' && event.from === 'offline' && event.to === 'online',
    )).toBe(true);
    expect(completionEvents.some((event) =>
      event.type === 'link:status-change' && event.from === 'repairing' && event.to === 'live',
    )).toBe(true);

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

  it('runs a pull pass requested while repair owns the link after repair completes', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link('repairing');
    const controller = activate(fixture, state);
    const repairStarted = deferred<void>();
    const releaseRepair = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      repairStarted.resolve();
      await releaseRepair.promise;
      return { converged: true };
    });
    fixture.operations.reconcileTarget.onSecondCall().resolves({});

    const repairing = runRepair(fixture, controller);
    await repairStarted.promise;

    // A wake during repair can only leave its durable pass mark: readiness is
    // fenced until both subscriptions reopen.
    controller.executor.request('pull');
    releaseRepair.resolve();
    await repairing;
    await waitForLastTask(fixture.taskRunner);

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reconcileTarget.secondCall.args[0]).toBe(controller);
    expect(fixture.operations.reconcileTarget.secondCall.args[2]).toEqual({ direction: 'pull' });
    expect(controller.executor.hasPending('pull')).toBe(false);

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

    const repairing = runRepair(fixture, controller);
    await reconcileStarted.promise;
    fixture.replaceRuntime();
    expect(shouldContinue()).toBe(false);
    releaseReconcile.resolve();
    await repairing;

    expect(fixture.operations.openPullSubscription.called).toBe(false);
    expect(fixture.operations.setStatus.calledOnceWithExactly(state, 'repairing')).toBe(true);
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

    await runRepair(fixture, controller);

    expect(closePull.calledOnce).toBe(true);
    expect(fixture.operations.openPushSubscription.called).toBe(false);
    expect(fixture.operations.setStatus.calledOnceWithExactly(state, 'repairing')).toBe(true);
  });

  it('pauses terminal authorization failures immediately and pauses transient failures at the attempt limit', async () => {
    const fixture = createFixture({ maxRepairAttempts: 3 });
    const terminalState = link('repairing');
    const terminalController = activate(fixture, terminalState);
    fixture.operations.reconcileTarget.rejects(new Error('GrantAuthorizationGrantRevoked'));

    await runRepair(fixture, terminalController);
    expect(terminalState.status).toBe('paused');
    expect(fixture.operations.warn.calledWithMatch('authorization')).toBe(true);

    const transientState = link('repairing');
    const transientController = new SyncLinkController(LINK_KEY, transientState);
    fixture.controllers.set(LINK_KEY, transientController);
    fixture.operations.reconcileTarget.rejects(new Error('offline'));
    await runRepair(fixture, transientController);
    await runRepair(fixture, transientController);
    await runRepair(fixture, transientController);

    expect(transientState.status).toBe('paused');
    expect(transientController.repairAttempts).toBe(0);
    expect(fixture.operations.reportError.callCount).toBe(3);
    expect(fixture.operations.warn.calledWithMatch('Max repair attempts reached')).toBe(true);
  });

  it('guards the production repair-retry timer by runtime disposal and consumes it before starting work', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ repairBackoffMs: [1000] });
    const controller = activate(fixture, link('repairing'));
    fixture.operations.reconcileTarget.rejects(new Error('offline'));

    await runRepair(fixture, controller);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(true);
    fixture.replaceRuntime();
    await clock.tickAsync(1000);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(controller.executor.hasPending('repair')).toBe(false);
    expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(false);

    const currentFixture = createFixture({ repairBackoffMs: [1000] });
    const currentController = activate(currentFixture, link('repairing'));
    currentFixture.operations.reconcileTarget.onFirstCall().rejects(new Error('offline'));
    currentFixture.operations.reconcileTarget.onSecondCall().resolves({ converged: true });
    await runRepair(currentFixture, currentController);
    expect(currentFixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(true);
    await clock.tickAsync(1000);
    await waitForLastTask(currentFixture.taskRunner);
    expect(currentFixture.operations.reconcileTarget.callCount).toBe(2);
    expect(currentFixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(false);
    expect(currentController.link.status).toBe('live');
    currentController.deactivate();
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('keeps the earliest reconcile timer and drives the production callback only for its captured runtime', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);

    expect(fixture.coordinator.scheduleReconcile(controller, 1000)).toBe(true);
    expect(fixture.operations.captureIdentityTaskRunner.calledOnceWithExactly(DID)).toBe(true);
    fixture.operations.captureIdentityTaskRunner.resetHistory();
    expect(fixture.coordinator.scheduleReconcile(controller, 2000)).toBe(false);
    expect(fixture.coordinator.scheduleReconcile(controller, 500)).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
    await clock.tickAsync(500);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.taskRunner.calledOnce).toBe(true);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);

    fixture.coordinator.scheduleReconcile(controller, 100);
    fixture.replaceRuntime();
    await clock.tickAsync(100);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
  });

  it('turns a reconcile timer firing into a supervised executor mark before any I/O', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    fixture.taskRunner.callsFake(async (): Promise<void> => {});

    fixture.coordinator.scheduleReconcile(controller, 10);
    await clock.tickAsync(10);

    expect(controller.executor.hasPending('reconcile')).toBe(true);
    expect(fixture.taskRunner.calledOnce).toBe(true);
    expect(fixture.operations.reconcileTarget.notCalled).toBe(true);
  });

  it('routes convergence, divergence, and retryable push work independently', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const state = link();
    const controller = activate(fixture, state);
    fixture.operations.reconcileTarget.onFirstCall().resolves({
      converged: true,
    });

    await runReconcile(fixture, controller);
    expect(fixture.feedConvergenceManager.clearLink.calledOnceWithExactly(LINK_KEY)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'reconcile:completed' })).toBe(true);
    expect(fixture.operations.reconcileTarget.firstCall.args[0]).toBe(controller);
    expect(fixture.operations.reconcileTarget.firstCall.args[2]).toEqual({ verifyConvergence: true });
    expect(fixture.operations.reconcileTarget.firstCall.args[3]()).toBe(true);

    fixture.operations.reconcileTarget.onSecondCall().resolves({ converged: false });
    await runReconcile(fixture, controller);
    expect(fixture.feedConvergenceManager.handleVerifiedDivergence.calledOnce).toBe(true);
    expect(fixture.feedConvergenceManager.handleVerifiedDivergence.firstCall.args).toEqual([
      expect.objectContaining({ did: DID, dwnUrl: REMOTE }),
      { converged: false },
      { link: state, linkKey: LINK_KEY },
    ]);

    const failure = { cid: 'push-cid', detail: 'retry' };
    fixture.operations.reconcileTarget.onThirdCall().resolves({ pushFailures: [failure] });
    await runReconcile(fixture, controller);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'push-retryable',
    })).toBe(true);
    expect(fixture.feedConvergenceManager.handleVerifiedDivergence.calledOnce).toBe(true);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('coalesces a pull wake burst into one trailing durable-feed pass', async () => {
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

    const first = runWake(fixture, controller, 'pull');
    await passStarted.promise;
    const trailingWakes = Array.from(
      { length: 64 },
      (): Promise<void> => runWake(fixture, controller, 'pull'),
    );
    releasePass.resolve();
    await Promise.all([first, ...trailingWakes]);

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
    fixture.operations.reconcileTarget.onFirstCall().rejects(new Error('remote query failed'));
    fixture.operations.reconcileTarget.onSecondCall().resolves({ converged: true });

    await runWake(fixture, controller, 'pull');

    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(fixture.operations.reportError.firstCall.calledWithMatch('Durable pull pass failed')).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'pull-retryable',
    })).toBe(true);
    await clock.tickAsync(4999);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    await clock.tickAsync(1);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reconcileTarget.secondCall.args[2]).toEqual({ verifyConvergence: true });
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('leaves a deferred pull for the next wake or settle pass without arming a retry loop', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    fixture.operations.reconcileTarget.resolves({
      deferredPull: { messageCid: 'deferred-cid', detail: 'dependency unavailable' },
    });

    await runWake(fixture, controller, 'pull');

    expect(fixture.operations.reportError.notCalled).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
    expect(fixture.operations.emitEvent.calledWithMatch({ reason: 'pull-retryable' })).toBe(false);
  });

  it('does not classify a deferred pull as verified feed divergence', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    fixture.operations.reconcileTarget.resolves({
      deferredPull: { messageCid: 'deferred-cid', detail: 'dependency unavailable' },
    });

    await runReconcile(fixture, controller);

    expect(fixture.feedConvergenceManager.handleVerifiedDivergence.notCalled).toBe(true);
    expect(fixture.feedConvergenceManager.clearLink.notCalled).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'reconcile:completed' })).toBe(false);
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

    const first = runWake(fixture, controller, 'push');
    await passStarted.promise;
    const second = runWake(fixture, controller, 'push');
    const third = runWake(fixture, controller, 'push');
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
    fixture.operations.reconcileTarget.onFirstCall().resolves({
      pushFailures: [{ cid: 'push-cid', detail: 'remote unavailable' }],
    });
    fixture.operations.reconcileTarget.onSecondCall().resolves({ converged: true });

    await runWake(fixture, controller, 'push');

    expect(state.push.contiguousAppliedToken).toEqual(checkpoint);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({
      type   : 'reconcile:needed',
      reason : 'push-retryable',
    })).toBe(true);
    expect(fixture.feedConvergenceManager.clearLink.notCalled).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'reconcile:completed' })).toBe(false);
    await clock.tickAsync(4999);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    await clock.tickAsync(1);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reconcileTarget.secondCall.args[2]).toEqual({ verifyConvergence: true });
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('reports reconciliation failures, schedules retry, and suppresses both after staleness', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    fixture.operations.reconcileTarget.onFirstCall().rejects(new Error('offline'));
    fixture.operations.reconcileTarget.onSecondCall().resolves({ converged: true });

    await runReconcile(fixture, controller);
    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
    await clock.tickAsync(4999);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    await clock.tickAsync(1);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reconcileTarget.secondCall.args[2]).toEqual({ verifyConvergence: true });
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);

    const started = deferred<void>();
    const release = deferred<void>();
    fixture.operations.reconcileTarget.onThirdCall().callsFake(async (): Promise<{ converged: true }> => {
      started.resolve();
      await release.promise;
      throw new Error('late failure');
    });
    const reconciling = runReconcile(fixture, controller);
    await started.promise;
    controller.deactivate();
    release.resolve();
    await reconciling;

    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
    await clock.runAllAsync();
  });

  it('runs repair after an in-flight push pass yields to its generation fence', async () => {
    const fixture = createFixture();
    const controller = activate(fixture);
    const pushStarted = deferred<void>();
    const releasePush = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      pushStarted.resolve();
      await releasePush.promise;
      return { aborted: true };
    });
    fixture.operations.reconcileTarget.onSecondCall().resolves({ converged: true });

    const push = runWake(fixture, controller, 'push');
    await pushStarted.promise;
    const repairing = runRepair(fixture, controller);
    await Promise.resolve();
    expect(controller.executor.hasPending('repair')).toBe(true);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);

    releasePush.resolve();
    await Promise.all([push, repairing]);
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reconcileTarget.firstCall.args[2]).toEqual({ direction: 'push' });
    expect(fixture.operations.reconcileTarget.secondCall.args[2]).toBeUndefined();

    controller.deactivate();
  });

  it('subsumes a reconciliation mark pending before the repair durable pass', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    const gateStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const gate = fixture.coordinator.execute(controller, async (): Promise<void> => {
      gateStarted.resolve();
      await releaseGate.promise;
    });
    await gateStarted.promise;

    const reconciling = runReconcile(fixture, controller);
    const repairing = runRepair(fixture, controller);
    releaseGate.resolve();
    await Promise.all([gate, reconciling, repairing]);

    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    expect(fixture.operations.reconcileTarget.firstCall.args[2]).toBeUndefined();
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
    await clock.tickAsync(499);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
    await clock.tickAsync(1);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reconcileTarget.secondCall.args[2]).toEqual({ verifyConvergence: true });
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
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

    const repairing = runRepair(fixture, controller);
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

    const repairing = runRepair(fixture, controller);
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
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
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

    const reconciling = runReconcile(fixture, controller);
    await started.promise;
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    release.resolve();
    await reconciling;

    expect(fixture.operations.reportError.notCalled).toBe(true);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
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

    const repairing = runRepair(fixture, controller);
    await started.promise;
    await fixture.coordinator.transitionToPaused(LINK_KEY, state);
    release.resolve();
    await repairing;

    expect(fixture.operations.reportError.notCalled).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:failed' })).toBe(false);
    expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(false);
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

    const repairing = runRepair(fixture, controller);
    await repairStarted.promise;
    // An already-armed reconcile timer expires while repair owns the
    // executor, queueing one verification pass behind it.
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

  it('delays a superseding repair even while its status write is pending', async () => {
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

    const repairing = runRepair(fixture, controller);
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

    expect(fixture.operations.reconcileTarget.callCount).toBe(1);
    expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(true);
    await clock.tickAsync(999);
    expect(fixture.operations.reconcileTarget.callCount).toBe(1);
    await clock.tickAsync(1);
    await waitForLastTask(fixture.taskRunner);
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
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ maxRepairAttempts: 1, repairBackoffMs: [1000] });
    const state = link('repairing');
    const controller = activate(fixture, state);
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    fixture.operations.reconcileTarget.onFirstCall().callsFake(async () => {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
      throw new Error('socket closed by supersession');
    });
    fixture.operations.reconcileTarget.onSecondCall().rejects(new Error('offline'));

    const repairing = runRepair(fixture, controller);
    await reconcileStarted.promise;
    const transitioning = fixture.coordinator.transitionToRepairing(controller);
    releaseReconcile.resolve();
    await Promise.all([repairing, transitioning]);

    // The stale failure is a quiet handoff. The trailing repair is the first
    // counted attempt after the supersession backoff, so its genuine failure
    // reports attempt 1 and applies the configured one-attempt limit.
    expect(fixture.operations.reconcileTarget.callCount).toBe(1);
    await clock.tickAsync(1000);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.operations.reportError.calledOnce).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:failed', attempt: 1 })).toBe(true);
    const startedAttempts = fixture.operations.emitEvent.getCalls()
      .map((call) => call.args[0] as { attempt?: number; type: string })
      .filter((event) => event.type === 'repair:started')
      .map((event) => event.attempt);
    expect(startedAttempts).toEqual([1, 1]);
    expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(false);
    expect(state.status).toBe('paused');
    controller.deactivate();
    await clock.runAllAsync();
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

    const repairing = runRepair(fixture, controller);
    await pullOpening.promise;
    // A fresh recovery signal while the first repair is reopening must not be
    // absorbed by the repair already executing.
    await fixture.coordinator.transitionToRepairing(controller);
    releasePull.resolve();
    await repairing;

    expect(fixture.operations.reconcileTarget.callCount).toBe(1);
    await clock.tickAsync(999);
    expect(fixture.operations.reconcileTarget.callCount).toBe(1);
    await clock.tickAsync(1);
    await waitForLastTask(fixture.taskRunner);
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(state.status).toBe('live');
    controller.deactivate();
    await clock.runAllAsync();
  });

  it('bounds sustained repair supersession without consuming the failure-attempt budget', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture({ repairBackoffMs: [1000] });
    const state = link('repairing');
    const controller = activate(fixture, state);
    let passStarted = deferred<void>();
    let releasePass = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async () => {
      passStarted.resolve();
      await releasePass.promise;
      return { converged: true };
    });

    const repairing = runRepair(fixture, controller);
    await passStarted.promise;

    for (let supersession = 0; supersession < 3; supersession++) {
      await fixture.coordinator.transitionToRepairing(controller);
      releasePass.resolve();
      await waitForLastTask(fixture.taskRunner);

      const completedPasses = supersession + 1;
      expect(fixture.operations.reconcileTarget.callCount).toBe(completedPasses);
      expect(controller.repairAttempts).toBe(0);
      expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(true);
      await clock.tickAsync(999);
      expect(fixture.operations.reconcileTarget.callCount).toBe(completedPasses);

      passStarted = deferred<void>();
      releasePass = deferred<void>();
      await clock.tickAsync(1);
      await passStarted.promise;
    }

    releasePass.resolve();
    await waitForLastTask(fixture.taskRunner);
    await repairing;
    expect(fixture.operations.reconcileTarget.callCount).toBe(4);
    expect(state.status).toBe('live');
    expect(controller.repairAttempts).toBe(0);
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
    expect(fixture.getRuntime().hasTimer(REPAIR_RETRY_TIMER_KEY)).toBe(true);
    expect(fixture.operations.emitEvent.calledWithMatch({ type: 'repair:completed' })).toBe(false);
    expect(fixture.operations.emitEvent.calledWithMatch({ from: 'repairing', to: 'live' })).toBe(false);
    controller.deactivate();
    await clock.runAllAsync();
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

    const first = runReconcile(fixture, controller);
    await snapshotTaken.promise;
    const second = runReconcile(fixture, controller);
    releasePass.resolve();
    await Promise.all([first, second]);

    // The trailing pass already covered the failed pass — after the retry
    // deadline there must be no third full reconciliation.
    await clock.tickAsync(5000);
    await clock.runAllAsync();
    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
  });

  it('cancels an armed reconcile retry after a successful full pass', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);

    fixture.coordinator.scheduleReconcile(controller, 5000);
    await runReconcile(fixture, controller);

    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(false);
    await clock.tickAsync(5000);
    expect(fixture.operations.reconcileTarget.calledOnce).toBe(true);
  });

  it('retains a reconcile deadline armed after the active pass starts', async () => {
    const clock = sinon.useFakeTimers();
    const fixture = createFixture();
    const controller = activate(fixture);
    const passStarted = deferred<void>();
    const releasePass = deferred<void>();
    fixture.operations.reconcileTarget.callsFake(async (): Promise<{ converged: true }> => {
      passStarted.resolve();
      await releasePass.promise;
      return { converged: true };
    });

    const reconciling = runReconcile(fixture, controller);
    await passStarted.promise;
    fixture.coordinator.scheduleReconcile(controller, 5000);
    releasePass.resolve();
    await reconciling;

    expect(fixture.getRuntime().hasTimer(RECONCILE_TIMER_KEY)).toBe(true);
    controller.deactivate();
    await clock.runAllAsync();
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

    const reconciling = runReconcile(fixture, controller);
    await snapshotTaken.promise;
    // Two signals land after the running pass queried the remote feed: they
    // are news it cannot have seen, and must coalesce into exactly one
    // trailing pass rather than being absorbed or each running its own.
    const second = runReconcile(fixture, controller);
    const third = runReconcile(fixture, controller);
    releasePass.resolve();
    await Promise.all([reconciling, second, third]);

    expect(fixture.operations.reconcileTarget.callCount).toBe(2);
  });

});
