import type { SyncConnectivityState } from './types/sync.js';
import type { SyncRuntimeHandle } from './sync-runtime.js';

export type SyncConnectivityEventType = 'offline' | 'online' | 'visibilitychange';

/** Browser event boundary used by the connectivity manager and its tests. */
export interface SyncConnectivityEnvironment {
  addEventListener(type: SyncConnectivityEventType, listener: () => void): void;
  getVisibilityState(): string | undefined;
  removeEventListener(type: SyncConnectivityEventType, listener: () => void): void;
}

/** Runtime timer boundary used to keep recovery work inside one sync generation. */
export interface SyncConnectivityRuntimeScope extends SyncRuntimeHandle {
  armTimeout(key: string, callback: () => void, delayMs: number): void;
  clearTimer(key: string): void;
}

export interface SyncConnectivityManagerOperations {
  getRuntimeScope(): SyncConnectivityRuntimeScope;
  markActiveLinksOffline(): void;
  runBackgroundTask(operation: () => Promise<void>): Promise<void>;
  /** Run or queue one full integrity check, coalescing with exclusive sync work. */
  runIntegrityCheck(): Promise<void>;
}

export type SyncConnectivityManagerParams = {
  environment?: SyncConnectivityEnvironment;
  operations: SyncConnectivityManagerOperations;
};

type SyncIntegrityTrigger = 'online' | 'visibility';
type ActiveIntegrityCheck = { scope: SyncConnectivityRuntimeScope };

/**
 * Owns sync connectivity state, poll backoff, per-link state folding, and
 * browser recovery listeners without depending on a persistence backend.
 */
export class SyncConnectivityManager {
  private static readonly RECOVERY_TIMER = 'connectivity-recovery';
  private static readonly MAX_BACKOFF_MULTIPLIER = 4;
  private static readonly MINIMUM_HIDDEN_DURATION_MILLISECONDS = 5_000;
  private static readonly RECOVERY_COOLDOWN_MILLISECONDS = 10_000;
  private readonly _configuredEnvironment: SyncConnectivityEnvironment | undefined;
  private readonly _operations: SyncConnectivityManagerOperations;
  private _activeEnvironment?: SyncConnectivityEnvironment;
  private _activeIntegrityCheck?: ActiveIntegrityCheck;
  private _consecutiveFailures = 0;
  private _hiddenAt?: number;
  private _lastIntegrityCheckStartedAt?: number;
  private _onOffline?: () => void;
  private _onOnline?: () => void;
  private _onVisibilityChange?: () => void;
  private _pendingIntegrityTrigger?: SyncIntegrityTrigger;
  private _scope?: SyncConnectivityRuntimeScope;
  private _state: SyncConnectivityState = 'unknown';

  public constructor({ environment, operations }: SyncConnectivityManagerParams) {
    this._configuredEnvironment = environment;
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
      SyncConnectivityManager.MAX_BACKOFF_MULTIPLIER,
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
    this._hiddenAt = environment.getVisibilityState() === 'hidden' ? Date.now() : undefined;
    this._onOnline = (): void => { this.handleOnline(); };
    this._onOffline = (): void => { this.handleOffline(); };
    this._onVisibilityChange = (): void => { this.handleVisibilityChange(); };

    environment.addEventListener('online', this._onOnline);
    environment.addEventListener('offline', this._onOffline);
    environment.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /** Remove browser recovery listeners from the environment used by start(). */
  public stop(): void {
    this._scope?.clearTimer(SyncConnectivityManager.RECOVERY_TIMER);

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
    this._activeIntegrityCheck = undefined;
    this._hiddenAt = undefined;
    this._lastIntegrityCheckStartedAt = undefined;
    this._scope = undefined;
    this._onOnline = undefined;
    this._onOffline = undefined;
    this._onVisibilityChange = undefined;
    this._pendingIntegrityTrigger = undefined;
  }

  private handleOnline(): void {
    if (!this.isCurrentScope()) {
      return;
    }

    this.scheduleIntegrityCheck('online');
  }

  private handleOffline(): void {
    if (!this.isCurrentScope()) {
      return;
    }

    console.info('SyncConnectivityManager: browser offline');
    this._state = 'offline';
    this._lastIntegrityCheckStartedAt = undefined;
    this._pendingIntegrityTrigger = undefined;
    this._scope?.clearTimer(SyncConnectivityManager.RECOVERY_TIMER);
    this._operations.markActiveLinksOffline();
  }

  private handleVisibilityChange(): void {
    if (!this.isCurrentScope()) {
      return;
    }

    const visibilityState = this._activeEnvironment?.getVisibilityState();
    if (visibilityState !== 'visible') {
      if (visibilityState !== undefined) {
        this._hiddenAt ??= Date.now();
      }
      return;
    }

    const hiddenAt = this._hiddenAt;
    this._hiddenAt = undefined;
    if (
      hiddenAt !== undefined &&
      Date.now() - hiddenAt < SyncConnectivityManager.MINIMUM_HIDDEN_DURATION_MILLISECONDS
    ) {
      return;
    }

    this.scheduleIntegrityCheck('visibility');
  }

  private isCurrentScope(): boolean {
    return this._scope !== undefined && !this._scope.disposed;
  }

  private scheduleIntegrityCheck(trigger: SyncIntegrityTrigger): void {
    const scope = this._scope;
    if (scope === undefined || scope.disposed) {
      return;
    }

    if (this._activeIntegrityCheck?.scope === scope) {
      this.scheduleTrailingIntegrityCheck(scope, trigger);
      return;
    }

    const elapsed = this._lastIntegrityCheckStartedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() - this._lastIntegrityCheckStartedAt;
    if (elapsed < SyncConnectivityManager.RECOVERY_COOLDOWN_MILLISECONDS) {
      this.scheduleTrailingIntegrityCheck(scope, trigger);
      return;
    }

    const check = { scope };
    // This check observes every signal received before it starts. Consume any
    // pending trigger and its timer only after the check has actually committed;
    // paths that cannot start yet leave both intact for a later attempt.
    this._pendingIntegrityTrigger = undefined;
    scope.clearTimer(SyncConnectivityManager.RECOVERY_TIMER);
    this._activeIntegrityCheck = check;
    this._lastIntegrityCheckStartedAt = Date.now();
    const reason = trigger === 'online' ? 'browser online' : 'page visible';
    console.info(`SyncConnectivityManager: ${reason} — starting integrity check`);
    const task = this._operations.runBackgroundTask(async (): Promise<void> => {
      if (scope.disposed) {
        return;
      }

      try {
        await this._operations.runIntegrityCheck();
      } catch (error: unknown) {
        if (scope.disposed) {
          return;
        }
        console.error(`SyncConnectivityManager: post-${trigger} sync failed`, error);
      }
    });
    const complete = (): void => { this.completeIntegrityCheck(check); };
    void task.then(complete, complete);
  }

  private completeIntegrityCheck(check: ActiveIntegrityCheck): void {
    if (this._scope !== check.scope || this._activeIntegrityCheck !== check) {
      return;
    }

    this._activeIntegrityCheck = undefined;
    if (this._pendingIntegrityTrigger !== undefined) {
      this.scheduleTrailingIntegrityCheck(check.scope, this._pendingIntegrityTrigger);
    }
  }

  private flushTrailingIntegrityCheck(scope: SyncConnectivityRuntimeScope): void {
    if (
      this._scope !== scope ||
      scope.disposed ||
      this._activeIntegrityCheck?.scope === scope ||
      this._pendingIntegrityTrigger === undefined
    ) {
      return;
    }

    this.scheduleIntegrityCheck(this._pendingIntegrityTrigger);
  }

  private scheduleTrailingIntegrityCheck(
    scope: SyncConnectivityRuntimeScope,
    trigger: SyncIntegrityTrigger,
  ): void {
    this._pendingIntegrityTrigger ??= trigger;

    const elapsed = this._lastIntegrityCheckStartedAt === undefined
      ? SyncConnectivityManager.RECOVERY_COOLDOWN_MILLISECONDS
      : Date.now() - this._lastIntegrityCheckStartedAt;
    const delay = Math.max(0, SyncConnectivityManager.RECOVERY_COOLDOWN_MILLISECONDS - elapsed);
    if (delay === 0 && this._activeIntegrityCheck?.scope === scope) {
      return;
    }

    scope.armTimeout(
      SyncConnectivityManager.RECOVERY_TIMER,
      (): void => { this.flushTrailingIntegrityCheck(scope); },
      delay,
    );
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
