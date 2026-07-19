import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncLifecycleCoordinator } from '../src/sync-lifecycle-coordinator.js';

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

  it('should pause all task admission and resume only the new global runtime', async () => {
    const coordinator = new SyncLifecycleCoordinator();
    const oldIdentityGroup = coordinator.getIdentityTaskGroup('did:example:alice');
    let backgroundCalls = 0;
    let identityCalls = 0;

    coordinator.pauseTaskAdmission();
    await coordinator.runBackgroundTask(async (): Promise<void> => { backgroundCalls++; });
    await coordinator.runIdentityTask(oldIdentityGroup, async (): Promise<void> => { identityCalls++; });

    coordinator.clearIdentityTaskGroups();
    coordinator.resumeTaskAdmission();
    const newIdentityGroup = coordinator.getIdentityTaskGroup('did:example:alice');
    await coordinator.runBackgroundTask(async (): Promise<void> => { backgroundCalls++; });
    await coordinator.runIdentityTask(oldIdentityGroup, async (): Promise<void> => { identityCalls++; });
    await coordinator.runIdentityTask(newIdentityGroup, async (): Promise<void> => { identityCalls++; });

    expect(backgroundCalls).toBe(1);
    expect(identityCalls).toBe(1);
  });
});
