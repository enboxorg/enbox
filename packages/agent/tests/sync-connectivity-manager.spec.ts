import type {
  SyncConnectivityEnvironment,
  SyncConnectivityEventType,
  SyncConnectivityManagerOperations,
} from '../src/sync-connectivity-manager.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncConnectivityManager } from '../src/sync-connectivity-manager.js';
import { SyncRuntime } from '../src/sync-runtime.js';

type TestOperationsState = {
  backgroundOperations: Array<() => Promise<void>>;
  scope: SyncRuntime;
  integrityError?: Error;
  integrityChecks: number;
  linksMarkedOffline: number;
  runBackgroundImmediately: boolean;
};

class TestConnectivityEnvironment implements SyncConnectivityEnvironment {
  private readonly _listeners = new Map<SyncConnectivityEventType, Set<() => void>>();
  public visibilityState: string | undefined = 'hidden';

  public addEventListener(type: SyncConnectivityEventType, listener: () => void): void {
    const listeners = this._listeners.get(type) ?? new Set();
    listeners.add(listener);
    this._listeners.set(type, listeners);
  }

  public dispatch(type: SyncConnectivityEventType): void {
    for (const listener of [...this._listeners.get(type) ?? []]) {
      listener();
    }
  }

  public getVisibilityState(): string | undefined {
    return this.visibilityState;
  }

  public listenerCount(type: SyncConnectivityEventType): number {
    return this._listeners.get(type)?.size ?? 0;
  }

  public removeEventListener(type: SyncConnectivityEventType, listener: () => void): void {
    this._listeners.get(type)?.delete(listener);
  }
}

describe('SyncConnectivityManager', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('folds active-link connectivity with online precedence and poll-state fallback', () => {
    const { manager } = setupManager();

    expect(manager.getState([])).toBe('unknown');

    manager.setState('offline');
    expect(manager.getState([])).toBe('offline');
    expect(manager.getState(['unknown'])).toBe('unknown');
    expect(manager.getState(['unknown', 'offline'])).toBe('offline');
    expect(manager.getState(['offline', 'online'])).toBe('online');
  });

  it('tracks sync outcomes and caps exponential poll backoff', () => {
    const { manager } = setupManager();

    manager.recordFailure();
    expect(manager.getState([])).toBe('unknown');
    expect(manager.getPollInterval(100)).toBe(200);

    manager.recordSuccess();
    expect(manager.getState([])).toBe('online');
    expect(manager.getPollInterval(100)).toBe(100);

    manager.recordFailure();
    expect(manager.getState([])).toBe('offline');
    expect(manager.getPollInterval(100)).toBe(200);

    manager.recordFailure();
    expect(manager.getPollInterval(100)).toBe(400);
    manager.recordFailure();
    expect(manager.getPollInterval(100)).toBe(400);
  });

  it('marks connectivity offline and owns browser listener replacement and teardown', () => {
    const environment = new TestConnectivityEnvironment();
    const { manager, state } = setupManager({ environment });
    manager.recordSuccess();

    manager.start();
    manager.start();

    expect(environment.listenerCount('online')).toBe(1);
    expect(environment.listenerCount('offline')).toBe(1);
    expect(environment.listenerCount('visibilitychange')).toBe(1);

    environment.dispatch('offline');

    expect(manager.getState([])).toBe('offline');
    expect(state.linksMarkedOffline).toBe(1);

    manager.stop();
    expect(environment.listenerCount('online')).toBe(0);
    expect(environment.listenerCount('offline')).toBe(0);
    expect(environment.listenerCount('visibilitychange')).toBe(0);

    environment.dispatch('offline');
    expect(state.linksMarkedOffline).toBe(1);
  });

  it('coalesces online and visible recovery signals into one run and one trailing check', async () => {
    const clock = sinon.useFakeTimers();
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager, state } = setupManager({ environment });
    manager.start();

    environment.dispatch('online');
    environment.dispatch('visibilitychange');
    environment.dispatch('online');
    await clock.tickAsync(0);

    expect(state.integrityChecks).toBe(1);

    await clock.tickAsync(9_999);
    expect(state.integrityChecks).toBe(1);

    await clock.tickAsync(1);
    expect(state.integrityChecks).toBe(2);
    manager.stop();
  });

  it('defers a recovery signal that follows a completed check inside the cooldown', async () => {
    const clock = sinon.useFakeTimers();
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager, state } = setupManager({ environment });
    manager.start();

    environment.dispatch('online');
    await clock.tickAsync(0);
    expect(state.integrityChecks).toBe(1);

    await clock.tickAsync(3_000);
    environment.dispatch('visibilitychange');
    await clock.tickAsync(6_999);
    expect(state.integrityChecks).toBe(1);

    await clock.tickAsync(1);
    expect(state.integrityChecks).toBe(2);
    manager.stop();
  });

  it('runs online recovery immediately after offline resets the cooldown', async () => {
    const clock = sinon.useFakeTimers();
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager, state } = setupManager({ environment });
    manager.start();

    environment.dispatch('online');
    await clock.tickAsync(0);
    expect(state.integrityChecks).toBe(1);

    await clock.tickAsync(3_000);
    environment.dispatch('offline');
    await clock.tickAsync(1_000);
    environment.dispatch('online');
    await clock.tickAsync(0);

    expect(state.integrityChecks).toBe(2);
    manager.stop();
  });

  it('cancels deferred recovery and resets its cooldown on stop', async () => {
    const clock = sinon.useFakeTimers();
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager, state } = setupManager({ environment });
    manager.start();

    environment.dispatch('online');
    await clock.tickAsync(0);
    await clock.tickAsync(3_000);
    environment.dispatch('visibilitychange');

    manager.stop();
    await clock.tickAsync(7_000);
    expect(state.integrityChecks).toBe(1);

    manager.start();
    environment.dispatch('online');
    await clock.tickAsync(0);
    expect(state.integrityChecks).toBe(2);
    manager.stop();
  });

  it('logs a deferred recovery only when its integrity check starts', async () => {
    const clock = sinon.useFakeTimers();
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager } = setupManager({ environment });
    const log = sinon.stub(console, 'info');
    manager.start();

    environment.dispatch('online');
    await clock.tickAsync(0);
    expect(log.args).toEqual([[
      'SyncConnectivityManager: browser online — starting integrity check',
    ]]);

    await clock.tickAsync(3_000);
    environment.dispatch('visibilitychange');
    expect(log.callCount).toBe(1);

    await clock.tickAsync(7_000);
    expect(log.args).toEqual([
      ['SyncConnectivityManager: browser online — starting integrity check'],
      ['SyncConnectivityManager: page visible — starting integrity check'],
    ]);
    manager.stop();
  });

  it('ignores a visible event after only a brief hidden period', async () => {
    const clock = sinon.useFakeTimers();
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager, state } = setupManager({ environment });
    manager.start();

    environment.visibilityState = 'hidden';
    environment.dispatch('visibilitychange');
    await clock.tickAsync(4_999);
    environment.visibilityState = 'visible';
    environment.dispatch('visibilitychange');
    await clock.tickAsync(0);

    expect(state.integrityChecks).toBe(0);
    manager.stop();
  });

  it('runs an integrity check after returning from a sustained hidden period', async () => {
    const clock = sinon.useFakeTimers();
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager, state } = setupManager({ environment });
    manager.start();

    environment.visibilityState = 'hidden';
    environment.dispatch('visibilitychange');
    await clock.tickAsync(5_000);
    environment.visibilityState = 'visible';
    environment.dispatch('visibilitychange');
    await clock.tickAsync(0);

    expect(state.integrityChecks).toBe(1);
    manager.stop();
  });

  it('waits for an active recovery check before starting its single trailing check', async () => {
    const clock = sinon.useFakeTimers();
    let releaseIntegrityCheck!: () => void;
    const integrityCheckGate = new Promise<void>((resolve) => {
      releaseIntegrityCheck = resolve;
    });
    const environment = new TestConnectivityEnvironment();
    environment.visibilityState = 'visible';
    const { manager, state } = setupManager({
      environment,
      integrityOperation: async (): Promise<void> => integrityCheckGate,
    });
    manager.start();

    environment.dispatch('online');
    await clock.tickAsync(0);
    environment.dispatch('visibilitychange');
    environment.dispatch('online');
    await clock.tickAsync(10_000);

    expect(state.integrityChecks).toBe(1);

    releaseIntegrityCheck();
    await clock.tickAsync(0);
    expect(state.integrityChecks).toBe(2);
    manager.stop();
  });

  it('rejects stale handlers and queued integrity checks after the runtime scope is disposed', async () => {
    const environment = new TestConnectivityEnvironment();
    const { manager, state } = setupManager({
      environment,
      runBackgroundImmediately: false,
    });
    manager.start();

    environment.dispatch('online');
    expect(state.backgroundOperations).toHaveLength(1);

    state.scope.dispose();
    await state.backgroundOperations[0]();
    environment.dispatch('offline');

    expect(state.integrityChecks).toBe(0);
    expect(state.linksMarkedOffline).toBe(0);
    expect(manager.getState([])).toBe('unknown');
  });

  it('contains integrity-check failures with backend-neutral diagnostics', async () => {
    const environment = new TestConnectivityEnvironment();
    const integrityError = new Error('unreachable');
    const { manager, state } = setupManager({
      environment,
      integrityError,
      runBackgroundImmediately: false,
    });
    const loggedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]): void => { loggedErrors.push(args); };

    try {
      manager.start();
      environment.dispatch('online');
      await state.backgroundOperations[0]();
    } finally {
      console.error = originalConsoleError;
    }

    expect(state.integrityChecks).toBe(1);
    expect(loggedErrors).toEqual([[
      'SyncConnectivityManager: post-online sync failed',
      integrityError,
    ]]);
  });
});

function setupManager(options: {
  environment?: SyncConnectivityEnvironment;
  integrityError?: Error;
  integrityOperation?: () => Promise<void>;
  runBackgroundImmediately?: boolean;
} = {}): { manager: SyncConnectivityManager; state: TestOperationsState } {
  const state: TestOperationsState = {
    backgroundOperations     : [],
    scope                    : new SyncRuntime(),
    integrityError           : options.integrityError,
    integrityChecks          : 0,
    linksMarkedOffline       : 0,
    runBackgroundImmediately : options.runBackgroundImmediately ?? true,
  };
  const operations: SyncConnectivityManagerOperations = {
    getRuntimeScope        : (): SyncRuntime => state.scope,
    markActiveLinksOffline : (): void => { state.linksMarkedOffline++; },
    runBackgroundTask      : async (operation): Promise<void> => {
      if (state.runBackgroundImmediately) {
        await operation();
      } else {
        state.backgroundOperations.push(operation);
      }
    },
    runIntegrityCheck: async (): Promise<void> => {
      state.integrityChecks++;
      if (state.integrityError !== undefined) {
        throw state.integrityError;
      }
      await options.integrityOperation?.();
    },
  };
  return {
    manager: new SyncConnectivityManager({
      environment: options.environment,
      operations,
    }),
    state,
  };
}
