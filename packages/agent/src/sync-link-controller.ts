import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState } from './types/sync.js';

import { SyncLinkExecutor } from './sync-link-executor.js';

/** A closable transport subscription owned by one replication link. */
export type SyncLinkSubscription = {
  close: () => Promise<void>;
};

/** Feed state captured atomically with one subscription establishment. */
export type SyncFeedSnapshot = {
  fingerprint?: string;
  head?: ProgressToken;
};

/**
 * Owns all ephemeral state associated with one active replication link.
 *
 * The controller is persistence- and transport-backend neutral. The enclosing
 * sync engine performs I/O while the controller provides one stable lifetime
 * boundary for subscriptions, link execution, repair, and reconciliation.
 * Captured callbacks use `isActive` to reject work belonging to a replaced or
 * removed link without consulting backend-specific state.
 */
export class SyncLinkController {
  private _active = true;
  public readonly executor = new SyncLinkExecutor();
  private _liveSubscription?: SyncLinkSubscription;
  private _localSubscription?: SyncLinkSubscription;
  private _pullSnapshot?: SyncFeedSnapshot;
  private _replicationGeneration = 0;
  private _pushSnapshot?: SyncFeedSnapshot;
  private _reconcileTimer?: ReturnType<typeof setTimeout>;
  private _reconcileTimerDueAt?: number;
  private _repairAttempts = 0;
  private _repairRetryTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    public readonly linkKey: string,
    public readonly link: ReplicationLinkState,
  ) {}

  /** Whether this controller still owns callbacks for its active-link lifetime. */
  public get isActive(): boolean {
    return this._active;
  }

  /** Whether the current replication generation established its durable reconciliation baselines. */
  public get isReplicationReady(): boolean {
    return this._active && this.executor.isReady;
  }

  /** Snapshot captured with the current replication generation's remote pull subscription. */
  public get pullSnapshot(): SyncFeedSnapshot | undefined {
    return this._pullSnapshot;
  }

  /** Snapshot captured with the current replication generation's local push subscription. */
  public get pushSnapshot(): SyncFeedSnapshot | undefined {
    return this._pushSnapshot;
  }

  /** Release retained ordinary work after its durable reconciliation baselines are established. */
  public markReplicationReady(): void {
    this.executor.markReady();
  }

  /** The current subscription-pair replication generation. */
  public get replicationGeneration(): number {
    return this._replicationGeneration;
  }

  /** Whether this controller is still active and owns the given replication generation. */
  public isReplicationGenerationCurrent(replicationGeneration: number): boolean {
    return this._active && this._replicationGeneration === replicationGeneration;
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

  public get repairRetryTimer(): ReturnType<typeof setTimeout> | undefined {
    return this._repairRetryTimer;
  }

  public get hasLiveSubscription(): boolean {
    return this._liveSubscription !== undefined;
  }

  public get hasLocalSubscription(): boolean {
    return this._localSubscription !== undefined;
  }

  /** Begin a fresh replication generation and fence caller-specific executor work. */
  public resetReplicationGeneration(): void {
    this._replicationGeneration++;
    this._pullSnapshot = undefined;
    this._pushSnapshot = undefined;
    this.executor.reset();
  }

  /**
   * Attach a remote pull subscription only while this link lifetime is
   * active — and, when the caller pins the replication generation it opened the
   * subscription for, only while that replication generation is still current. A
   * subscription opened across a replication-generation reset would be installed
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
   * subscription for, only while that replication generation is still current.
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

  /** Close and forget the remote pull subscription, ignoring close errors. */
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
      // Best-effort close.
    }
  }

  /** Close and forget the local push subscription, ignoring close errors. */
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
      // Best-effort close.
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

  /** Discard an attempt superseded before the next executor repair starts. */
  public discardRepairAttempt(attempt: number): void {
    if (this._repairAttempts === attempt) {
      this._repairAttempts = Math.max(0, attempt - 1);
    }
  }

  public clearRepairProgress(): void {
    this._repairAttempts = 0;
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
    this._replicationGeneration++;
    this._pullSnapshot = undefined;
    this._pushSnapshot = undefined;
    this.executor.dispose();
    this._repairAttempts = 0;
  }

  /** Deactivate the link and close its transport subscriptions. */
  public async dispose(): Promise<void> {
    this.deactivate();
    await this.closeSubscriptions();
  }
}
