/** Work coalesced by one active replication link's executor. */
export type SyncLinkWorkKind = 'pull' | 'push' | 'repair' | 'reconcile';

/** Executes one coalesced link-work mark. */
export type SyncLinkWorkHandler = (kind: SyncLinkWorkKind) => Promise<void>;

type SyncLinkCall = {
  operation: () => Promise<unknown>;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
  type: 'call';
};

type SyncLinkWorkMark = {
  kind: SyncLinkWorkKind;
  type: 'mark';
};

type SyncLinkExecutorEntry = SyncLinkCall | SyncLinkWorkMark;

type SyncLinkWorkFailure = {
  reason: unknown;
};

/**
 * Serializes every operation for one active replication link.
 *
 * Wake work is represented by one coalesced mark per kind. Awaited calls are
 * distinct entries because their options, cancellation fences, and results
 * are caller-specific. Repair is the only priority kind; all other eligible
 * entries retain arrival order.
 */
export class SyncLinkExecutor {
  private _active = true;
  private _activeWorkKind?: SyncLinkWorkKind;
  private _drain?: Promise<void>;
  private readonly _entries: SyncLinkExecutorEntry[] = [];
  private readonly _pendingMarks: Map<SyncLinkWorkKind, SyncLinkWorkMark> = new Map();
  private _ready = false;

  /** Whether ordinary link work may run for the current replication generation. */
  public get isReady(): boolean {
    return this._active && this._ready;
  }

  /** Record one wake-work request, coalescing duplicate pending requests. */
  public request(kind: SyncLinkWorkKind): void {
    if (!this._active || this._pendingMarks.has(kind)) {
      return;
    }

    const mark: SyncLinkWorkMark = {
      kind,
      type: 'mark',
    };
    this._pendingMarks.set(kind, mark);
    this._entries.push(mark);
  }

  /** Whether a work mark of `kind` is waiting to run. */
  public hasPending(kind: SyncLinkWorkKind): boolean {
    return this._pendingMarks.has(kind);
  }

  /**
   * Consume a pending mark when the active operation is about to perform the
   * same work. A mark requested after this boundary remains pending.
   */
  public consumePending(kind: SyncLinkWorkKind): boolean {
    const mark = this._pendingMarks.get(kind);
    if (mark === undefined) {
      return false;
    }

    const index = this._entries.indexOf(mark);
    if (index >= 0) {
      this._entries.splice(index, 1);
    }
    this._pendingMarks.delete(kind);
    return true;
  }

  /** Whether work of `kind` is pending or currently executing. */
  public hasWork(kind: SyncLinkWorkKind): boolean {
    return this._activeWorkKind === kind || this.hasPending(kind);
  }

  /** Whether any work mark is waiting to run. */
  public get hasPendingWork(): boolean {
    return this._pendingMarks.size > 0;
  }

  /**
   * Enqueue one caller-specific operation. Calls fail fast while the current
   * replication generation is not ready; they never park behind readiness.
   *
   * An enqueued operation must not await another operation enqueued on this
   * same executor. The nested operation is ordered after its caller and
   * cannot start until that caller settles.
   */
  public enqueue<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!this.isReady) {
      return Promise.resolve(undefined);
    }

    return new Promise<T | undefined>((resolve, reject) => {
      this._entries.push({
        operation,
        reject,
        resolve : (value): void => { resolve(value as T | undefined); },
        type    : 'call',
      });
    });
  }

  /** Allow retained ordinary work to run after its durable baseline exists. */
  public markReady(): void {
    if (this._active) {
      this._ready = true;
    }
  }

  /**
   * Fence caller-specific work for a replaced replication generation while
   * retaining wake marks for the replacement baseline.
   */
  public reset(): void {
    if (!this._active) {
      return;
    }

    this._ready = false;
    this.resolveQueuedCallsUndefined();
  }

  /**
   * Drain eligible entries through one executor owner. Concurrent drain
   * callers join the owner and re-check afterward, so a request landing as
   * the owner settles cannot become stranded.
   */
  public drain(handler: SyncLinkWorkHandler): Promise<void> {
    if (!this._active) {
      return Promise.resolve();
    }

    const activeDrain = this._drain;
    if (activeDrain !== undefined) {
      return activeDrain.then(
        (): Promise<void> => this.drain(handler),
        (): Promise<void> => this.drain(handler),
      );
    }

    const drain = this.drainOwned(handler);
    this._drain = drain;
    const release = (): void => {
      if (this._drain === drain) {
        this._drain = undefined;
      }
    };
    drain.then(release, release);
    return drain;
  }

  /** Reject future work and resolve caller-specific work that never started. */
  public dispose(): void {
    if (!this._active) {
      return;
    }

    this._active = false;
    this._ready = false;
    this._pendingMarks.clear();
    this.resolveQueuedCallsUndefined();
    this._entries.splice(0);
  }

  private async drainOwned(handler: SyncLinkWorkHandler): Promise<void> {
    let workFailure: SyncLinkWorkFailure | undefined;
    while (this._active) {
      const entry = this.takeNextEligibleEntry();
      if (entry === undefined) {
        break;
      }
      const entryFailure = await this.executeEntry(entry, handler);
      workFailure ??= entryFailure;
    }

    if (workFailure !== undefined) {
      throw workFailure.reason;
    }
  }

  private async executeEntry(
    entry: SyncLinkExecutorEntry,
    handler: SyncLinkWorkHandler,
  ): Promise<SyncLinkWorkFailure | undefined> {
    if (entry.type === 'mark') {
      return this.executeMark(entry, handler);
    }

    await this.executeCall(entry);
  }

  private async executeMark(
    mark: SyncLinkWorkMark,
    handler: SyncLinkWorkHandler,
  ): Promise<SyncLinkWorkFailure | undefined> {
    this._activeWorkKind = mark.kind;
    try {
      await handler(mark.kind);
    } catch (reason: unknown) {
      // Surface the first handler failure after every entry already queued
      // behind it has had a chance to settle. A rejected mark must never
      // poison the executor or strand caller-specific promises.
      return { reason };
    } finally {
      this._activeWorkKind = undefined;
    }
  }

  private async executeCall(entry: SyncLinkCall): Promise<void> {
    try {
      const result = await entry.operation();
      if (this.isReady) {
        entry.resolve(result);
      } else {
        entry.resolve(undefined);
      }
    } catch (error: unknown) {
      if (this.isReady) {
        entry.reject(error);
      } else {
        entry.resolve(undefined);
      }
    }
  }

  private takeNextEligibleEntry(): SyncLinkExecutorEntry | undefined {
    const repairIndex = this._entries.findIndex(
      (entry): boolean => entry.type === 'mark' && entry.kind === 'repair',
    );
    let index = -1;
    if (repairIndex >= 0) {
      index = repairIndex;
    } else if (this._ready) {
      index = 0;
    }
    if (index < 0) {
      return;
    }

    const [entry] = this._entries.splice(index, 1);
    if (entry?.type === 'mark' && this._pendingMarks.get(entry.kind) === entry) {
      this._pendingMarks.delete(entry.kind);
    }
    return entry;
  }

  private resolveQueuedCallsUndefined(): void {
    for (let index = this._entries.length - 1; index >= 0; index--) {
      const entry = this._entries[index];
      if (entry?.type === 'call') {
        this._entries.splice(index, 1);
        entry.resolve(undefined);
      }
    }
  }
}
