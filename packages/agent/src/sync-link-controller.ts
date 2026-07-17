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
  /** True while a push HTTP request is in flight for this link. */
  flushing?: boolean;
};

type InFlightPullCommit = {
  committed: boolean;
  token: ProgressToken;
};

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
  private _liveSubscription?: SyncLinkSubscription;
  private _localSubscription?: SyncLinkSubscription;
  private _nextPullCommitOrdinal = 0;
  private _nextPullDeliveryOrdinal = 0;
  private readonly _pullInflight: Map<number, InFlightPullCommit> = new Map();
  private _pushRuntime?: SyncPushRuntimeState;
  private _reconcileInFlight?: Promise<void>;
  private _reconcileTimer?: ReturnType<typeof setTimeout>;
  private _reconcileTimerDueAt?: number;
  private _repairAttempts = 0;
  private _repairInFlight?: Promise<void>;
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

  /** Number of pull deliveries still waiting to become contiguously committed. */
  public get pullInflightCount(): number {
    return this._pullInflight.size;
  }

  public get pushRuntime(): SyncPushRuntimeState | undefined {
    return this._pushRuntime;
  }

  public get reconcileInFlight(): Promise<void> | undefined {
    return this._reconcileInFlight;
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

  public get repairInFlight(): Promise<void> | undefined {
    return this._repairInFlight;
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

  /** Assign an ordinal before asynchronous pull admission begins. */
  public startPullDelivery(token: ProgressToken): number {
    const ordinal = this._nextPullDeliveryOrdinal++;
    this._pullInflight.set(ordinal, { token, committed: false });
    return ordinal;
  }

  /**
   * Mark a pull delivery committed and advance only the contiguous prefix.
   * Returns the number of newly drained deliveries.
   */
  public commitPullDelivery(ordinal: number, token: ProgressToken): number {
    const entry = this._pullInflight.get(ordinal);
    if (entry !== undefined) {
      entry.committed = true;
    }

    SyncCheckpoint.setReceivedToken(this.link.pull, token);
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
      SyncCheckpoint.setReceivedToken(this.link.pull, entry.token);
      this._pullInflight.delete(this._nextPullCommitOrdinal);
      this._nextPullCommitOrdinal++;
      drained++;
    }

    return drained;
  }

  /** Discard incomplete pull deliveries while preserving future ordinal order. */
  public clearPullInflight(): void {
    this._pullInflight.clear();
    this._nextPullCommitOrdinal = this._nextPullDeliveryOrdinal;
  }

  /** Reset pull delivery ordering when a repair establishes a fresh boundary. */
  public resetPullRuntime(): void {
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

  /** Attach a remote pull subscription only while this link lifetime is active. */
  public setLiveSubscription(subscription: SyncLinkSubscription): boolean {
    if (!this._active || this._liveSubscription !== undefined) {
      return false;
    }
    this._liveSubscription = subscription;
    return true;
  }

  /** Attach a local push subscription only while this link lifetime is active. */
  public setLocalSubscription(subscription: SyncLinkSubscription): boolean {
    if (!this._active || this._localSubscription !== undefined) {
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
    this._repairResumeToken = undefined;
    this.cancelRepairRetry();
  }

  public setRepairInFlight(operation: Promise<void>): void {
    this._repairInFlight = operation;
  }

  public clearRepairInFlight(operation: Promise<void>): void {
    if (this._repairInFlight === operation) {
      this._repairInFlight = undefined;
    }
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

  public setReconcileInFlight(operation: Promise<void>): void {
    this._reconcileInFlight = operation;
  }

  public clearReconcileInFlight(operation: Promise<void>): void {
    if (this._reconcileInFlight === operation) {
      this._reconcileInFlight = undefined;
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
    this._reconcileInFlight = undefined;
    this._repairAttempts = 0;
    this._repairInFlight = undefined;
    this._repairResumeToken = undefined;
  }

  /** Deactivate the link and close its transport subscriptions. */
  public async shutdown(): Promise<void> {
    this.deactivate();
    await this.closeSubscriptions();
  }
}
