import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { createSyncLifecycleDeadline, SyncLifecycleCoordinator } from '../src/sync-lifecycle-coordinator.js';

import { deferred as createDeferred } from './utils/deferred.js';

describe('SyncLifecycleCoordinator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should start the first transition synchronously and serialize later transitions', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const releaseFirst = createDeferred();
    const events: string[] = [];

    const first = coordinator.runTransition(async (): Promise<void> => {
      events.push('first:start');
      await releaseFirst.promise;
      events.push('first:end');
    });
    const second = coordinator.runTransition(async (): Promise<void> => {
      events.push('second');
    });

    expect(events).toEqual(['first:start']);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('should order a synchronously enqueued nested transition after its caller', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const releaseOuter = createDeferred();
    const events: string[] = [];
    let nested!: Promise<void>;

    const outer = coordinator.runTransition(async (): Promise<void> => {
      events.push('outer:start');
      nested = coordinator.runTransition(async (): Promise<void> => {
        events.push('nested');
      });
      await releaseOuter.promise;
      events.push('outer:end');
    });

    expect(events).toEqual(['outer:start']);
    releaseOuter.resolve();
    await Promise.all([outer, nested]);

    expect(events).toEqual(['outer:start', 'outer:end', 'nested']);
  });

  it('should continue the transition queue after an operation rejects', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    let secondRan = false;

    const first = coordinator.runTransition(async (): Promise<void> => {
      throw new Error('transition failed');
    });
    const second = coordinator.runTransition(async (): Promise<void> => {
      secondRan = true;
    });

    await expect(first).rejects.toThrow('transition failed');
    await second;

    expect(secondRan).toBe(true);
  });

  it('should remove an expired transition so it cannot execute later', async () => {
    const clock = sinon.useFakeTimers();
    const coordinator = new SyncLifecycleCoordinator();
    const releaseFirst = createDeferred();
    let expiredRan = false;
    let finalRan = false;

    const first = coordinator.runTransition(async (): Promise<void> => {
      await releaseFirst.promise;
    });
    const expired = coordinator.runTransition(async (): Promise<void> => {
      expiredRan = true;
    }, createSyncLifecycleDeadline(100));
    const observedExpired = expired.catch((error: unknown): unknown => error);
    const final = coordinator.runTransition(async (): Promise<void> => {
      finalRan = true;
    });

    await clock.tickAsync(100);
    expect((await observedExpired as Error).message).toContain('within 100 milliseconds');
    expect(expiredRan).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, final]);

    expect(expiredRan).toBe(false);
    expect(finalRan).toBe(true);
  });

  it('should share one deadline across the transition queue and sync-lock wait', async () => {
    const clock = sinon.useFakeTimers();
    const coordinator = new SyncLifecycleCoordinator();
    const releaseTransition = createDeferred();
    expect(coordinator.tryAcquireSync()).toBe(true);

    const transition = coordinator.runTransition(async (): Promise<void> => {
      await releaseTransition.promise;
    });
    let mutationRan = false;
    const mutation = coordinator.runIdentityMutation(async (): Promise<void> => {
      mutationRan = true;
    }, createSyncLifecycleDeadline(100));
    const observedMutation = mutation.catch((error: unknown): unknown => error);

    await clock.tickAsync(80);
    releaseTransition.resolve();
    await Promise.resolve();
    await clock.tickAsync(19);
    expect(mutationRan).toBe(false);

    await clock.tickAsync(1);
    expect((await observedMutation as Error).message).toContain('within 100 milliseconds');
    expect(mutationRan).toBe(false);

    coordinator.releaseSync();
    await transition;
  });

  it('should serialize identity mutations with sync work and release the lock after failure', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    expect(coordinator.tryAcquireSync()).toBe(true);

    let mutationStarted = false;
    const mutation = coordinator.runIdentityMutation(async (): Promise<void> => {
      mutationStarted = true;
      throw new Error('mutation failed');
    });
    await Promise.resolve();

    expect(mutationStarted).toBe(false);

    coordinator.releaseSync();
    await expect(mutation).rejects.toThrow('mutation failed');

    expect(mutationStarted).toBe(true);
    expect(coordinator.isSyncInProgress).toBe(false);
  });

  it('should report a sync-lock timeout without releasing another owner', async () => {
    const clock = sinon.useFakeTimers();
    const coordinator = new SyncLifecycleCoordinator();
    expect(coordinator.tryAcquireSync()).toBe(true);

    const completion = coordinator.waitForSyncCompletion(200);
    await clock.tickAsync(200);

    expect(await completion).toBe(false);
    expect(coordinator.isSyncInProgress).toBe(true);

    coordinator.releaseSync();
  });

  it('should supervise identity work globally and reject stale groups after replacement', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const did = 'did:example:alice';
    const oldGroup = coordinator.getIdentityTaskGroup(did);
    const releaseTask = createDeferred();

    const task = coordinator.runIdentityTask(oldGroup, async (): Promise<void> => {
      await releaseTask.promise;
    });
    await Promise.resolve();

    expect(coordinator.backgroundTaskCount).toBe(1);

    oldGroup.pause();
    coordinator.deleteIdentityTaskGroup(did, oldGroup);
    const replacementGroup = coordinator.getIdentityTaskGroup(did);
    let staleCalls = 0;
    let replacementCalls = 0;

    await coordinator.runIdentityTask(oldGroup, async (): Promise<void> => { staleCalls++; });
    await coordinator.runIdentityTask(replacementGroup, async (): Promise<void> => { replacementCalls++; });

    expect(staleCalls).toBe(0);
    expect(replacementCalls).toBe(1);

    releaseTask.resolve();
    await task;
    expect(await coordinator.waitForBackgroundTasks()).toBe(true);
  });

  it('should bind captured runners to the original identity group without a fire-time lookup', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const did = 'did:example:alice';
    const getIdentityTaskGroup = sinon.spy(coordinator, 'getIdentityTaskGroup');
    const runIdentityTask = coordinator.captureIdentityTaskRunner(did);
    const originalGroup = coordinator.getIdentityTaskGroup(did);
    originalGroup.pause();
    coordinator.deleteIdentityTaskGroup(did, originalGroup);
    getIdentityTaskGroup.resetHistory();

    let staleCalls = 0;
    await runIdentityTask(async (): Promise<void> => { staleCalls++; });

    expect(staleCalls).toBe(0);
    expect(getIdentityTaskGroup.notCalled).toBe(true);
    expect(coordinator.getIdentityTaskGroup(did)).not.toBe(originalGroup);
  });

  it('should fence one delegate without pausing a replacement or reopening old captures', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const did = 'did:example:alice';
    const first = coordinator.captureIdentityTaskRunner(did, 'did:example:first');
    const second = coordinator.captureIdentityTaskRunner(did, 'did:example:second');
    const firstGroup = coordinator.getIdentityTaskGroups(did, 'did:example:first')[0];
    firstGroup.pause();
    coordinator.deleteIdentityTaskGroup(did, firstGroup);
    coordinator.resumeTaskIntake();
    coordinator.getIdentityTaskGroup(did, 'did:example:first').resume();
    let firstCalls = 0;
    let secondCalls = 0;

    expect(await first(async (): Promise<string> => { firstCalls++; return 'first'; })).toBeUndefined();
    expect(await second(async (): Promise<string> => { secondCalls++; return 'second'; })).toBe('second');
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
    expect(coordinator.getIdentityTaskGroups(did)).toHaveLength(2);
  });

  it('should pause all task intake and resume only the new global runtime', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const oldIdentityGroup = coordinator.getIdentityTaskGroup('did:example:alice');
    let backgroundCalls = 0;
    let identityCalls = 0;

    coordinator.pauseTaskIntake();
    await coordinator.runBackgroundTask(async (): Promise<void> => { backgroundCalls++; });
    await coordinator.runIdentityTask(oldIdentityGroup, async (): Promise<void> => { identityCalls++; });

    coordinator.clearIdentityTaskGroups();
    coordinator.resumeTaskIntake();
    const newIdentityGroup = coordinator.getIdentityTaskGroup('did:example:alice');
    await coordinator.runBackgroundTask(async (): Promise<void> => { backgroundCalls++; });
    await coordinator.runIdentityTask(oldIdentityGroup, async (): Promise<void> => { identityCalls++; });
    await coordinator.runIdentityTask(newIdentityGroup, async (): Promise<void> => { identityCalls++; });

    expect(backgroundCalls).toBe(1);
    expect(identityCalls).toBe(1);
  });

  it('should supervise foreground preparation while background intake stays paused and retain identity fences', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const did = 'did:example:foreground';
    const stale = coordinator.captureIdentityTaskRunner(did, undefined, { foreground: true });
    coordinator.pauseTaskIntake();
    coordinator.clearIdentityTaskGroups();
    const foreground = coordinator.captureIdentityTaskRunner(did, undefined, { foreground: true });
    const release = createDeferred();
    let calls = 0;
    const task = foreground(async (): Promise<string> => { calls++; await release.promise; return 'prepared'; });
    await coordinator.runBackgroundTask(async (): Promise<void> => { calls++; });
    await stale(async (): Promise<void> => { calls++; });
    expect(calls).toBe(1);
    expect(await coordinator.waitForBackgroundTasks(0)).toBe(false);
    release.resolve();
    expect(await task).toBe('prepared');
    expect(await coordinator.waitForBackgroundTasks()).toBe(true);

    const group = coordinator.getIdentityTaskGroup(did);
    group.pause();
    coordinator.deleteIdentityTaskGroup(did, group);
    coordinator.getIdentityTaskGroup(did).resume();
    await foreground(async (): Promise<void> => { calls++; });
    expect(calls).toBe(1);
  });
});
