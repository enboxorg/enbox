import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { ReplicationLinkState, SyncDirection } from './types/sync.js';

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
 * boundary for subscriptions and serialized pull/push execution.
 * Runtime-owned link scheduling is held separately by `SyncRuntime` under the
 * controller's `linkKey`.
 * Captured callbacks use `isActive` to reject work belonging to a replaced or
 * removed link without consulting backend-specific state.
 */
export class SyncLinkController {
  private _active = true;
  public readonly executor = new SyncLinkExecutor();
  private _liveSubscription?: SyncLinkSubscription;
  private _liveSubscriptionGeneration = 0;
  private _localSubscription?: SyncLinkSubscription;
  private _localSubscriptionGeneration = 0;
  private _isPullCurrent = false;
  private _isDeactivating = false;
  private _pendingLivePullDeliveries = 0;
  private _pullSnapshot?: SyncFeedSnapshot;
  private _replicationGeneration = 0;
  private readonly _retryAttempts = new Map<SyncDirection, number>();
  private _pushSnapshot?: SyncFeedSnapshot;
  private readonly _retryNotBefore = new Map<SyncDirection, number>();
  private readonly _subscriptionRetryAttempts = new Map<SyncDirection, number>();

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

  /** Whether every accepted remote pull event or wake is covered by settled work. */
  public get isPullCurrent(): boolean {
    return this._active && this._isPullCurrent;
  }

  /** Record that accepted remote pull work is not yet settled. */
  public markPullPending(): boolean {
    if (!this._active || !this._isPullCurrent) {
      return false;
    }

    this._isPullCurrent = false;
    return true;
  }

  /**
   * Mark the pull side current only for the expected replication generation
   * and only when no trailing pull wake or live delivery remains.
   */
  public markPullCurrent(expectedReplicationGeneration: number): boolean {
    if (
      this._isDeactivating ||
      !this.isReplicationGenerationCurrent(expectedReplicationGeneration) ||
      this.executor.hasPending('pull') ||
      this._pendingLivePullDeliveries > 0 ||
      this._isPullCurrent
    ) {
      return false;
    }

    this._isPullCurrent = true;
    return true;
  }

  /** Retain one socket delivery until its ordered admission and checkpoint commit settle. */
  public beginLivePullDelivery(expectedReplicationGeneration: number): boolean {
    if (
      this._isDeactivating ||
      !this.isReplicationGenerationCurrent(expectedReplicationGeneration) ||
      (!this._isPullCurrent && this._pendingLivePullDeliveries === 0)
    ) {
      return false;
    }

    this._pendingLivePullDeliveries++;
    return true;
  }

  /** Release one socket delivery only from the replication generation that retained it. */
  public endLivePullDelivery(expectedReplicationGeneration: number): void {
    if (!this.isReplicationGenerationCurrent(expectedReplicationGeneration)) {
      return;
    }

    this._pendingLivePullDeliveries = Math.max(0, this._pendingLivePullDeliveries - 1);
  }

  /**
   * Fence new subscription ownership and pull-currentness restoration while
   * allowing work that already owns this link to drain before deactivation.
   *
   * @returns Whether pull currentness changed from true to false.
   */
  public beginDeactivation(): boolean {
    if (!this._active || this._isDeactivating) {
      return false;
    }

    this._isDeactivating = true;
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

  public get hasLiveSubscription(): boolean {
    return this._liveSubscription !== undefined;
  }

  public get hasLocalSubscription(): boolean {
    return this._localSubscription !== undefined;
  }

  public get liveSubscriptionGeneration(): number {
    return this._liveSubscriptionGeneration;
  }

  public get localSubscriptionGeneration(): number {
    return this._localSubscriptionGeneration;
  }

  public isLiveSubscriptionGenerationCurrent(generation: number): boolean {
    return this._active && generation === this._liveSubscriptionGeneration;
  }

  public isLocalSubscriptionGenerationCurrent(generation: number): boolean {
    return this._active && generation === this._localSubscriptionGeneration;
  }

  /** Begin a fresh replication generation and fence caller-specific executor work. */
  public resetReplicationGeneration(): void {
    this._replicationGeneration++;
    this._isPullCurrent = false;
    this._pendingLivePullDeliveries = 0;
    this._pullSnapshot = undefined;
    this._pushSnapshot = undefined;
    this._liveSubscriptionGeneration++;
    this._localSubscriptionGeneration++;
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
    expectedSubscriptionGeneration?: number,
  ): boolean {
    if (!this._active || this._isDeactivating || this._liveSubscription !== undefined) {
      return false;
    }
    if (expectedReplicationGeneration !== undefined && expectedReplicationGeneration !== this._replicationGeneration) {
      return false;
    }
    if (expectedSubscriptionGeneration !== undefined && expectedSubscriptionGeneration !== this._liveSubscriptionGeneration) {
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
    expectedSubscriptionGeneration?: number,
  ): boolean {
    if (!this._active || this._isDeactivating || this._localSubscription !== undefined) {
      return false;
    }
    if (expectedReplicationGeneration !== undefined && expectedReplicationGeneration !== this._replicationGeneration) {
      return false;
    }
    if (expectedSubscriptionGeneration !== undefined && expectedSubscriptionGeneration !== this._localSubscriptionGeneration) {
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
    this._liveSubscriptionGeneration++;
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
    this._localSubscriptionGeneration++;
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

  public incrementRetryAttempts(direction: SyncDirection): number {
    const attempts = (this._retryAttempts.get(direction) ?? 0) + 1;
    this._retryAttempts.set(direction, attempts);
    return attempts;
  }

  public clearRetryAttempts(direction: SyncDirection): void {
    this._retryAttempts.delete(direction);
  }

  public incrementSubscriptionRetryAttempts(direction: SyncDirection): number {
    const attempts = (this._subscriptionRetryAttempts.get(direction) ?? 0) + 1;
    this._subscriptionRetryAttempts.set(direction, attempts);
    return attempts;
  }

  public clearSubscriptionRetryAttempts(direction: SyncDirection): void {
    this._subscriptionRetryAttempts.delete(direction);
  }

  /** Hold selected durable directions until their retry deadline. */
  public setRetryNotBefore(directions: readonly SyncDirection[], retryNotBefore: number): number {
    let effectiveRetryNotBefore = retryNotBefore;
    for (const direction of directions) {
      const existing = this._retryNotBefore.get(direction) ?? 0;
      const effective = Math.max(existing, retryNotBefore);
      this._retryNotBefore.set(direction, effective);
      effectiveRetryNotBefore = Math.max(effectiveRetryNotBefore, effective);
    }
    return effectiveRetryNotBefore;
  }

  /** Clear retry eligibility after successful or explicitly retried work. */
  public clearRetryNotBefore(directions: readonly SyncDirection[]): void {
    for (const direction of directions) {
      this._retryNotBefore.delete(direction);
    }
  }

  /** Remaining delay before a direction or full reconciliation may run. */
  public getRetryDelayMs(direction: SyncDirection, now = Date.now()): number | undefined {
    let retryNotBefore = 0;
    const deadline = this._retryNotBefore.get(direction);
    if (deadline === undefined) {
      return undefined;
    }
    if (deadline <= now) {
      this._retryNotBefore.delete(direction);
      return undefined;
    }
    retryNotBefore = deadline;

    return retryNotBefore === 0 ? undefined : retryNotBefore - now;
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

    this._isDeactivating = true;
    this._active = false;
    this._replicationGeneration++;
    this._isPullCurrent = false;
    this._pullSnapshot = undefined;
    this._pushSnapshot = undefined;
    this.executor.dispose();
    this._retryAttempts.clear();
    this._retryNotBefore.clear();
    this._subscriptionRetryAttempts.clear();
  }

  /** Deactivate the link and close its transport subscriptions. */
  public async dispose(): Promise<void> {
    this.deactivate();
    await this.closeSubscriptions();
  }
}
