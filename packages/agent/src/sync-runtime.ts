/**
 * Ownership scope for one sync runtime generation.
 *
 * Every timer a runtime generation schedules is armed through this scope
 * under a stable key, and `dispose()` cancels them all and refuses further
 * arming. A callback belonging to a stopped generation therefore never
 * fires — the scope makes stale continuations structurally unreachable
 * instead of requiring each callback to re-check a generation counter.
 *
 * Only generation-scoped mechanisms belong here. State that outlives any
 * single start/stop cycle — the exclusive sync lock, durable stores, the
 * target planner and its topology generation — stays with its owner.
 */
export class SyncRuntime {
  private _disposed = false;
  private readonly _intervals = new Map<string, ReturnType<typeof setInterval>>();

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
    this._intervals.set(key, setInterval(callback, delayMs));
  }

  /** Arm a repeating timer only when the key is currently unarmed. */
  public armIntervalIfAbsent(key: string, callback: () => void, delayMs: number): void {
    if (!this._intervals.has(key)) {
      this.armInterval(key, callback, delayMs);
    }
  }

  /** Cancel one owned timer. Safe for unarmed keys and disposed scopes. */
  public clearTimer(key: string): void {
    const interval = this._intervals.get(key);
    if (interval !== undefined) {
      clearInterval(interval);
      this._intervals.delete(key);
    }
  }

  /** Cancel every owned timer and refuse further arming. Idempotent. */
  public dispose(): void {
    this._disposed = true;
    for (const interval of this._intervals.values()) {
      clearInterval(interval);
    }
    this._intervals.clear();
  }
}
