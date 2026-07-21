import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { NonEmptyStringArray, PushFailure, ReplicationLinkState, SyncScope } from './types/sync.js';

import { SyncCheckpoint } from './sync-checkpoint.js';

/** A closable transport subscription owned by one replication link. */
export type SyncLinkSubscription = {
  close: () => Promise<void>;
};

/** One queued live-push entry and its most recent failure, if any. */
export type SyncPushQueueEntry = {
  cid: string;
  lastFailure?: PushFailure;
};

/** Configuration captured when a live-push queue is first created. */
export type SyncPushQueueParams = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  scope?: SyncScope;
  permissionGrantIds?: NonEmptyStringArray;
};

/** Mutable batching and retry state for a link's opportunistic push path. */
export type SyncPushQueueState = SyncPushQueueParams & {
  entries: SyncPushQueueEntry[];
  retryCount: number;
  timer?: ReturnType<typeof setTimeout>;
};

type InFlightPullCommit = {
  committed: boolean;
  token: ProgressToken;
};

/**
 * One in-flight pull delivery's ordering claim, pinned to the pull
 * generation that issued it. `startNewPullGeneration` and
 * `resetPullGeneration` each begin a new generation, after which commits
 * carrying a superseded ticket are ignored instead of colliding with a
 * fresh delivery's ordinal.
 *
 * "Generation" means this monotonic in-memory counter and nothing else. The
 * two durable, string-valued epochs — `authorizationEpoch` on a replication
 * link, and `ProgressToken.epoch` on a remote stream — are separate concepts
 * that deliberately keep the word "epoch".
 */
export type SyncPullDeliveryTicket = {
  generation: number;
  ordinal: number;
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
export type SyncLinkMailboxKind = 'flush' | 'repair' | 'reconcile';

/**
 * Owns all ephemeral state associated with one active replication link.
 *
 * The controller is persistence- and transport-backend neutral. The enclosing
 * sync engine performs I/O while the controller provides one stable lifetime
 * boundary for subscriptions, pull ordering, push batching, repair, and
 * reconciliation. Captured callbacks use `isActive` to reject work belonging
 * to a replaced or removed link without consulting backend-specific state.
 */
export class SyncLinkController {
  private _active = true;
  private readonly _mailboxKindDepths: Map<SyncLinkMailboxKind, number> = new Map();
  private readonly _mailboxShared: Map<SyncLinkMailboxKind, Promise<unknown>> = new Map();
  private readonly _requestedPasses: Set<SyncLinkMailboxKind> = new Set();
  private _mailboxTail: Promise<void> = Promise.resolve();
  private _liveStreamAttached = false;
  private _liveSubscription?: SyncLinkSubscription;
  private _localSubscription?: SyncLinkSubscription;
  private _nextPullCommitOrdinal = 0;
  private _nextPullDeliveryOrdinal = 0;
  private readonly _pullInflight: Map<number, InFlightPullCommit> = new Map();
  private _pullGeneration = 0;
  private _pushQueue?: SyncPushQueueState;
  private _reconcileTimer?: ReturnType<typeof setTimeout>;
  private _reconcileTimerDueAt?: number;
  private _repairAttempts = 0;
  private _repairResumeToken?: ProgressToken;
  private _repairRetryTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    public readonly linkKey: string,
    public readonly link: ReplicationLinkState,
  ) {}

  /** Whether this controller still owns callbacks for its active-link lifetime. */
  public get isActive(): boolean {
    return this._active;
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

  /** The current pull generation; superseded delivery tickets are ignored. */
  public get pullGeneration(): number {
    return this._pullGeneration;
  }

  /** Whether this controller is still active and owns the given pull generation. */
  public isPullGenerationCurrent(generation: number): boolean {
    return this._active && this._pullGeneration === generation;
  }

  /** Number of pull deliveries still waiting to become contiguously committed. */
  public get pullInflightCount(): number {
    return this._pullInflight.size;
  }

  public get pushQueue(): SyncPushQueueState | undefined {
    return this._pushQueue;
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

  /**
   * Whether this link's replication stream provably covers everything a
   * connectivity-driven convergence check would otherwise fetch or send: the
   * link is live and online, both subscription halves are attached with the
   * transport confirming the remote stream, no push batch is queued or
   * flushing, and no repair or reconciliation work is pending, scheduled, or
   * in flight. Live deliveries commit durable cursors contiguously and a gap
   * surfaces as repair, so a current stream owes no pull gap — deliveries
   * may still be mid-admission, which is progress, not staleness.
   *
   * `connectivity` here is a cached value that can predate a long
   * suspension. Trusting it is safe because the transport probes socket
   * liveness on the same wake signals: a dead socket emits `disconnected`
   * (detaching the stream here), then either resubscribes from the durable
   * checkpoint or surfaces a terminal error that drives repair. The gate's
   * correctness rests on that recovery chain, not on its own ordering.
   */
  public get isStreamCurrent(): boolean {
    return this._active
      && this.link.status === 'live'
      && this.link.connectivity === 'online'
      && this._liveSubscription !== undefined
      && this._liveStreamAttached
      && this._localSubscription !== undefined
      && this._pushQueue === undefined
      && !this.isMailboxBusy('flush')
      && this._repairResumeToken === undefined
      && this._repairRetryTimer === undefined
      && this._reconcileTimer === undefined
      && !this.isMailboxBusy('repair')
      && !this.isPassRequested('repair')
      && !this.isMailboxBusy('reconcile')
      && !this.isPassRequested('reconcile');
  }

  /** Whether the transport currently confirms the live stream's socket attachment. */
  public get isLiveStreamAttached(): boolean {
    return this._liveStreamAttached;
  }

  /** Mark the live stream detached while the transport's socket reconnects. */
  public markLiveStreamDetached(): void {
    this._liveStreamAttached = false;
  }

  /**
   * Restore stream attachment after the transport verifies a resubscription.
   * Meaningful only while a live subscription handle is installed — the
   * transport keeps the logical subscription identity across reconnects, so
   * the handle survives the detached window.
   */
  public markLiveStreamAttached(): void {
    if (this._active && this._liveSubscription !== undefined) {
      this._liveStreamAttached = true;
    }
  }

  /** Claim an ordinal in the current pull generation before admission begins. */
  public startPullDelivery(token: ProgressToken): SyncPullDeliveryTicket {
    const ordinal = this._nextPullDeliveryOrdinal++;
    this._pullInflight.set(ordinal, { token, committed: false });
    return { generation: this._pullGeneration, ordinal };
  }

  /**
   * Mark a pull delivery committed and advance only the contiguous prefix.
   * Returns the number of newly drained deliveries. A ticket issued before
   * the pull runtime was cleared or reset belongs to a superseded generation
   * and commits nothing — its ordinal may have been reissued to a fresh
   * delivery, and its token predates the re-established pull boundary.
   */
  public commitPullDelivery(ticket: SyncPullDeliveryTicket): number {
    if (ticket.generation !== this._pullGeneration) {
      return 0;
    }

    const entry = this._pullInflight.get(ticket.ordinal);
    if (entry !== undefined) {
      entry.committed = true;
    }

    return this.advanceContiguousPullCommits();
  }

  /** Advance the link checkpoint through every contiguously committed delivery. */
  public advanceContiguousPullCommits(): number {
    let drained = 0;
    while (true) {
      const entry = this._pullInflight.get(this._nextPullCommitOrdinal);
      if (entry?.committed !== true) {
        break;
      }

      SyncCheckpoint.commitContiguousToken(this.link.pull, entry.token);
      this._pullInflight.delete(this._nextPullCommitOrdinal);
      this._nextPullCommitOrdinal++;
      drained++;
    }

    return drained;
  }

  /** Discard incomplete pull deliveries while preserving future ordinal order. */
  /**
   * Begin a new pull generation: bump the counter so outstanding delivery
   * tickets and in-flight subscription attaches are fenced off, discard
   * incomplete deliveries, and rebase the commit cursor onto the next
   * unissued ordinal.
   *
   * The bump is the point — both callers rely on it to publish a pause or
   * repair transition synchronously, before any await.
   */
  public startNewPullGeneration(): void {
    this._pullGeneration++;
    this._pullInflight.clear();
    this._nextPullCommitOrdinal = this._nextPullDeliveryOrdinal;
  }

  /** Reset pull delivery ordering when a repair establishes a fresh boundary. */
  public resetPullGeneration(): void {
    this._pullGeneration++;
    this._pullInflight.clear();
    this._nextPullCommitOrdinal = 0;
    this._nextPullDeliveryOrdinal = 0;
  }

  /** Return the existing push queue or initialize it for this link lifetime. */
  public getOrCreatePushQueue(params: SyncPushQueueParams): SyncPushQueueState {
    this._pushQueue ??= {
      ...params,
      entries    : [],
      retryCount : 0,
    };
    return this._pushQueue;
  }

  /** Cancel and discard the current push queue when it is still the expected queue. */
  public clearPushQueue(expected?: SyncPushQueueState): void {
    if (expected !== undefined && this._pushQueue !== expected) {
      return;
    }

    if (this._pushQueue !== undefined) {
      this.cancelPushTimer(this._pushQueue);
    }
    this._pushQueue = undefined;
  }

  /** Attach a timer only while its push queue is current and active. */
  public setPushTimer(pushQueue: SyncPushQueueState, timer: ReturnType<typeof setTimeout>): boolean {
    if (!this._active || this._pushQueue !== pushQueue) {
      clearTimeout(timer);
      return false;
    }

    this.cancelPushTimer(pushQueue);
    pushQueue.timer = timer;
    return true;
  }

  /** Consume the current push timer without disturbing a newer replacement. */
  public consumePushTimer(pushQueue: SyncPushQueueState, timer: ReturnType<typeof setTimeout>): boolean {
    if (this._pushQueue !== pushQueue || pushQueue.timer !== timer) {
      return false;
    }

    pushQueue.timer = undefined;
    return true;
  }

  /** Cancel a timer only while its push queue is current. */
  public cancelPushTimer(pushQueue: SyncPushQueueState): void {
    if (this._pushQueue !== pushQueue || pushQueue.timer === undefined) {
      return;
    }

    clearTimeout(pushQueue.timer);
    pushQueue.timer = undefined;
  }

  /**
   * Attach a remote pull subscription only while this link lifetime is
   * active — and, when the caller pins the pull generation it opened the
   * subscription for, only while that generation is still current. A
   * subscription opened across a generation reset would be installed
   * permanently fenced: every callback discarded as stale while the slot
   * blocks the replacement.
   */
  public setLiveSubscription(subscription: SyncLinkSubscription, expectedPullGeneration?: number): boolean {
    if (!this._active || this._liveSubscription !== undefined) {
      return false;
    }
    if (expectedPullGeneration !== undefined && expectedPullGeneration !== this._pullGeneration) {
      return false;
    }
    this._liveSubscription = subscription;
    this._liveStreamAttached = true;
    return true;
  }

  /**
   * Attach a local push subscription only while this link lifetime is
   * active — and, when the caller pins the pull generation it opened the
   * subscription for, only while that generation is still current.
   */
  public setLocalSubscription(subscription: SyncLinkSubscription, expectedPullGeneration?: number): boolean {
    if (!this._active || this._localSubscription !== undefined) {
      return false;
    }
    if (expectedPullGeneration !== undefined && expectedPullGeneration !== this._pullGeneration) {
      return false;
    }
    this._localSubscription = subscription;
    return true;
  }

  /** Close and forget the remote pull subscription, ignoring teardown errors. */
  public async closeLiveSubscription(): Promise<void> {
    const subscription = this._liveSubscription;
    this._liveSubscription = undefined;
    this._liveStreamAttached = false;
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
    this.clearPushQueue();
    this.cancelRepairRetryTimer();
    this.cancelReconcileTimer();
    this.resetPullGeneration();
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
