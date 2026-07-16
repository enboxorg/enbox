/**
 * Owns fire-and-forget sync work so lifecycle transitions can prevent new
 * tasks from starting and wait for work that is already in flight.
 */
export class SyncTaskGroup {
  private _accepting = true;
  private readonly _tasks: Set<Promise<void>> = new Set();

  public get size(): number {
    return this._tasks.size;
  }

  public pause(): void {
    this._accepting = false;
  }

  public resume(): void {
    this._accepting = true;
  }

  /**
   * Starts and observes a task while the group is accepting work. The task's
   * original promise is returned so an awaited callback still sees failures;
   * the internal completion promise prevents ignored callback promises from
   * becoming unhandled rejections.
   */
  public run(operation: () => Promise<void>): Promise<void> {
    if (!this._accepting) {
      return Promise.resolve();
    }

    let task: Promise<void>;
    try {
      task = operation();
    } catch (error: unknown) {
      task = Promise.reject(error);
    }

    const completion = task.then((): void => {}, (): void => {});
    this._tasks.add(completion);
    void completion.then((): void => {
      this._tasks.delete(completion);
    });
    return task;
  }

  /** Waits until all currently owned work settles, optionally with a timeout. */
  public async settle(timeout?: number): Promise<boolean> {
    const idle = this.waitForIdle();
    if (timeout === undefined) {
      await idle;
      return true;
    }

    const timeoutMilliseconds = Number.isFinite(timeout) ? Math.max(0, timeout) : 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout((): void => { resolve(false); }, timeoutMilliseconds);
    });
    const settled = idle.then((): boolean => true);
    const result = await Promise.race([settled, timedOut]);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    return result;
  }

  private async waitForIdle(): Promise<void> {
    while (this._tasks.size > 0) {
      await Promise.all(this._tasks);
    }
  }
}
