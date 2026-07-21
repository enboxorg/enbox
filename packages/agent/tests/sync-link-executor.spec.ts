import { describe, expect, it } from 'bun:test';

import type { SyncLinkWorkKind } from '../src/sync-link-executor.js';

import { SyncLinkExecutor } from '../src/sync-link-executor.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('SyncLinkExecutor', () => {
  it('should retain and coalesce wake work until the replication baseline is ready', async () => {
    const executor = new SyncLinkExecutor();
    const runs: SyncLinkWorkKind[] = [];
    const handler = async (kind: SyncLinkWorkKind): Promise<void> => { runs.push(kind); };

    executor.request('pull');
    executor.request('pull');
    executor.request('push');
    await executor.drain(handler);

    expect(runs).toEqual([]);
    expect(executor.hasPending('pull')).toBe(true);
    expect(executor.hasPending('push')).toBe(true);

    executor.markReady();
    await executor.drain(handler);

    expect(runs).toEqual(['pull', 'push']);
    expect(executor.hasPendingWork).toBe(false);
  });

  it('should run exactly one trailing pass for wakes arriving during a pass', async () => {
    const executor = new SyncLinkExecutor();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let runs = 0;
    executor.markReady();
    executor.request('pull');

    const draining = executor.drain(async (kind): Promise<void> => {
      expect(kind).toBe('pull');
      runs++;
      if (runs === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    await firstStarted.promise;

    executor.request('pull');
    executor.request('pull');
    executor.request('pull');
    releaseFirst.resolve();
    await draining;

    expect(runs).toBe(2);
  });

  it('should preserve ordinary arrival order without starving a trailing direction', async () => {
    const executor = new SyncLinkExecutor();
    const runs: SyncLinkWorkKind[] = [];
    executor.markReady();
    executor.request('pull');
    executor.request('push');

    await executor.drain(async (kind): Promise<void> => {
      runs.push(kind);
      if (runs.length === 1) {
        executor.request('pull');
      }
    });

    expect(runs).toEqual(['pull', 'push', 'pull']);
  });

  it('should coalesce repeated reconnect waves without losing either durable direction', async () => {
    const executor = new SyncLinkExecutor();
    const firstPullStarted = deferred<void>();
    const firstPushStarted = deferred<void>();
    const releaseFirstPull = deferred<void>();
    const releaseFirstPush = deferred<void>();
    const runs: SyncLinkWorkKind[] = [];
    let pullRuns = 0;
    let pushRuns = 0;
    executor.markReady();
    executor.request('pull');
    executor.request('push');

    const draining = executor.drain(async (kind): Promise<void> => {
      runs.push(kind);
      if (kind === 'pull' && ++pullRuns === 1) {
        firstPullStarted.resolve();
        await releaseFirstPull.promise;
      }
      if (kind === 'push' && ++pushRuns === 1) {
        firstPushStarted.resolve();
        await releaseFirstPush.promise;
      }
    });
    await firstPullStarted.promise;

    for (let wave = 0; wave < 64; wave++) {
      executor.request('pull');
      executor.request('push');
    }

    releaseFirstPull.resolve();
    await firstPushStarted.promise;

    for (let wave = 0; wave < 64; wave++) {
      executor.request('pull');
      executor.request('push');
    }

    releaseFirstPush.resolve();
    await draining;

    expect(runs).toEqual(['pull', 'push', 'pull', 'push']);
    expect(executor.hasPendingWork).toBe(false);
  });

  it('should consume only the pending mark already represented by equivalent active work', async () => {
    const executor = new SyncLinkExecutor();
    const runs: SyncLinkWorkKind[] = [];
    executor.markReady();
    executor.request('pull');
    executor.request('push');

    expect(executor.consumePending('pull')).toBe(true);
    expect(executor.consumePending('pull')).toBe(false);
    await executor.drain(async (kind): Promise<void> => { runs.push(kind); });

    expect(runs).toEqual(['push']);
  });

  it('should prioritize repair while retaining ordinary work for the replacement baseline', async () => {
    const executor = new SyncLinkExecutor();
    const runs: SyncLinkWorkKind[] = [];
    executor.request('pull');
    executor.request('push');
    executor.request('repair');

    await executor.drain(async (kind): Promise<void> => {
      runs.push(kind);
      if (kind === 'repair') {
        executor.markReady();
      }
    });

    expect(runs).toEqual(['repair', 'pull', 'push']);
  });

  it('should coalesce a repair burst but retain a repair requested during the active pass', async () => {
    const executor = new SyncLinkExecutor();
    let runs = 0;
    executor.request('repair');
    executor.request('repair');

    await executor.drain(async (kind): Promise<void> => {
      expect(kind).toBe('repair');
      runs++;
      if (runs === 1) {
        executor.request('repair');
        executor.request('repair');
      }
    });

    expect(runs).toBe(2);
  });

  it('should serialize distinct awaited calls and surface their own results', async () => {
    const executor = new SyncLinkExecutor();
    const order: string[] = [];
    executor.markReady();

    const first = executor.enqueue(async (): Promise<string> => {
      order.push('first');
      return 'first-result';
    });
    const second = executor.enqueue(async (): Promise<string> => {
      order.push('second');
      return 'second-result';
    });
    await executor.drain(async (): Promise<void> => {});

    expect(await first).toBe('first-result');
    expect(await second).toBe('second-result');
    expect(order).toEqual(['first', 'second']);
  });

  it('should surface a call rejection without poisoning later executor work', async () => {
    const executor = new SyncLinkExecutor();
    let laterCallRan = false;
    executor.markReady();

    const rejected = executor.enqueue(async (): Promise<void> => {
      throw new Error('call failed');
    });
    const rejection = rejected.catch((error: unknown): unknown => error);
    const resolved = executor.enqueue(async (): Promise<string> => {
      laterCallRan = true;
      return 'later-result';
    });
    await executor.drain(async (): Promise<void> => {});

    expect(await rejection).toEqual(new Error('call failed'));
    expect(await resolved).toBe('later-result');
    expect(laterCallRan).toBe(true);
  });

  it('should surface a handler rejection after settling work already queued behind it', async () => {
    const executor = new SyncLinkExecutor();
    const runs: SyncLinkWorkKind[] = [];
    executor.markReady();
    executor.request('pull');
    const call = executor.enqueue(async (): Promise<string> => 'call-result');
    executor.request('push');

    const draining = executor.drain(async (kind): Promise<void> => {
      runs.push(kind);
      if (kind === 'pull') {
        throw new Error('pull failed');
      }
    });
    const rejection = draining.catch((error: unknown): unknown => error);

    expect(await call).toBe('call-result');
    expect(await rejection).toEqual(new Error('pull failed'));
    expect(runs).toEqual(['pull', 'push']);
  });

  it('should fail calls fast while unready instead of parking them', async () => {
    const executor = new SyncLinkExecutor();
    let ran = false;

    const result = executor.enqueue(async (): Promise<string> => {
      ran = true;
      return 'unexpected';
    });

    expect(await result).toBeUndefined();
    expect(ran).toBe(false);
  });

  it('should resolve queued calls undefined on reset while retaining wake work', async () => {
    const executor = new SyncLinkExecutor();
    let callRan = false;
    executor.markReady();
    executor.request('pull');
    const call = executor.enqueue(async (): Promise<void> => { callRan = true; });

    executor.reset();

    expect(await call).toBeUndefined();
    expect(callRan).toBe(false);
    expect(executor.hasPending('pull')).toBe(true);

    const runs: SyncLinkWorkKind[] = [];
    executor.markReady();
    await executor.drain(async (kind): Promise<void> => { runs.push(kind); });
    expect(runs).toEqual(['pull']);
  });

  it('should fence an active call result when reset lands during the operation', async () => {
    const executor = new SyncLinkExecutor();
    const callStarted = deferred<void>();
    const releaseCall = deferred<void>();
    executor.markReady();
    const call = executor.enqueue(async (): Promise<string> => {
      callStarted.resolve();
      await releaseCall.promise;
      return 'stale';
    });
    const draining = executor.drain(async (): Promise<void> => {});
    await callStarted.promise;

    executor.reset();
    releaseCall.resolve();

    await draining;
    expect(await call).toBeUndefined();
  });

  it('should resolve queued calls and discard wake work on disposal', async () => {
    const executor = new SyncLinkExecutor();
    let callRan = false;
    const runs: SyncLinkWorkKind[] = [];
    executor.markReady();
    executor.request('pull');
    const call = executor.enqueue(async (): Promise<void> => { callRan = true; });

    executor.dispose();
    await executor.drain(async (kind): Promise<void> => { runs.push(kind); });

    expect(await call).toBeUndefined();
    expect(callRan).toBe(false);
    expect(runs).toEqual([]);
    expect(executor.hasPendingWork).toBe(false);
  });
});
