/** One armed native interval and the token proving it still owns its key. */
type ArmedInterval = {
  handle: ReturnType<typeof setInterval>;
  token: symbol;
};

/**
 * Ownership scope for one sync runtime generation.
 *
 * Every timer a runtime generation schedules is armed through this scope
 * under a stable key, and `dispose()` cancels them all and refuses further
 * arming.
 *
 * Guarantee: a timer callback never STARTS once its key has been replaced or
 * the scope disposed. Cancelling the native timer alone cannot ensure this —
 * `clearInterval` does not retract a firing the event loop has already
 * queued — so every callback is wrapped in an ownership re-check that turns
 * such stale firings into no-ops.
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
export class SyncRuntime {
  private _disposed = false;
  private readonly _intervals = new Map<string, ArmedInterval>();

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
      if (this._disposed || this._intervals.get(key)?.token !== token) {
        return;
      }
      callback();
    }, delayMs);
    this._intervals.set(key, { handle, token });
  }

  /** Arm a repeating timer only when the key is currently unarmed. */
  public armIntervalIfAbsent(key: string, callback: () => void, delayMs: number): void {
    if (!this._intervals.has(key)) {
      this.armInterval(key, callback, delayMs);
    }
  }

  /** Cancel one owned timer. Safe for unarmed keys and disposed scopes. */
  public clearTimer(key: string): void {
    const armed = this._intervals.get(key);
    if (armed !== undefined) {
      clearInterval(armed.handle);
      this._intervals.delete(key);
    }
  }

  /** Cancel every owned timer and refuse further arming. Idempotent. */
  public dispose(): void {
    this._disposed = true;
    for (const armed of this._intervals.values()) {
      clearInterval(armed.handle);
    }
    this._intervals.clear();
  }
}
