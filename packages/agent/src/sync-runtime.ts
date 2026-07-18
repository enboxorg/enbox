/** One armed native timer and the token proving it still owns its key. */
type ArmedTimer = {
  kind: 'interval' | 'timeout';
  handle: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  token: symbol;
};

/**
 * Read-only staleness view of a runtime scope.
 *
 * Collaborators capture the handle when they start work under a runtime
 * generation and re-check `disposed` after awaits: once the scope is
 * disposed, every continuation belonging to that generation is stale.
 */
export interface SyncRuntimeHandle {
  readonly disposed: boolean;
}

/**
 * Ownership scope for one sync runtime generation.
 *
 * Every timer a runtime generation schedules is armed through this scope
 * under a stable key, and `dispose()` cancels them all and refuses further
 * arming.
 *
 * Guarantee: a timer callback never STARTS once its key has been replaced or
 * the scope disposed. Cancelling the native timer alone cannot ensure this —
 * `clearInterval`/`clearTimeout` do not retract a firing the event loop has
 * already queued — so every callback is wrapped in an ownership re-check
 * that turns such stale firings into no-ops.
 *
 * Boundary: work that has already started — in particular an async callback
 * body suspended at an `await` — is beyond any timer scope's reach. Such
 * work must run under lifecycle supervision (task groups) and re-check
 * `disposed` after resuming; the scope only guarantees that no NEW callback
 * bodies begin.
 *
 * Only generation-scoped mechanisms belong here. State that outlives any
 * single start/stop cycle — the exclusive sync lock, durable stores, the
 * target planner and its topology generation — stays with its owner.
 */
export class SyncRuntime implements SyncRuntimeHandle {
  private _disposed = false;
  private readonly _timers = new Map<string, ArmedTimer>();

  /** Whether this runtime generation has been torn down. */
  public get disposed(): boolean {
    return this._disposed;
  }

  /** Arm (or replace) a repeating timer owned by this scope. No-op once disposed. */
  public armInterval(key: string, callback: () => void, delayMs: number): void {
    if (this._disposed) {
      return;
    }
    this.clearTimer(key);
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

  /** Arm a repeating timer only when the key is currently unarmed. */
  public armIntervalIfAbsent(key: string, callback: () => void, delayMs: number): void {
    if (!this._timers.has(key)) {
      this.armInterval(key, callback, delayMs);
    }
  }

  /**
   * Arm (or replace) a one-shot timer owned by this scope. No-op once
   * disposed. The key unarms itself immediately before the callback runs, so
   * the callback may re-arm the same key.
   */
  public armTimeout(key: string, callback: () => void, delayMs: number): void {
    if (this._disposed) {
      return;
    }
    this.clearTimer(key);
    const token = Symbol(key);
    const handle = setTimeout((): void => {
      // Same ownership re-check as intervals: a firing queued before a
      // replacement or disposal must not start the callback.
      if (this._disposed || this._timers.get(key)?.token !== token) {
        return;
      }
      this._timers.delete(key);
      callback();
    }, delayMs);
    this._timers.set(key, { kind: 'timeout', handle, token });
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
  public clearTimers(predicate: (key: string) => boolean): void {
    for (const key of [...this._timers.keys()]) {
      if (predicate(key)) {
        this.clearTimer(key);
      }
    }
  }

  /** Cancel one owned timer. Safe for unarmed keys and disposed scopes. */
  public clearTimer(key: string): void {
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

  private static clearNativeTimer(armed: ArmedTimer): void {
    if (armed.kind === 'interval') {
      clearInterval(armed.handle);
    } else {
      clearTimeout(armed.handle);
    }
  }
}
