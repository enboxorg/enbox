/** One coalesced async activity that releases the runtime after every operation. */
export class SyncNextWorkPump {
  private _disposed = false;
  private _dueAt?: number;
  private _idleWaiters: Array<() => void> = [];
  private _requested = false;
  private _running = false;
  private _timer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly _operation: () => Promise<void>,
    private readonly _onError: (error: unknown) => void,
  ) {}

  /** Coalesce work under the earliest requested deadline. */
  public request(delayMs = 0): void {
    if (this._disposed) {
      return;
    }
    this._requested = true;
    if (this._running) {
      return;
    }

    const dueAt = Date.now() + Math.max(0, delayMs);
    if (this._timer !== undefined && this._dueAt !== undefined && this._dueAt <= dueAt) {
      return;
    }
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
    }
    this._dueAt = dueAt;
    this._timer = setTimeout((): void => {
      this._timer = undefined;
      this._dueAt = undefined;
      void this.run();
    }, Math.max(0, dueAt - Date.now()));
  }

  /** Stop future operations. An already running operation remains lifecycle-fenced by its caller. */
  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._requested = false;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
      this._dueAt = undefined;
    }
    this.resolveIdleIfReady();
  }

  public waitForIdle(): Promise<void> {
    if (!this._running && this._timer === undefined) {
      return Promise.resolve();
    }
    return new Promise((resolve) => { this._idleWaiters.push(resolve); });
  }

  private async run(): Promise<void> {
    if (this._disposed || this._running || !this._requested) {
      this.resolveIdleIfReady();
      return;
    }
    this._running = true;
    this._requested = false;
    try {
      await this._operation();
    } catch (error: unknown) {
      this._onError(error);
    } finally {
      this._running = false;
      if (this._requested && !this._disposed) {
        // A native task boundary is the fairness guarantee: requeued page work
        // never loops inside the operation that requested it.
        this.request(0);
      }
      this.resolveIdleIfReady();
    }
  }

  private resolveIdleIfReady(): void {
    if (this._running || this._timer !== undefined) {
      return;
    }
    for (const resolve of this._idleWaiters.splice(0)) {
      resolve();
    }
  }
}
