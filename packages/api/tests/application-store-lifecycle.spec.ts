import type { ConnectionSnapshot, ConnectionStore } from '../src/connection-store.js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { defineStore } from '../src/store/definition.js';
import { StoreRetiredError } from '../src/store/scope.js';
import { createApplication, defineApplication } from '../src/store/application.js';

function connectionFixture(): { connection: ConnectionStore; disposals(): number } {
  const snapshot: ConnectionSnapshot = Object.freeze({ phase: 'disconnected' });
  const current = async (): Promise<ConnectionSnapshot> => snapshot;
  let disposals = 0;
  return {
    disposals  : (): number => disposals,
    connection : {
      getSnapshot         : (): ConnectionSnapshot => snapshot,
      subscribe           : (): (() => void) => (): void => {},
      initialize          : current,
      connect             : current,
      connectVault        : current,
      refresh             : current,
      refreshDwnEndpoints : current,
      retryRemote         : current,
      disconnect          : current,
      dispose             : async (): Promise<void> => { disposals += 1; },
    },
  };
}

async function microtasks(): Promise<void> { for (let i = 0; i < 12; i += 1) { await Promise.resolve(); } }

describe('application store lifecycle boundaries', () => {
  it('rejects asynchronous factory values and retires their resources immediately', async () => {
    let signal: AbortSignal | undefined;
    let releases = 0;
    const feature = defineStore({
      protocols: {},
      create(context): object {
        signal = context.signal;
        context.onClose((): void => { releases += 1; });
        return Promise.reject(new Error('Invalid asynchronous initialization'));
      },
    });
    const native = connectionFixture();
    const app = createApplication(defineApplication({ stores: { feature } }), native);
    expect(() => app.store(feature)).toThrow('create must return a synchronous feature value');
    expect(signal?.aborted).toBe(true);
    await app.dispose();
    expect(releases).toBe(1);
  });

  it('reports a failed cleanup even when it settled before disposal began', async () => {
    const warning = sinon.stub(console, 'warn');
    const feature = defineStore({
      protocols: {},
      create({ onClose }): never {
        onClose((): never => { throw new Error('Earlier cleanup failed'); });
        throw new Error('Factory failed');
      },
    });
    const native = connectionFixture();
    const app = createApplication(defineApplication({ stores: { feature } }), native);
    try {
      expect(() => app.store(feature)).toThrow('Factory failed');
      await microtasks();
      expect(warning.called).toBe(true);
      await expect(app.dispose()).rejects.toBeInstanceOf(AggregateError);
      expect(native.disposals()).toBe(1);
    } finally {
      await app.dispose().catch((): void => {});
      warning.restore();
    }
  });

  it('awaits a release registered while native connection disposal is pending', async () => {
    let register!: (close: () => Promise<void>) => void;
    let completeConnection!: () => void;
    let completeRelease!: () => void;
    let disposalStarted = false;
    let disposed = false;
    const nativeClose = new Promise<void>((resolve): void => { completeConnection = resolve; });
    const lateRelease = new Promise<void>((resolve): void => { completeRelease = resolve; });
    const feature = defineStore({ protocols: {}, create({ onClose }): object { register = onClose; return {}; } });
    const native = connectionFixture();
    native.connection.dispose = async (): Promise<void> => { disposalStarted = true; await nativeClose; };
    const app = createApplication(defineApplication({ stores: { feature } }), native);
    app.store(feature);
    const disposing = app.dispose().then((): void => { disposed = true; });
    await microtasks();
    expect(disposalStarted).toBe(true);
    register(() => lateRelease);
    completeConnection();
    await microtasks();
    expect(disposed).toBe(false);
    completeRelease();
    await disposing;
    expect(disposed).toBe(true);
  });

  it('revokes a failed factory scope before its error returns to the caller', async () => {
    let leakedSignal: AbortSignal | undefined;
    let cleanupCalls = 0;
    const failed = defineStore({
      protocols : {},
      create    : ({ signal, onClose }): never => {
        leakedSignal = signal;
        onClose((): void => { cleanupCalls += 1; });
        throw new Error('Feature factory failed');
      },
    });
    const native = connectionFixture();
    const app = createApplication(defineApplication({ stores: { failed } }), native);
    expect(() => app.store(failed)).toThrow('Feature factory failed');
    expect(leakedSignal?.aborted).toBe(true);
    expect(leakedSignal?.reason).toBeInstanceOf(StoreRetiredError);
    await app.dispose();
    expect(cleanupCalls).toBe(1);
    expect(native.disposals()).toBe(1);
  });

  it('shares disposal completion when a synchronous abort listener reenters dispose', async () => {
    let reentered: Promise<void> | undefined;
    const feature = defineStore({
      protocols : {},
      create    : ({ signal }): object => {
        signal.addEventListener('abort', (): void => { reentered = app.dispose(); }, { once: true });
        return {};
      },
    });
    const native = connectionFixture();
    const app = createApplication(defineApplication({ stores: { feature } }), native);
    app.store(feature);
    const disposing = app.dispose();
    expect(reentered).toBe(disposing);
    await disposing;
    expect(native.disposals()).toBe(1);
  });

  it('drains remaining resource cleanup after a separate failed-factory cleanup rejects', async () => {
    const warning = sinon.stub(console, 'warn');
    let finishCleanup!: () => void;
    const slowCleanup = new Promise<void>((resolve): void => { finishCleanup = resolve; });
    const slow = defineStore({
      protocols : {},
      create    : ({ onClose }): object => { onClose(() => slowCleanup); return {}; },
    });
    const failed = defineStore({
      protocols : {},
      create    : ({ onClose }): never => {
        onClose((): never => { throw new Error('Failed factory release'); });
        throw new Error('Factory failed');
      },
    });
    const native = connectionFixture();
    const app = createApplication(defineApplication({ stores: { slow, failed } }), native);
    try {
      app.store(slow);
      expect(() => app.store(failed)).toThrow('Factory failed');
      const disposing = app.dispose();
      const rejected = disposing.then((): undefined => undefined, (error: unknown): unknown => error);
      await microtasks();
      expect(native.disposals()).toBe(0);
      finishCleanup();
      expect(await rejected).toBeInstanceOf(AggregateError);
      expect(native.disposals()).toBe(1);
      expect(warning.called).toBe(true);
    } finally {
      finishCleanup();
      await app.dispose().catch((): void => {});
      warning.restore();
    }
  });
});
