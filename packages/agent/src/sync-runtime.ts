/** One armed native timer and the token proving it still owns its key. */
type ArmedTimer = {
  dueAt?: number;
  kind: 'interval' | 'timeout';
  handle: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  token: symbol;
};

/**
 * Read-only staleness view of a runtime.
 *
 * Collaborators capture the handle when they start work under a runtime and
 * re-check `disposed` after awaits: once the runtime is disposed, every
 * continuation belonging to that runtime is stale.
 */
export interface SyncRuntimeHandle {
  readonly disposed: boolean;
}

/**
 * Timer owner for one sync runtime.
 *
 * Every timer is armed through this runtime under a stable key, and `dispose()`
 * cancels them all and refuses further arming.
 *
 * Guarantee: a timer callback never STARTS once its key has been replaced or
 * the runtime disposed. Cancelling the native timer alone cannot ensure this —
 * `clearInterval`/`clearTimeout` do not retract a firing the event loop has
 * already queued — so every callback is wrapped in an ownership re-check
 * that turns such stale firings into no-ops.
 *
 * Boundary: work that has already started — in particular an async callback
 * body suspended at an `await` — is beyond any timer owner's reach. Such
 * work must run under lifecycle supervision (task groups) and re-check
 * `disposed` after resuming; the runtime only guarantees that no NEW callback
 * bodies begin.
 *
 * Only runtime-owned mechanisms belong here. State that outlives any single
 * start/stop cycle — the exclusive sync lock, durable stores, the target
 * planner and its topology generation — stays with its owner.
 */
export class SyncRuntime implements SyncRuntimeHandle {
  private _disposed = false;
  private readonly _live: boolean;
  private readonly _timers = new Map<string, ArmedTimer>();

  public constructor(live = false) {
    this._live = live;
  }

  /** Whether this runtime has been disposed. */
  public get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Whether this is a started live-sync runtime. A disposed runtime is never
   * live, exactly as the engine between runtimes is not.
   */
  public get live(): boolean {
    return !this._disposed && this._live;
  }

  /** Arm (or replace) a repeating timer owned by this runtime. No-op once disposed. */
  public armInterval(key: string, callback: () => void, delayMs: number): void {
    if (this._disposed) {
      return;
    }
    this.cancelTimer(key);
    const token = Symbol(key);
    const handle = setInterval((): void => {
      // A firing queued before a replacement or disposal still reaches here;
      // the ownership check is what makes it a no-op rather than stale work.
      if (this._disposed || this._timers.get(key)?.token !== token) {
        return;
      }
      callback();
    }, delayMs);
    this._timers.set(key, { kind: 'interval', handle, token });
  }

  /**
   * Arm (or replace) a one-shot timer owned by this runtime. No-op once
   * disposed. The key unarms itself immediately before the callback runs, so
   * the callback may re-arm the same key.
   */
  public armTimeout(key: string, callback: () => void, delayMs: number): void {
    if (this._disposed) {
      return;
    }

    this.armTimeoutAt(key, callback, Date.now() + Math.max(0, delayMs));
  }

  /**
   * Arm a one-shot timer unless the same key is already due no later. This is
   * the runtime-owned earliest-wins policy used by coalesced link work.
   *
   * @returns Whether this request armed or replaced the timer.
   */
  public armTimeoutIfEarlier(key: string, callback: () => void, delayMs: number): boolean {
    if (this._disposed) {
      return false;
    }

    const dueAt = Date.now() + Math.max(0, delayMs);
    const existing = this._timers.get(key);
    if (existing?.kind === 'timeout' && existing.dueAt !== undefined && existing.dueAt <= dueAt) {
      return false;
    }

    this.armTimeoutAt(key, callback, dueAt);
    return true;
  }

  /** Whether one exact timer key is currently armed. */
  public hasTimer(key: string): boolean {
    return this._timers.has(key);
  }

  /** Whether any armed timer's key satisfies the predicate. */
  public hasTimers(predicate: (key: string) => boolean): boolean {
    for (const key of this._timers.keys()) {
      if (predicate(key)) {
        return true;
      }
    }
    return false;
  }

  /** Cancel every owned timer whose key satisfies the predicate. */
  public cancelTimers(predicate: (key: string) => boolean): void {
    for (const key of [...this._timers.keys()]) {
      if (predicate(key)) {
        this.cancelTimer(key);
      }
    }
  }

  /** Cancel one owned timer. Safe for unarmed keys and disposed runtimes. */
  public cancelTimer(key: string): void {
    const armed = this._timers.get(key);
    if (armed !== undefined) {
      SyncRuntime.clearNativeTimer(armed);
      this._timers.delete(key);
    }
  }

  /** Cancel every owned timer and refuse further arming. Idempotent. */
  public dispose(): void {
    this._disposed = true;
    for (const armed of this._timers.values()) {
      SyncRuntime.clearNativeTimer(armed);
    }
    this._timers.clear();
  }

  private armTimeoutAt(key: string, callback: () => void, dueAt: number): void {
    this.cancelTimer(key);
    const token = Symbol(key);
    const handle = setTimeout((): void => {
      // Same ownership re-check as intervals: a firing queued before a
      // replacement or disposal must not start the callback.
      if (this._disposed || this._timers.get(key)?.token !== token) {
        return;
      }
      this._timers.delete(key);
      callback();
    }, Math.max(0, dueAt - Date.now()));
    this._timers.set(key, { dueAt, kind: 'timeout', handle, token });
  }

  private static clearNativeTimer(armed: ArmedTimer): void {
    if (armed.kind === 'interval') {
      clearInterval(armed.handle);
    } else {
      clearTimeout(armed.handle);
    }
  }
}
