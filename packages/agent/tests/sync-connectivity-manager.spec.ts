import type {
  SyncConnectivityEnvironment,
  SyncConnectivityEventType,
  SyncConnectivityManagerOperations,
} from '../src/sync-connectivity-manager.js';

import { describe, expect, it } from 'bun:test';

import { SyncConnectivityManager } from '../src/sync-connectivity-manager.js';
import { SyncRuntime } from '../src/sync-runtime.js';

type TestOperationsState = {
  backgroundOperations: Array<() => Promise<void>>;
  scope: SyncRuntime;
  integrityError?: Error;
  integrityChecks: number;
  linksMarkedOffline: number;
  runBackgroundImmediately: boolean;
  syncInProgress: boolean;
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
    const { manager } = setupManager({ maxBackoffMultiplier: 4 });

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

  it('runs integrity checks for online and visible events only while idle', async () => {
    const environment = new TestConnectivityEnvironment();
    const { manager, state } = setupManager({ environment });
    manager.start();

    environment.dispatch('visibilitychange');
    expect(state.integrityChecks).toBe(0);

    state.syncInProgress = true;
    environment.dispatch('online');
    expect(state.integrityChecks).toBe(0);

    state.syncInProgress = false;
    environment.dispatch('online');
    await Promise.resolve();
    expect(state.integrityChecks).toBe(1);

    environment.visibilityState = 'visible';
    environment.dispatch('visibilitychange');
    await Promise.resolve();
    expect(state.integrityChecks).toBe(2);
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
  maxBackoffMultiplier?: number;
  runBackgroundImmediately?: boolean;
} = {}): { manager: SyncConnectivityManager; state: TestOperationsState } {
  const state: TestOperationsState = {
    backgroundOperations     : [],
    scope                    : new SyncRuntime(),
    integrityError           : options.integrityError,
    integrityChecks          : 0,
    linksMarkedOffline       : 0,
    runBackgroundImmediately : options.runBackgroundImmediately ?? true,
    syncInProgress           : false,
  };
  const operations: SyncConnectivityManagerOperations = {
    getRuntimeScope        : (): SyncRuntime => state.scope,
    isSyncInProgress       : (): boolean => state.syncInProgress,
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
    },
  };
  return {
    manager: new SyncConnectivityManager({
      environment          : options.environment,
      maxBackoffMultiplier : options.maxBackoffMultiplier,
      operations,
    }),
    state,
  };
}
