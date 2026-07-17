import { sleep } from '@enbox/common';

import { SyncTaskGroup } from './sync-task-group.js';

/** Starts work in one identity task group captured for a specific runtime lifetime. */
export type SyncIdentityTaskRunner = (operation: () => Promise<void>) => Promise<void>;

/**
 * Coordinates sync lifecycle transitions, exclusive sync operations, and
 * supervised background work without depending on a persistence backend.
 *
 * Runtime-specific teardown remains the responsibility of the owning sync
 * engine. This coordinator only provides the ordering and task-admission
 * primitives needed to perform that teardown safely.
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
   * start synchronously.
   */
  public runTransition(operation: () => Promise<void>): Promise<void> {
    const previous = this._transition;
    const transition = previous === undefined ? operation() : previous.then(operation);
    const clearTransition = (): void => {
      if (this._transition === completion) {
        this._transition = undefined;
      }
    };
    const completion = transition.then(clearTransition, clearTransition);
    this._transition = completion;
    return transition;
  }

  /** Serializes an identity mutation with lifecycle transitions and exclusive sync work. */
  public runIdentityMutation(operation: () => Promise<void>): Promise<void> {
    return this.runTransition(async (): Promise<void> => {
      await this.acquireSync();
      try {
        await operation();
      } finally {
        this.releaseSync();
      }
    });
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
    let elapsedTimeout = 0;

    while (this._syncInProgress) {
      if (timeout !== undefined && elapsedTimeout >= timeout) {
        return false;
      }

      const waitDuration = timeout === undefined
        ? 100
        : Math.min(Math.max(timeout - elapsedTimeout, 0), 100);
      elapsedTimeout += waitDuration;
      await Promise.race([this._syncCompletion, sleep(waitDuration)]);
    }

    return true;
  }

  /** Starts globally supervised background work while task admission is open. */
  public runBackgroundTask(operation: () => Promise<void>): Promise<void> {
    return this._backgroundTasks.run(operation);
  }

  /** Returns the stable task group for an identity in the current runtime generation. */
  public getIdentityTaskGroup(did: string): SyncTaskGroup {
    let taskGroup = this._identityTaskGroups.get(did);
    if (taskGroup === undefined) {
      taskGroup = new SyncTaskGroup();
      this._identityTaskGroups.set(did, taskGroup);
    }
    return taskGroup;
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
  public pauseTaskAdmission(): void {
    this._backgroundTasks.pause();
    for (const taskGroup of this._identityTaskGroups.values()) {
      taskGroup.pause();
    }
  }

  /** Reopens global background-task admission for a new runtime generation. */
  public resumeTaskAdmission(): void {
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
}
