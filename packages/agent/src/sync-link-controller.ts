import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState, SyncDirection } from './types/sync.js';

/** A closable transport subscription owned by one replication link. */
export type SyncLinkSubscription = {
  close: () => Promise<void>;
};

/** Feed state captured atomically with one subscription establishment. */
export type SyncFeedSnapshot = {
  fingerprint?: string;
  head?: ProgressToken;
};

type SyncDirectionOperation = {
  operation: () => Promise<unknown>;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
};

type SyncDirectionQueue = {
  active?: Promise<void>;
  draining: boolean;
  generation: number;
  invalidated: boolean;
  operations: SyncDirectionOperation[];
  pendingCount: number;
  readiness: Promise<void>;
};

type SyncReplicationReadiness = {
  generation: number;
  isReady: boolean;
  promise: Promise<void>;
  release: () => void;
};

/**
 * Serialization lanes multiplexed onto one link mailbox. Every enqueued
 * operation runs FIFO regardless of lane. A lane does three things:
 *
 * 1. lets callers observe pending work of one kind (`isMailboxBusy`);
 * 2. coalesces shared operations (`enqueueShared`) without extra in-flight
 *    bookkeeping;
 * 3. carries a pending-pass mark (`requestPass` / `isPassRequested`) that
 *    lives OUTSIDE the queue — a mark is not queued work, it is a note that
 *    one more pass is owed once the current one finishes.
 */
export type SyncLinkMailboxKind = 'push' | 'repair' | 'reconcile';

/**
 * Owns all ephemeral state associated with one active replication link.
 *
 * The controller is persistence- and transport-backend neutral. The enclosing
 * sync engine performs I/O while the controller provides one stable lifetime
 * boundary for subscriptions, directional replication queues, repair, and
 * reconciliation. Captured callbacks use `isActive` to reject work belonging
 * to a replaced or removed link without consulting backend-specific state.
 */
export class SyncLinkController {
  private _active = true;
  private _directionQueues: Record<SyncDirection, SyncDirectionQueue>;
  private readonly _mailboxKindDepths: Map<SyncLinkMailboxKind, number> = new Map();
  private readonly _mailboxShared: Map<SyncLinkMailboxKind, Promise<unknown>> = new Map();
  private readonly _requestedPasses: Set<SyncLinkMailboxKind> = new Set();
  private _mailboxTail: Promise<void> = Promise.resolve();
  private _liveSubscription?: SyncLinkSubscription;
  private _localSubscription?: SyncLinkSubscription;
  private _pullSnapshot?: SyncFeedSnapshot;
  private _replicationGeneration = 0;
  private _pushSnapshot?: SyncFeedSnapshot;
  private _reconcileTimer?: ReturnType<typeof setTimeout>;
  private _reconcileTimerDueAt?: number;
  private _replicationReadiness: SyncReplicationReadiness;
  private _repairAttempts = 0;
  private _repairResumeToken?: ProgressToken;
  private _repairRetryTimer?: ReturnType<typeof setTimeout>;
  private _supersededDirectionWork: Promise<void> = Promise.resolve();

  public constructor(
    public readonly linkKey: string,
    public readonly link: ReplicationLinkState,
  ) {
    this._replicationReadiness = SyncLinkController.createReplicationReadiness(this._replicationGeneration);
    this._directionQueues = SyncLinkController.createDirectionQueues(this._replicationReadiness);
  }

  /** Whether this controller still owns callbacks for its active-link lifetime. */
  public get isActive(): boolean {
    return this._active;
  }

  /** Whether the current generation has established its durable replay baselines. */
  public get isReplicationReady(): boolean {
    return this._active &&
      this._replicationReadiness.generation === this._replicationGeneration &&
      this._replicationReadiness.isReady;
  }

  /** Snapshot captured with the current generation's remote pull subscription. */
  public get pullSnapshot(): SyncFeedSnapshot | undefined {
    return this._pullSnapshot;
  }

  /** Snapshot captured with the current generation's local push subscription. */
  public get pushSnapshot(): SyncFeedSnapshot | undefined {
    return this._pushSnapshot;
  }

  /**
   * Enqueue replication work in one direction's FIFO. Pull and push drain
   * independently, while both wait for the current generation's durable
   * replay baselines before starting. Work invalidated by a generation reset
   * or deactivation resolves `undefined`; a current operation's rejection is
   * surfaced without poisoning the queue.
   */
  public enqueueDirection<T>(
    direction: SyncDirection,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!this._active) {
      return Promise.resolve(undefined);
    }

    const queue = this._directionQueues[direction];
    queue.pendingCount++;
    const result = new Promise<T | undefined>((resolve, reject) => {
      queue.operations.push({
        operation,
        reject,
        resolve: (value): void => { resolve(value as T | undefined); },
      });
    });
    this.startDirectionDrain(direction, queue);
    return result;
  }

  /** Number of running, queued, or readiness-blocked operations in the current generation. */
  public getPendingDirectionCount(direction: SyncDirection): number {
    return this._directionQueues[direction].pendingCount;
  }

  /** Wait for operations invalidated by a generation reset to finish unwinding. */
  public waitForSupersededDirectionWork(): Promise<void> {
    return this._supersededDirectionWork;
  }

  /** Release both directional queues after their durable replay baselines are established. */
  public markReplicationReady(): void {
    const readiness = this._replicationReadiness;
    if (!this._active || readiness.generation !== this._replicationGeneration || readiness.isReady) {
      return;
    }

    readiness.isReady = true;
    readiness.release();
  }

  /**
   * Run link-scoped work serialized behind every previously enqueued
   * operation for this controller lifetime — the link's mailbox. Work
   * enqueued after deactivation resolves `undefined` without running (the
   * convention paused task groups use), while an operation already running
   * continues to completion. A rejected operation surfaces to its caller
   * without poisoning the queue.
   *
   * Do not await a nested `enqueue` from inside an enqueued operation — the
   * inner operation is ordered after the outer one and the await would
   * deadlock. Internal helpers that already run inside the mailbox must call
   * their exclusive bodies directly.
   */
  public enqueue<T>(operation: () => Promise<T>, kind?: SyncLinkMailboxKind): Promise<T | undefined> {
    if (!this._active) {
      return Promise.resolve(undefined);
    }
    if (kind !== undefined) {
      this._mailboxKindDepths.set(kind, (this._mailboxKindDepths.get(kind) ?? 0) + 1);
    }
    const run = this._mailboxTail.then(async (): Promise<T | undefined> => {
      if (!this._active) {
        return undefined;
      }
      return operation();
    });
    const settle = (): void => {
      if (kind === undefined) {
        return;
      }
      const depth = (this._mailboxKindDepths.get(kind) ?? 1) - 1;
      if (depth <= 0) {
        this._mailboxKindDepths.delete(kind);
      } else {
        this._mailboxKindDepths.set(kind, depth);
      }
    };
    this._mailboxTail = run.then(settle, settle);
    return run;
  }

  /**
   * Join the queued-or-running shared operation of `kind`, or enqueue
   * `operation` as the new one. Callers coalesce onto a single execution
   * per kind at a time — the mailbox form of an in-flight dedup handle —
   * and the handle releases itself when that execution settles.
   */
  public enqueueShared<T>(kind: SyncLinkMailboxKind, operation: () => Promise<T>): Promise<T | undefined> {
    const existing = this._mailboxShared.get(kind);
    if (existing !== undefined) {
      return existing as Promise<T | undefined>;
    }

    const run = this.enqueue(operation, kind);
    this._mailboxShared.set(kind, run);
    const release = (): void => {
      if (this._mailboxShared.get(kind) === run) {
        this._mailboxShared.delete(kind);
      }
    };
    run.then(release, release);
    return run;
  }

  /** Whether an operation of `kind` is queued or in flight in the mailbox. */
  public isMailboxBusy(kind: SyncLinkMailboxKind): boolean {
    return (this._mailboxKindDepths.get(kind) ?? 0) > 0;
  }

  /**
   * Record that a fresh run of the shared `kind` lane is wanted. A request
   * that arrives while a run is already executing is not a duplicate caller
   * — it postdates that run's snapshot of the world — so the lane's loop
   * consumes one mark per pass and runs exactly one trailing pass for a
   * burst of requests.
   */
  public requestPass(kind: SyncLinkMailboxKind): void {
    if (this._active) {
      this._requestedPasses.add(kind);
    }
  }

  /** Whether a run request for `kind` is pending. */
  public isPassRequested(kind: SyncLinkMailboxKind): boolean {
    return this._requestedPasses.has(kind);
  }

  /**
   * Run shared `kind` turns until no run request is pending. Each turn is
   * one mailbox operation that consumes one request mark, so a request
   * arriving while a turn executes yields exactly one trailing turn at the
   * mailbox tail — behind any work already queued — and a burst of further
   * requests coalesces into it.
   */
  public async runRequestedPasses(kind: SyncLinkMailboxKind, run: () => Promise<void>): Promise<void> {
    while (this._requestedPasses.has(kind)) {
      await this.enqueueShared(kind, async (): Promise<void> => {
        if (!this._requestedPasses.delete(kind)) {
          return;
        }
        await run();
      });
    }
  }

  /** The current subscription-pair generation. */
  public get replicationGeneration(): number {
    return this._replicationGeneration;
  }

  /** Whether this controller is still active and owns the given replication generation. */
  public isReplicationGenerationCurrent(generation: number): boolean {
    return this._active && this._replicationGeneration === generation;
  }

  public get reconcileTimer(): ReturnType<typeof setTimeout> | undefined {
    return this._reconcileTimer;
  }

  public get reconcileTimerDueAt(): number | undefined {
    return this._reconcileTimerDueAt;
  }

  public get repairAttempts(): number {
    return this._repairAttempts;
  }

  public get repairResumeToken(): ProgressToken | undefined {
    return this._repairResumeToken;
  }

  public get repairRetryTimer(): ReturnType<typeof setTimeout> | undefined {
    return this._repairRetryTimer;
  }

  public get hasLiveSubscription(): boolean {
    return this._liveSubscription !== undefined;
  }

  public get hasLocalSubscription(): boolean {
    return this._localSubscription !== undefined;
  }

  /** Begin a fresh replication generation and fence both directional queues. */
  public resetReplicationGeneration(): void {
    this._replicationGeneration++;
    this.replaceDirectionQueues();
  }

  /**
   * Attach a remote pull subscription only while this link lifetime is
   * active — and, when the caller pins the replication generation it opened the
   * subscription for, only while that generation is still current. A
   * subscription opened across a generation reset would be installed
   * permanently fenced: every callback discarded as stale while the slot
   * blocks the replacement.
   */
  public setLiveSubscription(
    subscription: SyncLinkSubscription,
    expectedReplicationGeneration?: number,
    snapshot?: SyncFeedSnapshot,
  ): boolean {
    if (!this._active || this._liveSubscription !== undefined) {
      return false;
    }
    if (expectedReplicationGeneration !== undefined && expectedReplicationGeneration !== this._replicationGeneration) {
      return false;
    }
    this._liveSubscription = subscription;
    this._pullSnapshot = SyncLinkController.cloneFeedSnapshot(snapshot);
    return true;
  }

  /**
   * Attach a local push subscription only while this link lifetime is
   * active — and, when the caller pins the replication generation it opened the
   * subscription for, only while that generation is still current.
   */
  public setLocalSubscription(
    subscription: SyncLinkSubscription,
    expectedReplicationGeneration?: number,
    snapshot?: SyncFeedSnapshot,
  ): boolean {
    if (!this._active || this._localSubscription !== undefined) {
      return false;
    }
    if (expectedReplicationGeneration !== undefined && expectedReplicationGeneration !== this._replicationGeneration) {
      return false;
    }
    this._localSubscription = subscription;
    this._pushSnapshot = SyncLinkController.cloneFeedSnapshot(snapshot);
    return true;
  }

  /** Close and forget the remote pull subscription, ignoring teardown errors. */
  public async closeLiveSubscription(): Promise<void> {
    const subscription = this._liveSubscription;
    this._liveSubscription = undefined;
    this._pullSnapshot = undefined;
    if (subscription === undefined) {
      return;
    }

    try {
      await subscription.close();
    } catch {
      // Best-effort cleanup.
    }
  }

  /** Close and forget the local push subscription, ignoring teardown errors. */
  public async closeLocalSubscription(): Promise<void> {
    const subscription = this._localSubscription;
    this._localSubscription = undefined;
    this._pushSnapshot = undefined;
    if (subscription === undefined) {
      return;
    }

    try {
      await subscription.close();
    } catch {
      // Best-effort cleanup.
    }
  }

  /** Close both subscriptions owned by this link. */
  public async closeSubscriptions(): Promise<void> {
    await Promise.all([
      this.closeLiveSubscription(),
      this.closeLocalSubscription(),
    ]);
  }

  public incrementRepairAttempts(): number {
    this._repairAttempts += 1;
    return this._repairAttempts;
  }

  public setRepairResumeToken(token: ProgressToken): void {
    this._repairResumeToken = token;
  }

  public clearRepairProgress(): void {
    this._repairAttempts = 0;
    // A pending repair request owns the freshest resume token — completing
    // the pass it supersedes must not discard it.
    if (!this._requestedPasses.has('repair')) {
      this._repairResumeToken = undefined;
    }
    this.cancelRepairRetryTimer();
  }

  public setRepairRetryTimer(timer: ReturnType<typeof setTimeout>): void {
    this.cancelRepairRetryTimer();
    this._repairRetryTimer = timer;
  }

  /** Consume the current repair timer without disturbing a newer replacement. */
  public consumeRepairRetryTimer(timer: ReturnType<typeof setTimeout>): boolean {
    if (this._repairRetryTimer !== timer) {
      return false;
    }

    this._repairRetryTimer = undefined;
    return true;
  }

  public cancelRepairRetryTimer(): void {
    if (this._repairRetryTimer !== undefined) {
      clearTimeout(this._repairRetryTimer);
      this._repairRetryTimer = undefined;
    }
  }

  public setReconcileTimer(timer: ReturnType<typeof setTimeout>, dueAt: number): void {
    this.cancelReconcileTimer();
    this._reconcileTimer = timer;
    this._reconcileTimerDueAt = dueAt;
  }

  /** Consume the current reconcile timer without disturbing a newer replacement. */
  public consumeReconcileTimer(timer: ReturnType<typeof setTimeout>): boolean {
    if (this._reconcileTimer !== timer) {
      return false;
    }

    this._reconcileTimer = undefined;
    this._reconcileTimerDueAt = undefined;
    return true;
  }

  public cancelReconcileTimer(): void {
    if (this._reconcileTimer !== undefined) {
      clearTimeout(this._reconcileTimer);
      this._reconcileTimer = undefined;
      this._reconcileTimerDueAt = undefined;
    }
  }

  private static cloneFeedSnapshot(snapshot: SyncFeedSnapshot | undefined): SyncFeedSnapshot | undefined {
    if (snapshot === undefined) {
      return undefined;
    }

    return {
      ...(snapshot.fingerprint === undefined ? {} : { fingerprint: snapshot.fingerprint }),
      ...(snapshot.head === undefined ? {} : { head: { ...snapshot.head } }),
    };
  }

  private static createDirectionQueues(
    readiness: SyncReplicationReadiness,
  ): Record<SyncDirection, SyncDirectionQueue> {
    const createQueue = (): SyncDirectionQueue => ({
      draining     : false,
      generation   : readiness.generation,
      invalidated  : false,
      operations   : [],
      pendingCount : 0,
      readiness    : readiness.promise,
    });
    return { pull: createQueue(), push: createQueue() };
  }

  private static createReplicationReadiness(generation: number): SyncReplicationReadiness {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { generation, isReady: false, promise, release };
  }

  private async drainDirectionQueue(direction: SyncDirection, queue: SyncDirectionQueue): Promise<void> {
    await queue.readiness;

    while (!queue.invalidated && this._directionQueues[direction] === queue) {
      const queued = queue.operations.shift();
      if (queued === undefined) {
        break;
      }

      let releaseActive!: () => void;
      const active = new Promise<void>((resolve) => { releaseActive = resolve; });
      queue.active = active;
      try {
        const result = await queued.operation();
        if (this.isDirectionQueueCurrent(direction, queue)) {
          queued.resolve(result);
        } else {
          queued.resolve(undefined);
        }
      } catch (error: unknown) {
        if (this.isDirectionQueueCurrent(direction, queue)) {
          queued.reject(error);
        } else {
          queued.resolve(undefined);
        }
      } finally {
        if (queue.active === active) {
          queue.active = undefined;
        }
        releaseActive();
        queue.pendingCount--;
      }
    }

    queue.draining = false;
  }

  private invalidateDirectionQueue(queue: SyncDirectionQueue): void {
    queue.invalidated = true;
    for (const queued of queue.operations.splice(0)) {
      queue.pendingCount--;
      queued.resolve(undefined);
    }
  }

  private isDirectionQueueCurrent(direction: SyncDirection, queue: SyncDirectionQueue): boolean {
    return this._active &&
      !queue.invalidated &&
      queue.generation === this._replicationGeneration &&
      this._directionQueues[direction] === queue;
  }

  private replaceDirectionQueues(): void {
    const previousReadiness = this._replicationReadiness;
    const previousPull = this._directionQueues.pull;
    const previousPush = this._directionQueues.push;
    this.invalidateDirectionQueue(previousPull);
    this.invalidateDirectionQueue(previousPush);
    previousReadiness.release();

    const previousSupersededWork = this._supersededDirectionWork;
    this._supersededDirectionWork = Promise.all([
      previousSupersededWork,
      previousPull.active ?? Promise.resolve(),
      previousPush.active ?? Promise.resolve(),
    ]).then((): void => {});

    this._pullSnapshot = undefined;
    this._pushSnapshot = undefined;
    this._replicationReadiness = SyncLinkController.createReplicationReadiness(this._replicationGeneration);
    this._directionQueues = SyncLinkController.createDirectionQueues(this._replicationReadiness);
  }

  private startDirectionDrain(direction: SyncDirection, queue: SyncDirectionQueue): void {
    if (queue.draining) {
      return;
    }

    queue.draining = true;
    void this.drainDirectionQueue(direction, queue);
  }

  /**
   * Invalidate captured callbacks and cancel work that has not started yet.
   * In-flight operations remain supervised by the lifecycle coordinator while
   * this inactive controller releases its own references to them.
   */
  public deactivate(): void {
    if (!this._active) {
      return;
    }

    this._active = false;
    this.cancelRepairRetryTimer();
    this.cancelReconcileTimer();
    this.resetReplicationGeneration();
    this._mailboxShared.clear();
    this._requestedPasses.clear();
    this._repairAttempts = 0;
    this._repairResumeToken = undefined;
  }

  /** Deactivate the link and close its transport subscriptions. */
  public async dispose(): Promise<void> {
    this.deactivate();
    await this.closeSubscriptions();
  }
}
