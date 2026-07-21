import { describe, expect, it } from 'bun:test';

import { runWithCrossContextLock } from '../src/cross-context-lock.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}

describe('runWithCrossContextLock', () => {
  it('serializes operations using one lock name', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = runWithCrossContextLock('cross-context-lock-test', async (): Promise<void> => {
      order.push('first-started');
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      order.push('first-completed');
    });
    await firstStarted.promise;

    const second = runWithCrossContextLock('cross-context-lock-test', async (): Promise<void> => {
      order.push('second-completed');
    });
    await Promise.resolve();

    expect(order).toEqual(['first-started']);

    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);

    expect(order).toEqual(['first-started', 'first-completed', 'second-completed']);
  });

  it('continues a named queue after one operation rejects', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = runWithCrossContextLock('cross-context-lock-rejection', async (): Promise<void> => {
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      throw new Error('first operation failed');
    });
    await firstStarted.promise;

    const second = runWithCrossContextLock('cross-context-lock-rejection', async (): Promise<string> => {
      order.push('second');
      return 'completed';
    });
    releaseFirst.resolve(undefined);

    await expect(first).rejects.toThrow('first operation failed');
    await expect(second).resolves.toBe('completed');
    await expect(runWithCrossContextLock('cross-context-lock-rejection', async (): Promise<string> => {
      order.push('third');
      return 'cleaned';
    })).resolves.toBe('cleaned');
    expect(order).toEqual(['second', 'third']);
  });

  it('allows operations using different lock names to proceed independently', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const first = runWithCrossContextLock('independent-lock-a', async (): Promise<void> => {
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      order.push('first');
    });
    await firstStarted.promise;

    await runWithCrossContextLock('independent-lock-b', async (): Promise<void> => {
      order.push('second');
    });
    expect(order).toEqual(['second']);

    releaseFirst.resolve(undefined);
    await first;
    expect(order).toEqual(['second', 'first']);
  });

  it('delegates browser coordination to the Web Locks API', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
    const requestedNames: string[] = [];
    const lockManager = {
      request: async (name: string, operation: () => Promise<unknown>): Promise<unknown> => {
        requestedNames.push(name);
        return operation();
      },
    } as unknown as LockManager;
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable : true,
      value        : lockManager,
    });

    try {
      await expect(runWithCrossContextLock('browser-lock', async (): Promise<string> => 'result'))
        .resolves.toBe('result');
      expect(requestedNames).toEqual(['browser-lock']);
    } finally {
      restoreProperty(globalThis.navigator, 'locks', originalLocks);
    }
  });

  it('fails closed in a browser context without the Web Locks API', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
    const originalSecureContext = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable : true,
      value        : undefined,
    });
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable : true,
      value        : true,
    });

    try {
      await expect(runWithCrossContextLock('missing-browser-lock', async (): Promise<void> => {}))
        .rejects.toThrow('Cross-context locking requires the Web Locks API.');
    } finally {
      restoreProperty(globalThis.navigator, 'locks', originalLocks);
      restoreProperty(globalThis, 'isSecureContext', originalSecureContext);
    }
  });
});
