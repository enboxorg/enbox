import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { NonEmptyStringArray, PushFailure, ReplicationLinkState, SyncScope } from './types/sync.js';

import { SyncCheckpoint } from './sync-checkpoint.js';

/** A closable transport subscription owned by one replication link. */
export type SyncLinkSubscription = {
  close: () => Promise<void>;
};

/** One queued live-push entry and its most recent failure, if any. */
export type SyncPushRuntimeEntry = {
  cid: string;
  lastFailure?: PushFailure;
};

/** Configuration captured when a live-push queue is first created. */
export type SyncPushRuntimeParams = {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  scope?: SyncScope;
  permissionGrantIds?: NonEmptyStringArray;
};

/** Mutable batching and retry state for a link's opportunistic push path. */
export type SyncPushRuntimeState = SyncPushRuntimeParams & {
  entries: SyncPushRuntimeEntry[];
  retryCount: number;
  timer?: ReturnType<typeof setTimeout>;
};

type InFlightPullCommit = {
  committed: boolean;
  token: ProgressToken;
};

/**
 * One in-flight pull delivery's ordering claim. The epoch pins the claim to
 * the pull generation that issued it: clearing or resetting the pull runtime
 * starts a new generation, and commits carrying a superseded ticket are
 * ignored instead of colliding with a fresh delivery's ordinal.
 */
export type SyncPullDeliveryTicket = {
  epoch: number;
  ordinal: number;
};

/**
 * Serialization lanes multiplexed onto one link mailbox. Every enqueued
 * operation runs FIFO regardless of lane; lanes only let callers observe
 * pending work of one kind (`mailboxBusy`) and coalesce shared operations
 * (`enqueueShared`) without extra in-flight bookkeeping.
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
  private readonly _sharedRunRequests: Set<SyncLinkMailboxKind> = new Set();
  private _mailboxTail: Promise<void> = Promise.resolve();
  private _liveSubscription?: SyncLinkSubscription;
  private _localSubscription?: SyncLinkSubscription;
  private _nextPullCommitOrdinal = 0;
  private _nextPullDeliveryOrdinal = 0;
  private readonly _pullInflight: Map<number, InFlightPullCommit> = new Map();
  private _pullEpoch = 0;
  private _pushRuntime?: SyncPushRuntimeState;
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
  public mailboxBusy(kind: SyncLinkMailboxKind): boolean {
    return (this._mailboxKindDepths.get(kind) ?? 0) > 0;
  }

  /**
   * Record that a fresh run of the shared `kind` lane is wanted. A request
   * that arrives while a run is already executing is not a duplicate caller
   * — it postdates that run's snapshot of the world — so the lane's loop
   * consumes one mark per pass and runs exactly one trailing pass for a
   * burst of requests.
   */
  public requestSharedRun(kind: SyncLinkMailboxKind): void {
    if (this._active) {
      this._sharedRunRequests.add(kind);
    }
  }

  /** Whether a run request for `kind` is pending. */
  public sharedRunRequested(kind: SyncLinkMailboxKind): boolean {
    return this._sharedRunRequests.has(kind);
  }

  /**
   * Run shared `kind` turns until no run request is pending. Each turn is
   * one mailbox operation that consumes one request mark, so a request
   * arriving while a turn executes yields exactly one trailing turn at the
   * mailbox tail — behind any work already queued — and a burst of further
   * requests coalesces into it.
   */
  public async drainSharedRuns(kind: SyncLinkMailboxKind, run: () => Promise<void>): Promise<void> {
    while (this._sharedRunRequests.has(kind)) {
      await this.enqueueShared(kind, async (): Promise<void> => {
        if (!this._sharedRunRequests.delete(kind)) {
          return;
        }
        await run();
      });
    }
  }

  /** The current pull generation; superseded delivery tickets are ignored. */
  public get pullEpoch(): number {
    return this._pullEpoch;
  }

  /** Whether this controller is still active and owns the given pull generation. */
  public isPullEpochCurrent(epoch: number): boolean {
    return this._active && this._pullEpoch === epoch;
  }

  /** Number of pull deliveries still waiting to become contiguously committed. */
  public get pullInflightCount(): number {
    return this._pullInflight.size;
  }

  public get pushRuntime(): SyncPushRuntimeState | undefined {
    return this._pushRuntime;
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

  /** Claim an ordinal in the current pull generation before admission begins. */
  public startPullDelivery(token: ProgressToken): SyncPullDeliveryTicket {
    const ordinal = this._nextPullDeliveryOrdinal++;
    this._pullInflight.set(ordinal, { token, committed: false });
    return { epoch: this._pullEpoch, ordinal };
  }

  /**
   * Mark a pull delivery committed and advance only the contiguous prefix.
   * Returns the number of newly drained deliveries. A ticket issued before
   * the pull runtime was cleared or reset belongs to a superseded generation
   * and commits nothing — its ordinal may have been reissued to a fresh
   * delivery, and its token predates the re-established pull boundary.
   */
  public commitPullDelivery(ticket: SyncPullDeliveryTicket): number {
    if (ticket.epoch !== this._pullEpoch) {
      return 0;
    }

    const entry = this._pullInflight.get(ticket.ordinal);
    if (entry !== undefined) {
      entry.committed = true;
    }

    return this.drainCommittedPull();
  }

  /** Advance the link checkpoint through every contiguously committed delivery. */
  public drainCommittedPull(): number {
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
  public clearPullInflight(): void {
    this._pullEpoch++;
    this._pullInflight.clear();
    this._nextPullCommitOrdinal = this._nextPullDeliveryOrdinal;
  }

  /** Reset pull delivery ordering when a repair establishes a fresh boundary. */
  public resetPullRuntime(): void {
    this._pullEpoch++;
    this._pullInflight.clear();
    this._nextPullCommitOrdinal = 0;
    this._nextPullDeliveryOrdinal = 0;
  }

  /** Return the existing push queue or initialize it for this link lifetime. */
  public getOrCreatePushRuntime(params: SyncPushRuntimeParams): SyncPushRuntimeState {
    this._pushRuntime ??= {
      ...params,
      entries    : [],
      retryCount : 0,
    };
    return this._pushRuntime;
  }

  /** Cancel and discard the current push queue when it is still the expected queue. */
  public clearPushRuntime(expected?: SyncPushRuntimeState): void {
    if (expected !== undefined && this._pushRuntime !== expected) {
      return;
    }

    if (this._pushRuntime !== undefined) {
      this.cancelPushTimer(this._pushRuntime);
    }
    this._pushRuntime = undefined;
  }

  /** Attach a timer only while its push queue is current and active. */
  public setPushTimer(pushRuntime: SyncPushRuntimeState, timer: ReturnType<typeof setTimeout>): boolean {
    if (!this._active || this._pushRuntime !== pushRuntime) {
      clearTimeout(timer);
      return false;
    }

    this.cancelPushTimer(pushRuntime);
    pushRuntime.timer = timer;
    return true;
  }

  /** Consume the current push timer without disturbing a newer replacement. */
  public consumePushTimer(pushRuntime: SyncPushRuntimeState, timer: ReturnType<typeof setTimeout>): boolean {
    if (this._pushRuntime !== pushRuntime || pushRuntime.timer !== timer) {
      return false;
    }

    pushRuntime.timer = undefined;
    return true;
  }

  /** Cancel a timer only while its push queue is current. */
  public cancelPushTimer(pushRuntime: SyncPushRuntimeState): void {
    if (this._pushRuntime !== pushRuntime || pushRuntime.timer === undefined) {
      return;
    }

    clearTimeout(pushRuntime.timer);
    pushRuntime.timer = undefined;
  }

  /**
   * Attach a remote pull subscription only while this link lifetime is
   * active — and, when the caller pins the pull generation it opened the
   * subscription for, only while that generation is still current. A
   * subscription opened across a generation reset would be installed
   * permanently fenced: every callback discarded as stale while the slot
   * blocks the replacement.
   */
  public setLiveSubscription(subscription: SyncLinkSubscription, expectedPullEpoch?: number): boolean {
    if (!this._active || this._liveSubscription !== undefined) {
      return false;
    }
    if (expectedPullEpoch !== undefined && expectedPullEpoch !== this._pullEpoch) {
      return false;
    }
    this._liveSubscription = subscription;
    return true;
  }

  /**
   * Attach a local push subscription only while this link lifetime is
   * active — and, when the caller pins the pull generation it opened the
   * subscription for, only while that generation is still current.
   */
  public setLocalSubscription(subscription: SyncLinkSubscription, expectedPullEpoch?: number): boolean {
    if (!this._active || this._localSubscription !== undefined) {
      return false;
    }
    if (expectedPullEpoch !== undefined && expectedPullEpoch !== this._pullEpoch) {
      return false;
    }
    this._localSubscription = subscription;
    return true;
  }

  /** Close and forget the remote pull subscription, ignoring teardown errors. */
  public async closeLiveSubscription(): Promise<void> {
    const subscription = this._liveSubscription;
    this._liveSubscription = undefined;
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
    if (!this._sharedRunRequests.has('repair')) {
      this._repairResumeToken = undefined;
    }
    this.cancelRepairRetry();
  }

  public setRepairRetryTimer(timer: ReturnType<typeof setTimeout>): void {
    this.cancelRepairRetry();
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

  public cancelRepairRetry(): void {
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
    this.clearPushRuntime();
    this.cancelRepairRetry();
    this.cancelReconcileTimer();
    this.resetPullRuntime();
    this._mailboxShared.clear();
    this._sharedRunRequests.clear();
    this._repairAttempts = 0;
    this._repairResumeToken = undefined;
  }

  /** Deactivate the link and close its transport subscriptions. */
  public async shutdown(): Promise<void> {
    this.deactivate();
    await this.closeSubscriptions();
  }
}
