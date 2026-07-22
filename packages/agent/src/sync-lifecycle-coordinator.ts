import { SyncTaskGroup } from './sync-task-group.js';

/** Starts work in one identity task group captured for a specific runtime lifetime. */
export type SyncIdentityTaskRunner = (operation: () => Promise<void>) => Promise<void>;

/** One absolute wait budget shared by every pre-operation lifecycle barrier. */
export type SyncLifecycleDeadline = {
  readonly expiresAt: number;
  readonly timeout: number;
};

/** Create a lifecycle deadline from a validated timeout in milliseconds. */
export function createSyncLifecycleDeadline(timeout: number): SyncLifecycleDeadline {
  return {
    expiresAt: Date.now() + timeout,
    timeout,
  };
}

/** Milliseconds left in one lifecycle deadline, clamped at zero. */
export function remainingSyncLifecycleTimeout(deadline: SyncLifecycleDeadline): number {
  return Math.max(0, deadline.expiresAt - Date.now());
}

/**
 * Coordinates sync lifecycle transitions, exclusive sync operations, and
 * supervised background work without depending on a persistence backend.
 *
 * Runtime disposal remains the responsibility of the owning sync
 * engine. This coordinator only provides the ordering and task-intake
 * primitives needed to dispose it safely.
 */
export class SyncLifecycleCoordinator {
  private readonly _backgroundTasks = new SyncTaskGroup();
  private readonly _identityTaskGroups: Map<string, SyncTaskGroup> = new Map();
  private _releaseSyncCompletion?: () => void;
  private _syncCompletion: Promise<void> = Promise.resolve();
  private _syncInProgress = false;
  private _transition?: Promise<void>;

  /** Number of globally supervised background tasks still in flight. */
  public get backgroundTaskCount(): number {
    return this._backgroundTasks.size;
  }

  /** Whether a one-shot sync, drain, retry, or identity mutation owns the lock. */
  public get isSyncInProgress(): boolean {
    return this._syncInProgress;
  }

  /**
   * Serializes lifecycle transitions while allowing the first operation to
   * start synchronously. A deadline only bounds the wait to START: an entry
   * that expires in the queue is removed and can never execute later.
   *
   * An operation must not await another transition enqueued on this same
   * coordinator: the nested entry is ordered after its caller and therefore
   * cannot start until that caller settles.
   */
  public runTransition(
    operation: (deadline?: SyncLifecycleDeadline) => Promise<void>,
    deadline?: SyncLifecycleDeadline,
  ): Promise<void> {
    const previous = this._transition;
    let releaseCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    this._transition = completion;
    void completion.then((): void => {
      if (this._transition === completion) {
        this._transition = undefined;
      }
    });

    let cancelled = false;
    let started = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      if (previous !== undefined &&
        deadline !== undefined &&
        remainingSyncLifecycleTimeout(deadline) === 0) {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        throw this.transitionTimeoutError(deadline);
      }

      started = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      await operation(deadline);
    };

    const transition = previous === undefined ? run() : previous.then(run);
    void transition.then(releaseCompletion, releaseCompletion);

    if (previous === undefined || deadline === undefined) {
      return transition;
    }

    return new Promise<void>((resolve, reject) => {
      transition.then(resolve, reject);
      timeoutId = setTimeout((): void => {
        if (started) {
          return;
        }
        cancelled = true;
        reject(this.transitionTimeoutError(deadline));
      }, remainingSyncLifecycleTimeout(deadline));
    });
  }

  /** Serializes an identity mutation with lifecycle transitions and exclusive sync work. */
  public runIdentityMutation(
    operation: (deadline?: SyncLifecycleDeadline) => Promise<void>,
    deadline?: SyncLifecycleDeadline,
  ): Promise<void> {
    return this.runTransition(async (activeDeadline): Promise<void> => {
      if (activeDeadline === undefined) {
        await this.acquireSync();
      } else if (!await this.acquireSyncBefore(activeDeadline)) {
        throw new Error(
          `SyncLifecycleCoordinator: Existing sync operation did not complete within ${activeDeadline.timeout} milliseconds.`,
        );
      }
      try {
        await operation(activeDeadline);
      } finally {
        this.releaseSync();
      }
    }, deadline);
  }

  /** Acquires the exclusive sync lock when it is currently available. */
  public tryAcquireSync(): boolean {
    if (this._syncInProgress) {
      return false;
    }

    this._syncInProgress = true;
    this._syncCompletion = new Promise<void>((resolve) => {
      this._releaseSyncCompletion = resolve;
    });
    return true;
  }

  /** Waits until the exclusive sync lock can be acquired. */
  public async acquireSync(): Promise<void> {
    while (!this.tryAcquireSync()) {
      await this._syncCompletion;
    }
  }

  /** Acquires the exclusive sync lock before an optional absolute deadline. */
  public async acquireSyncBefore(deadline: SyncLifecycleDeadline): Promise<boolean> {
    while (!this.tryAcquireSync()) {
      const remaining = remainingSyncLifecycleTimeout(deadline);
      if (remaining === 0 || !await this.waitForPromise(this._syncCompletion, remaining)) {
        return false;
      }
    }
    return true;
  }

  /** Releases the exclusive sync lock and wakes queued acquirers. */
  public releaseSync(): void {
    this._syncInProgress = false;
    const release = this._releaseSyncCompletion;
    this._releaseSyncCompletion = undefined;
    release?.();
  }

  /**
   * Waits for the exclusive sync lock to clear. Returns `false` when the
   * optional timeout expires so the owning engine can preserve its own error
   * policy and wording.
   */
  public async waitForSyncCompletion(timeout?: number): Promise<boolean> {
    const expiresAt = timeout === undefined ? undefined : Date.now() + Math.max(0, timeout);

    while (this._syncInProgress) {
      if (expiresAt === undefined) {
        await this._syncCompletion;
        continue;
      }

      const remaining = Math.max(0, expiresAt - Date.now());
      if (remaining === 0 || !await this.waitForPromise(this._syncCompletion, remaining)) {
        return false;
      }
    }

    return true;
  }

  /** Starts globally supervised background work while task intake is open. */
  public runBackgroundTask(operation: () => Promise<void>): Promise<void> {
    return this._backgroundTasks.run(operation);
  }

  /** Returns the stable task group for an identity in the current runtime. */
  public getIdentityTaskGroup(did: string): SyncTaskGroup {
    let taskGroup = this._identityTaskGroups.get(did);
    if (taskGroup === undefined) {
      taskGroup = new SyncTaskGroup();
      this._identityTaskGroups.set(did, taskGroup);
    }
    return taskGroup;
  }

  /** Whether an existing identity task group still owns work. */
  public hasIdentityTasks(did: string): boolean {
    return (this._identityTaskGroups.get(did)?.size ?? 0) > 0;
  }

  /** Bind a runner to the current identity group without resolving it again at fire time. */
  public captureIdentityTaskRunner(did: string): SyncIdentityTaskRunner {
    const taskGroup = this.getIdentityTaskGroup(did);
    return (operation): Promise<void> => this.runIdentityTask(taskGroup, operation);
  }

  /** Starts work supervised by both the global runtime and an identity task group. */
  public runIdentityTask(taskGroup: SyncTaskGroup, operation: () => Promise<void>): Promise<void> {
    return this._backgroundTasks.run(() => taskGroup.run(operation));
  }

  /** Prevents new global and per-identity background work from starting. */
  public pauseTaskIntake(): void {
    this._backgroundTasks.pause();
    for (const taskGroup of this._identityTaskGroups.values()) {
      taskGroup.pause();
    }
  }

  /** Reopens global background-task intake for a new runtime. */
  public resumeTaskIntake(): void {
    this._backgroundTasks.resume();
  }

  /** Waits for all globally supervised background work to settle. */
  public waitForBackgroundTasks(timeout?: number): Promise<boolean> {
    return this._backgroundTasks.settle(timeout);
  }

  /** Discards all identity task groups after their globally supervised work has settled. */
  public clearIdentityTaskGroups(): void {
    this._identityTaskGroups.clear();
  }

  /** Removes an identity task group only if it is still the current group for that DID. */
  public deleteIdentityTaskGroup(did: string, taskGroup: SyncTaskGroup): void {
    if (this._identityTaskGroups.get(did) === taskGroup) {
      this._identityTaskGroups.delete(did);
    }
  }

  private transitionTimeoutError(deadline: SyncLifecycleDeadline): Error {
    return new Error(
      `SyncLifecycleCoordinator: Earlier lifecycle transition did not complete within ${deadline.timeout} milliseconds.`,
    );
  }

  private async waitForPromise(completion: Promise<void>, timeout: number): Promise<boolean> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout((): void => { resolve(false); }, timeout);
    });
    const completed = completion.then((): boolean => true);
    const result = await Promise.race([completed, timedOut]);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    return result;
  }
}
