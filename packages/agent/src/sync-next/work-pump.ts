/** One coalesced async activity that releases the runtime after every operation. */
export class SyncNextWorkPump {
  private _disposed = false;
  private _idleWaiters: Array<() => void> = [];
  private _requestedDueAt?: number;
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
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (this._requestedDueAt === undefined || dueAt < this._requestedDueAt) {
      this._requestedDueAt = dueAt;
    }
    if (this._running) {
      return;
    }
    this.scheduleRequested();
  }

  private scheduleRequested(): void {
    if (this._disposed || this._running || this._requestedDueAt === undefined) {
      return;
    }
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout((): void => {
      this._timer = undefined;
      void this.run();
    }, Math.max(0, this._requestedDueAt - Date.now()));
  }

  /** Stop future operations. An already running operation remains lifecycle-fenced by its caller. */
  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._requestedDueAt = undefined;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this.resolveIdleIfReady();
  }

  public waitForIdle(): Promise<void> {
    if (!this._running && this._timer === undefined && this._requestedDueAt === undefined) {
      return Promise.resolve();
    }
    return new Promise((resolve) => { this._idleWaiters.push(resolve); });
  }

  private async run(): Promise<void> {
    if (this._disposed || this._running || this._requestedDueAt === undefined) {
      this.resolveIdleIfReady();
      return;
    }
    if (this._requestedDueAt > Date.now()) {
      this.scheduleRequested();
      return;
    }
    this._requestedDueAt = undefined;
    this._running = true;
    try {
      await this._operation();
    } catch (error: unknown) {
      this._onError(error);
    } finally {
      this._running = false;
      if (this._requestedDueAt !== undefined && !this._disposed) {
        // A native task boundary is the fairness guarantee: requeued page work
        // never loops inside the operation that requested it.
        this.scheduleRequested();
      }
      this.resolveIdleIfReady();
    }
  }

  private resolveIdleIfReady(): void {
    if (this._running || this._timer !== undefined || this._requestedDueAt !== undefined) {
      return;
    }
    for (const resolve of this._idleWaiters.splice(0)) {
      resolve();
    }
  }
}
