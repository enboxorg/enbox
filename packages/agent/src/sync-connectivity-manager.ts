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
  cancelTimer(key: string): void;
}

export interface SyncConnectivityManagerOperations {
  getRuntimeScope(): SyncConnectivityRuntimeScope;
  markActiveLinksOffline(): void;
  runBackgroundTask(operation: () => Promise<void>): Promise<void>;
  /** Run one convergence check under the engine's exclusive sync admission. */
  runConvergenceCheck(): Promise<void>;
}

export type SyncConnectivityManagerParams = {
  environment?: SyncConnectivityEnvironment;
  operations: SyncConnectivityManagerOperations;
};

type SyncConvergenceTrigger = 'online' | 'visibility' | 'stream';
type ActiveConvergenceCheck = { scope: SyncConnectivityRuntimeScope };

/**
 * Owns sync connectivity state, per-link state folding, and browser
 * recovery listeners without depending on a persistence backend.
 */
export class SyncConnectivityManager {
  private static readonly RECOVERY_TIMER = 'connectivity-recovery';
  private static readonly MINIMUM_HIDDEN_DURATION_MILLISECONDS = 5_000;
  private static readonly RECOVERY_COOLDOWN_MILLISECONDS = 10_000;
  /**
   * How long a detached stream waits before a recovery check. Must exceed
   * the socket's first reconnect backoff (~500-1000ms with jitter) plus
   * resubscription, so a healthy reconnect wins the race and no check runs.
   */
  private static readonly STREAM_DETACH_DEBOUNCE_MILLISECONDS = 3_000;
  private readonly _configuredEnvironment: SyncConnectivityEnvironment | undefined;
  private readonly _operations: SyncConnectivityManagerOperations;
  private _activeEnvironment?: SyncConnectivityEnvironment;
  private _activeConvergenceCheck?: ActiveConvergenceCheck;
  private _hiddenAt?: number;
  private _lastConvergenceCheckStartedAt?: number;
  private _onOffline?: () => void;
  private _onOnline?: () => void;
  private _onVisibilityChange?: () => void;
  private _pendingConvergenceTrigger?: SyncConvergenceTrigger;
  private _scope?: SyncConnectivityRuntimeScope;
  private _state: SyncConnectivityState = 'unknown';

  public constructor({ environment, operations }: SyncConnectivityManagerParams) {
    this._configuredEnvironment = environment;
    this._operations = operations;
  }

  /** Fold active-link connectivity, falling back to the global one-shot sync state. */
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

  /** Record a successful sync. */
  public recordSuccess(): void {
    this._state = 'online';
  }

  /** Record a failed sync, preserving unknown until reachability was established. */
  public recordFailure(): void {
    if (this._state === 'online') {
      this._state = 'offline';
    }
  }

  /** Update connectivity directly. */
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
    this._scope?.cancelTimer(SyncConnectivityManager.RECOVERY_TIMER);

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
    this._activeConvergenceCheck = undefined;
    this._hiddenAt = undefined;
    this._lastConvergenceCheckStartedAt = undefined;
    this._scope = undefined;
    this._onOnline = undefined;
    this._onOffline = undefined;
    this._onVisibilityChange = undefined;
    this._pendingConvergenceTrigger = undefined;
  }

  private handleOnline(): void {
    if (!this.isCurrentScope()) {
      return;
    }

    this.scheduleConvergenceCheck('online');
  }

  /**
   * Request a coalesced convergence check for a non-browser recovery signal
   * — e.g. a replication stream detaching after its socket's health probe
   * settles. A wake-driven check can complete BEFORE the transport's
   * asynchronous verdict lands; the invalidating signal re-requests
   * evaluation here.
   *
   * Debounced rather than immediate: the transport's own reconnect gets
   * first crack. A socket that reconnects and verifies its resubscription
   * inside the window re-attaches with no check at all — cursor replay,
   * not a reconcile, delivers whatever the outage missed — and only a
   * stream still detached when the timer fires pays a recovery pass. The
   * shared timer and pending-trigger slot integrate with the browser-signal
   * coalescing: whichever deadline fires first flushes one pending check.
   */
  public requestConvergenceCheck(): void {
    const scope = this._scope;
    if (scope === undefined || scope.disposed) {
      return;
    }

    this._pendingConvergenceTrigger ??= 'stream';
    scope.armTimeout(
      SyncConnectivityManager.RECOVERY_TIMER,
      (): void => { this.flushTrailingConvergenceCheck(scope); },
      SyncConnectivityManager.STREAM_DETACH_DEBOUNCE_MILLISECONDS,
    );
  }

  private handleOffline(): void {
    if (!this.isCurrentScope()) {
      return;
    }

    console.info('SyncConnectivityManager: browser offline');
    this._state = 'offline';
    this._lastConvergenceCheckStartedAt = undefined;
    this._pendingConvergenceTrigger = undefined;
    this._scope?.cancelTimer(SyncConnectivityManager.RECOVERY_TIMER);
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

    this.scheduleConvergenceCheck('visibility');
  }

  private isCurrentScope(): boolean {
    return this._scope !== undefined && !this._scope.disposed;
  }

  private static convergenceCheckReason(trigger: SyncConvergenceTrigger): string {
    if (trigger === 'online') {
      return 'browser online';
    }
    return trigger === 'visibility' ? 'page visible' : 'replication stream detached';
  }

  private scheduleConvergenceCheck(trigger: SyncConvergenceTrigger): void {
    const scope = this._scope;
    if (scope === undefined || scope.disposed) {
      return;
    }

    if (this._activeConvergenceCheck?.scope === scope) {
      this.scheduleTrailingConvergenceCheck(scope, trigger);
      return;
    }

    const elapsed = this._lastConvergenceCheckStartedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() - this._lastConvergenceCheckStartedAt;
    if (elapsed < SyncConnectivityManager.RECOVERY_COOLDOWN_MILLISECONDS) {
      this.scheduleTrailingConvergenceCheck(scope, trigger);
      return;
    }

    const check = { scope };
    // This check observes every signal received before it starts. Consume any
    // pending trigger and its timer only after the check has actually committed;
    // paths that cannot start yet leave both intact for a later attempt.
    this._pendingConvergenceTrigger = undefined;
    scope.cancelTimer(SyncConnectivityManager.RECOVERY_TIMER);
    this._activeConvergenceCheck = check;
    this._lastConvergenceCheckStartedAt = Date.now();
    const reason = SyncConnectivityManager.convergenceCheckReason(trigger);
    console.info(`SyncConnectivityManager: ${reason} — checking replication streams`);
    const task = this._operations.runBackgroundTask(async (): Promise<void> => {
      if (scope.disposed) {
        return;
      }

      try {
        await this._operations.runConvergenceCheck();
      } catch (error: unknown) {
        if (scope.disposed) {
          return;
        }
        console.error(`SyncConnectivityManager: post-${trigger} sync failed`, error);
      }
    });
    const complete = (): void => { this.completeConvergenceCheck(check); };
    void task.then(complete, complete);
  }

  private completeConvergenceCheck(check: ActiveConvergenceCheck): void {
    if (this._scope !== check.scope || this._activeConvergenceCheck !== check) {
      return;
    }

    this._activeConvergenceCheck = undefined;
    if (this._pendingConvergenceTrigger !== undefined) {
      this.scheduleTrailingConvergenceCheck(check.scope, this._pendingConvergenceTrigger);
    }
  }

  private flushTrailingConvergenceCheck(scope: SyncConnectivityRuntimeScope): void {
    if (
      this._scope !== scope ||
      scope.disposed ||
      this._activeConvergenceCheck?.scope === scope ||
      this._pendingConvergenceTrigger === undefined
    ) {
      return;
    }

    this.scheduleConvergenceCheck(this._pendingConvergenceTrigger);
  }

  private scheduleTrailingConvergenceCheck(
    scope: SyncConnectivityRuntimeScope,
    trigger: SyncConvergenceTrigger,
  ): void {
    this._pendingConvergenceTrigger ??= trigger;

    const elapsed = this._lastConvergenceCheckStartedAt === undefined
      ? SyncConnectivityManager.RECOVERY_COOLDOWN_MILLISECONDS
      : Date.now() - this._lastConvergenceCheckStartedAt;
    const delay = Math.max(0, SyncConnectivityManager.RECOVERY_COOLDOWN_MILLISECONDS - elapsed);
    if (delay === 0 && this._activeConvergenceCheck?.scope === scope) {
      return;
    }

    scope.armTimeout(
      SyncConnectivityManager.RECOVERY_TIMER,
      (): void => { this.flushTrailingConvergenceCheck(scope); },
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
