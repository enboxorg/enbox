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
 * Owns the controller-local ephemeral state for one active replication link.
 *
 * The controller is persistence- and transport-backend neutral. The enclosing
 * sync engine performs I/O while the controller provides one stable lifetime
 * boundary for subscriptions, link execution, repair, and reconciliation.
 * Runtime-owned link scheduling is held separately by `SyncRuntime` under the
 * controller's `linkKey`.
 * Captured callbacks use `isActive` to reject work belonging to a replaced or
 * removed link without consulting backend-specific state.
 */
export class SyncLinkController {
  private _active = true;
  public readonly executor = new SyncLinkExecutor();
  private _liveSubscription?: SyncLinkSubscription;
  private _localSubscription?: SyncLinkSubscription;
  private _isPullCurrent = false;
  private _isRetiring = false;
  private _pullSnapshot?: SyncFeedSnapshot;
  private _replicationGeneration = 0;
  private _pushSnapshot?: SyncFeedSnapshot;
  private _repairAttempts = 0;

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

  /** Whether every durable pull wake accepted so far is covered by a completed pass. */
  public get isPullCurrent(): boolean {
    return this._active && this._isPullCurrent;
  }

  /** Record that the remote feed may have advanced. */
  public markPullPending(): boolean {
    if (!this._active || !this._isPullCurrent) {
      return false;
    }

    this._isPullCurrent = false;
    return true;
  }

  /**
   * Mark the pull side current only for the expected replication generation
   * and only when no trailing durable pull wake remains queued.
   */
  public markPullCurrent(expectedReplicationGeneration: number): boolean {
    if (
      this._isRetiring ||
      !this.isReplicationGenerationCurrent(expectedReplicationGeneration) ||
      this.executor.hasPending('pull') ||
      this._isPullCurrent
    ) {
      return false;
    }

    this._isPullCurrent = true;
    return true;
  }

  /**
   * Fence new subscription ownership and pull-currentness restoration while
   * allowing work that already owns this link to drain before deactivation.
   *
   * @returns Whether pull currentness changed from true to false.
   */
  public beginRetirement(): boolean {
    if (!this._active || this._isRetiring) {
      return false;
    }

    this._isRetiring = true;
    if (!this._isPullCurrent) {
      return false;
    }

    this._isPullCurrent = false;
    return true;
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

  public get repairAttempts(): number {
    return this._repairAttempts;
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
    this._isPullCurrent = false;
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
    if (!this._active || this._isRetiring || this._liveSubscription !== undefined) {
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
    if (!this._active || this._isRetiring || this._localSubscription !== undefined) {
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

  /** Retire an attempt superseded before the next executor repair starts. */
  public retireRepairAttempt(attempt: number): void {
    if (this._repairAttempts === attempt) {
      this._repairAttempts = Math.max(0, attempt - 1);
    }
  }

  public clearRepairAttempts(): void {
    this._repairAttempts = 0;
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

    this._isRetiring = true;
    this._active = false;
    this._replicationGeneration++;
    this._isPullCurrent = false;
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
