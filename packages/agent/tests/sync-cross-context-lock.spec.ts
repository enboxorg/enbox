import { describe, expect, it } from 'bun:test';

import { runWithCrossContextLock } from '../src/sync-cross-context-lock.js';

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
};

describe('runWithCrossContextLock', () => {
  it('serializes operations using one lock name', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = runWithCrossContextLock('sync-cross-context-lock-spec', async (): Promise<void> => {
      order.push('first-started');
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push('first-completed');
    });
    await firstStarted.promise;

    const second = runWithCrossContextLock('sync-cross-context-lock-spec', async (): Promise<void> => {
      order.push('second-completed');
    });
    await Promise.resolve();

    expect(order).toEqual(['first-started']);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-started', 'first-completed', 'second-completed']);
  });

  it('continues a named queue after one operation rejects', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = runWithCrossContextLock('sync-cross-context-lock-rejection', async (): Promise<void> => {
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new Error('first operation failed');
    });
    await firstStarted.promise;

    const second = runWithCrossContextLock('sync-cross-context-lock-rejection', async (): Promise<string> => {
      order.push('second');
      return 'completed';
    });
    releaseFirst.resolve();

    await expect(first).rejects.toThrow('first operation failed');
    await expect(second).resolves.toBe('completed');
    await expect(runWithCrossContextLock('sync-cross-context-lock-rejection', async (): Promise<string> => {
      order.push('third');
      return 'cleaned';
    })).resolves.toBe('cleaned');
    expect(order).toEqual(['second', 'third']);
  });

  function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    const promise = new Promise<Value>((promiseResolve) => {
      resolve = promiseResolve;
    });
    return { promise, resolve };
  }
});
