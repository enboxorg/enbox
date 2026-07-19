import { describe, expect, it } from 'bun:test';

import { SyncTaskGroup } from '../src/sync-task-group.js';

import { deferred as createDeferred } from './utils/deferred.js';

describe('SyncTaskGroup', () => {
  it('should wait for owned work and tasks it starts before becoming idle', async () => {
    const group = new SyncTaskGroup();
    const releaseChild = createDeferred();

    void group.run(async (): Promise<void> => {
      await Promise.resolve();
      void group.run(async (): Promise<void> => {
        await releaseChild.promise;
      });
    });

    let settled = false;
    const settlePromise = group.settle().then((): void => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);

    releaseChild.resolve();
    await settlePromise;

    expect(group.size).toBe(0);
  });

  it('should reject new work while paused and accept it after resume', async () => {
    const group = new SyncTaskGroup();
    let calls = 0;
    const operation = async (): Promise<void> => { calls++; };

    group.pause();
    await group.run(operation);
    expect(calls).toBe(0);

    group.resume();
    await group.run(operation);
    expect(calls).toBe(1);
  });

  it('should report a timeout without forgetting pending work', async () => {
    const group = new SyncTaskGroup();
    const release = createDeferred();
    void group.run(async (): Promise<void> => { await release.promise; });

    expect(await group.settle(0)).toBe(false);
    expect(group.size).toBe(1);

    release.resolve();
    expect(await group.settle()).toBe(true);
    expect(group.size).toBe(0);
  });

  it('should surface task failures to callers without poisoning settlement', async () => {
    const group = new SyncTaskGroup();
    const task = group.run(async (): Promise<void> => {
      throw new Error('task failed');
    });

    await expect(task).rejects.toThrow('task failed');
    expect(await group.settle()).toBe(true);
    expect(group.size).toBe(0);
  });
});
