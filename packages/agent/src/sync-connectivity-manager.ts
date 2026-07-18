import type { SyncConnectivityState } from './types/sync.js';
import type { SyncRuntimeHandle } from './sync-runtime.js';

export type SyncConnectivityEventType = 'offline' | 'online' | 'visibilitychange';

/** Browser event boundary used by the connectivity manager and its tests. */
export interface SyncConnectivityEnvironment {
  addEventListener(type: SyncConnectivityEventType, listener: () => void): void;
  getVisibilityState(): string | undefined;
  removeEventListener(type: SyncConnectivityEventType, listener: () => void): void;
}

export interface SyncConnectivityManagerOperations {
  getRuntimeScope(): SyncRuntimeHandle;
  isSyncInProgress(): boolean;
  markActiveLinksOffline(): void;
  runBackgroundTask(operation: () => Promise<void>): Promise<void>;
  runIntegrityCheck(): Promise<void>;
}

export type SyncConnectivityManagerParams = {
  environment?: SyncConnectivityEnvironment;
  maxBackoffMultiplier?: number;
  operations: SyncConnectivityManagerOperations;
};

type SyncIntegrityTrigger = 'online' | 'visibility';

/**
 * Owns sync connectivity state, poll backoff, per-link state folding, and
 * browser recovery listeners without depending on a persistence backend.
 */
export class SyncConnectivityManager {
  private readonly _configuredEnvironment: SyncConnectivityEnvironment | undefined;
  private readonly _maxBackoffMultiplier: number;
  private readonly _operations: SyncConnectivityManagerOperations;
  private _activeEnvironment?: SyncConnectivityEnvironment;
  private _consecutiveFailures = 0;
  private _scope?: SyncRuntimeHandle;
  private _onOffline?: () => void;
  private _onOnline?: () => void;
  private _onVisibilityChange?: () => void;
  private _state: SyncConnectivityState = 'unknown';

  public constructor({
    environment,
    maxBackoffMultiplier = 4,
    operations,
  }: SyncConnectivityManagerParams) {
    this._configuredEnvironment = environment;
    this._maxBackoffMultiplier = maxBackoffMultiplier;
    this._operations = operations;
  }

  /** Fold active-link connectivity, falling back to global poll-mode state. */
  public getState(linkStates: Iterable<SyncConnectivityState>): SyncConnectivityState {
    let hasLinks = false;
    let hasOffline = false;

    for (const state of linkStates) {
      hasLinks = true;
      if (state === 'online') {
        return 'online';
      }
      if (state === 'offline') {
        hasOffline = true;
      }
    }

    if (!hasLinks) {
      return this._state;
    }
    return hasOffline ? 'offline' : 'unknown';
  }

  /** Return the current poll interval after bounded exponential backoff. */
  public getPollInterval(intervalMilliseconds: number): number {
    if (this._consecutiveFailures === 0) {
      return intervalMilliseconds;
    }

    const backoffMultiplier = Math.min(
      Math.pow(2, this._consecutiveFailures),
      this._maxBackoffMultiplier,
    );
    return intervalMilliseconds * backoffMultiplier;
  }

  /** Record a successful sync and reset poll-mode failure backoff. */
  public recordSuccess(): void {
    this._consecutiveFailures = 0;
    this._state = 'online';
  }

  /** Record a failed sync, preserving unknown until reachability was established. */
  public recordFailure(): void {
    this._consecutiveFailures++;
    if (this._state === 'online') {
      this._state = 'offline';
    }
  }

  /** Update connectivity without changing poll-mode failure history. */
  public setState(state: SyncConnectivityState): void {
    this._state = state;
  }

  /** Register browser recovery listeners. This is a no-op outside browsers. */
  public start(): void {
    this.stop();

    const environment = this._configuredEnvironment ?? createBrowserConnectivityEnvironment();
    if (environment === undefined) {
      return;
    }

    this._activeEnvironment = environment;
    this._scope = this._operations.getRuntimeScope();
    this._onOnline = (): void => { this.handleOnline(); };
    this._onOffline = (): void => { this.handleOffline(); };
    this._onVisibilityChange = (): void => { this.handleVisibilityChange(); };

    environment.addEventListener('online', this._onOnline);
    environment.addEventListener('offline', this._onOffline);
    environment.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /** Remove browser recovery listeners from the environment used by start(). */
  public stop(): void {
    const environment = this._activeEnvironment;
    if (environment !== undefined) {
      if (this._onOnline !== undefined) {
        environment.removeEventListener('online', this._onOnline);
      }
      if (this._onOffline !== undefined) {
        environment.removeEventListener('offline', this._onOffline);
      }
      if (this._onVisibilityChange !== undefined) {
        environment.removeEventListener('visibilitychange', this._onVisibilityChange);
      }
    }

    this._activeEnvironment = undefined;
    this._scope = undefined;
    this._onOnline = undefined;
    this._onOffline = undefined;
    this._onVisibilityChange = undefined;
  }

  private handleOnline(): void {
    if (!this.isCurrentScope()) {
      return;
    }

    console.info('SyncConnectivityManager: browser online — triggering immediate integrity check');
    this.scheduleIntegrityCheck('online');
  }

  private handleOffline(): void {
    if (!this.isCurrentScope()) {
      return;
    }

    console.info('SyncConnectivityManager: browser offline');
    this._state = 'offline';
    this._operations.markActiveLinksOffline();
  }

  private handleVisibilityChange(): void {
    if (
      !this.isCurrentScope() ||
      this._activeEnvironment?.getVisibilityState() !== 'visible'
    ) {
      return;
    }

    console.info('SyncConnectivityManager: page became visible — triggering integrity check');
    this.scheduleIntegrityCheck('visibility');
  }

  private isCurrentScope(): boolean {
    return this._scope !== undefined && !this._scope.disposed;
  }

  private scheduleIntegrityCheck(trigger: SyncIntegrityTrigger): void {
    if (this._operations.isSyncInProgress()) {
      return;
    }

    const scope = this._scope;
    void this._operations.runBackgroundTask(async (): Promise<void> => {
      if (scope === undefined || scope.disposed) {
        return;
      }

      try {
        await this._operations.runIntegrityCheck();
      } catch (error: unknown) {
        console.error(`SyncConnectivityManager: post-${trigger} sync failed`, error);
      }
    });
  }
}

function createBrowserConnectivityEnvironment(): SyncConnectivityEnvironment | undefined {
  if (
    typeof globalThis.addEventListener !== 'function' ||
    typeof globalThis.removeEventListener !== 'function'
  ) {
    return undefined;
  }

  const visibilityDocument = typeof document === 'undefined' ? undefined : document;
  return {
    addEventListener(type, listener): void {
      if (type === 'visibilitychange') {
        visibilityDocument?.addEventListener(type, listener);
        return;
      }
      globalThis.addEventListener(type, listener);
    },
    getVisibilityState(): string | undefined {
      return visibilityDocument?.visibilityState;
    },
    removeEventListener(type, listener): void {
      if (type === 'visibilitychange') {
        visibilityDocument?.removeEventListener(type, listener);
        return;
      }
      globalThis.removeEventListener(type, listener);
    },
  };
}
