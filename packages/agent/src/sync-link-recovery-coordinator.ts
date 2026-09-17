import type { SyncFeedConvergenceManager } from './sync-feed-convergence-manager.js';
import type { SyncIdentityTaskRunner } from './sync-lifecycle-coordinator.js';
import type { SyncLinkController } from './sync-link-controller.js';
import type { SyncLinkWorkKind } from './sync-link-executor.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type {
  PushFailure,
  ReplicationLinkState,
  SyncDirection,
  SyncEvent,
  SyncLinkRecoveryState,
} from './types/sync.js';
import type {
  SyncDurableFeedReconcileOptions,
  SyncDurableFeedReconcileResult,
} from './sync-durable-feed-reconciler.js';
import type { SyncRuntime, SyncRuntimeHandle } from './sync-runtime.js';

import { syncTargetFromLink } from './sync-target-resolver.js';
import { syncEventScope as eventScope, isTerminalPushFailure } from './types/sync.js';
import {
  isRetryableSyncRecovery,
  isTerminalSyncAuthorizationFailure,
  syncErrorMessage,
  SyncPushFailuresError,
} from './sync-runtime-errors.js';

export type SyncLinkRecoveryTarget = SyncTarget & { linkKey: string };

export interface SyncLinkRecoveryCoordinatorOperations {
  captureIdentityTaskRunner(tenantDid: string): SyncIdentityTaskRunner;
  emitEvent(event: SyncEvent): void;
  getController(linkKey: string): SyncLinkController | undefined;
  getRuntime(): SyncRuntime;
  markPullPending(controller: SyncLinkController): void;
  openPullSubscription(target: SyncLinkRecoveryTarget, controller: SyncLinkController): Promise<boolean>;
  openPushSubscription(target: SyncLinkRecoveryTarget, controller: SyncLinkController): Promise<boolean>;
  reconcileTarget(
    controller: SyncLinkController,
    target: SyncTarget,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult>;
  reportError(message: string, error: unknown): void;
  setRecovery(link: ReplicationLinkState, recovery: SyncLinkRecoveryState | undefined): Promise<void>;
  setStatus(link: ReplicationLinkState, status: ReplicationLinkState['status']): Promise<void>;
  warn(message: string): void;
}

export type SyncLinkRecoveryCoordinatorParams = {
  feedConvergenceManager: SyncFeedConvergenceManager;
  maxRepairAttempts?: number;
  operations: SyncLinkRecoveryCoordinatorOperations;
  reconcileDelayMs?: number;
  repairBackoffMs?: readonly number[];
};

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
const POST_REPAIR_RECONCILE_DELAY_MS = 500;
const DEFAULT_RECONCILE_DELAY_MS = 1500;
const RECONCILE_RETRY_DELAY_MS = 5000;
const DEFAULT_REPAIR_BACKOFF_MS = [1000, 3000, 10_000] as const;
const RECONCILE_TIMER_PREFIX = 'syncReconcile:';
const REPAIR_RETRY_TIMER_PREFIX = 'syncRepairRetry:';
const ALL_SYNC_DIRECTIONS: readonly SyncDirection[] = ['pull', 'push'];

/**
 * Coordinates per-link repair and durable reconciliation without depending on
 * Level storage. Feed-convergence policy is a direct collaborator; a backend
 * supplies checkpoint/status persistence, durable-feed reconciliation,
 * transport creation, and lifecycle supervision.
 */
export class SyncLinkRecoveryCoordinator {
  private readonly _feedConvergenceManager: SyncFeedConvergenceManager;
  private readonly _maxRepairAttempts: number;
  private readonly _operations: SyncLinkRecoveryCoordinatorOperations;
  private readonly _reconcileDelayMs: number;
  private readonly _repairBackoffMs: readonly number[];
  /** Caller fence for the one awaited repair mark, visible to any executor drain owner. */
  private readonly _repairShouldContinue = new WeakMap<SyncLinkController, () => boolean>();

  public constructor({
    feedConvergenceManager,
    maxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS,
    operations,
    reconcileDelayMs = DEFAULT_RECONCILE_DELAY_MS,
    repairBackoffMs = DEFAULT_REPAIR_BACKOFF_MS,
  }: SyncLinkRecoveryCoordinatorParams) {
    this._feedConvergenceManager = feedConvergenceManager;
    this._maxRepairAttempts = maxRepairAttempts;
    this._operations = operations;
    this._reconcileDelayMs = reconcileDelayMs;
    this._repairBackoffMs = repairBackoffMs;
  }

  /** Move an active link offline and supervise its first repair attempt. */
  public async transitionToRepairing(
    controller: SyncLinkController,
  ): Promise<void> {
    if (!await this.requestRepair(controller)) {
      return;
    }

    this.superviseExecutor(controller);
  }

  /**
   * Restart a failed repair batch without disturbing deliberate pauses.
   * `resumePaused` exists only for explicit recovery of transient rows parked
   * by older versions; a missing or non-retryable diagnostic remains paused.
   */
  public async retryFailedRepair(
    controller: SyncLinkController,
    {
      ignoreRetryDeadline = false,
      resumePaused = false,
      shouldContinue = (): boolean => true,
    }: {
      ignoreRetryDeadline?: boolean;
      resumePaused?: boolean;
      shouldContinue?: () => boolean;
    } = {},
  ): Promise<boolean> {
    const { link } = controller;
    if (
      !controller.isActive ||
      controller.executor.hasWork('repair') ||
      !isRetryableSyncRecovery(link.recovery) ||
      (!ignoreRetryDeadline && this._operations.getRuntime().hasTimer(
        SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey),
      )) ||
      (link.status !== 'repairing' && !(resumePaused && link.status === 'paused')) ||
      !shouldContinue()
    ) {
      return false;
    }

    // requestRepair publishes a priority mark synchronously before awaiting
    // persistence. Store the caller fence first because an existing executor
    // owner may consume that mark while this call is still awaiting.
    this._repairShouldContinue.set(controller, shouldContinue);
    try {
      controller.clearRepairAttempts();
      if (!await this.requestRepair(controller, resumePaused)) {
        return false;
      }
      await this.runExecutor(controller);
      return true;
    } finally {
      if (this._repairShouldContinue.get(controller) === shouldContinue) {
        this._repairShouldContinue.delete(controller);
      }
    }
  }

  /** Publish a new repair request before either background or awaited supervision begins. */
  private async requestRepair(
    controller: SyncLinkController,
    resumePaused = false,
  ): Promise<boolean> {
    const { link } = controller;
    if ((link.status === 'paused' && !resumePaused) || !controller.isActive) {
      return false;
    }

    // Publish the entire transition in one synchronous block — stale
    // reconciliation work, the repair mark, and the in-memory
    // repairing status (setOfflineStatus writes it before its first await).
    // Whoever consumes the request afterwards, whether an already-executing
    // pass's trailing turn or the supervision below, observes the complete
    // transition; only durability and supervision trail the block.
    this._operations.markPullPending(controller);
    this._operations.getRuntime().cancelTimer(
      SyncLinkRecoveryCoordinator.reconcileTimerKey(controller.linkKey),
    );
    controller.clearRetryNotBefore(ALL_SYNC_DIRECTIONS);
    controller.resetReplicationGeneration();
    controller.executor.request('repair');
    await this.setOfflineStatus(link, 'repairing');
    if (!controller.isActive) {
      return false;
    }
    return true;
  }

  /**
   * Park a link and discard every transient runtime owned by its controller.
   * Never enters the executor — a durable link may have no controller (a
   * one-shot sync() or drain reconciles links without a live runtime, and a
   * rate-limited subscription open leaves a live link controller-less until
   * its init retry), repair failure paths invoke this from inside an executor
   * operation, and pausing must take effect promptly. Instead of
   * serializing, the paused status is a cancellation fence: an in-flight
   * repair observes it at every checkpoint and abandons the link rather
   * than overwriting the pause.
  */
  public async transitionToPaused(linkKey: string, link: ReplicationLinkState): Promise<void> {
    const controller = this._operations.getController(linkKey);
    if (controller !== undefined && controller.link !== link) {
      return;
    }
    if (link.status === 'paused') {
      // A new deliberate pause supersedes a legacy transient pause even when
      // both use the same durable status. Canonicalizing it here prevents the
      // next load from interpreting the stale diagnostic as resumable repair.
      if (isRetryableSyncRecovery(link.recovery)) {
        await this._operations.setStatus(link, 'paused');
      }
      return;
    }

    if (controller?.isActive === true) {
      // Publish the pause's replication-generation bump synchronously, before
      // status persistence and subscription closure. An opener resolving while
      // the close below awaits an in-flight operation must be refused by
      // the replication-generation-fenced attach — attaching after the bump is
      // impossible, and anything attached before it is closed below.
      this._operations.markPullPending(controller);
      controller.resetReplicationGeneration();
      this.cancelScheduledWork(controller);
    }

    await this.setOfflineStatus(link, 'paused');
    if (controller?.isActive !== true) {
      return;
    }

    await controller.closeSubscriptions();
    controller.clearRepairAttempts();
  }

  /**
   * Cancel reconciliation and repair scheduling for the controller's link key.
   * Same-key replacement controllers share these keys, so predecessor
   * scheduling must be cancelled before installing the successor.
   */
  public cancelScheduledWork(controller: SyncLinkController): void {
    const runtime = this._operations.getRuntime();
    runtime.cancelTimer(SyncLinkRecoveryCoordinator.reconcileTimerKey(controller.linkKey));
    runtime.cancelTimer(SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey));
    controller.clearRetryNotBefore(ALL_SYNC_DIRECTIONS);
  }

  /** Schedule a failed or superseded repair using the bounded per-link backoff ladder. */
  private scheduleRepairRetry(controller: SyncLinkController): void {
    const { link } = controller;
    const runtime = this._operations.getRuntime();
    const timerKey = SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey);
    if (!controller.isActive || link.status !== 'repairing' || runtime.hasTimer(timerKey)) {
      return;
    }

    const attempts = controller.repairAttempts || 1;
    const delayMs = this.repairRetryDelayMs(attempts);
    const runIdentityTask = this._operations.captureIdentityTaskRunner(link.tenantDid);
    runtime.armTimeout(timerKey, (): void => {
      if (this.isStale(controller, runtime) || link.status !== 'repairing') {
        return;
      }
      controller.executor.request('repair');
      void runIdentityTask(() => this.runExecutor(controller));
    }, delayMs);
  }

  /** Drain work retained while the current replication generation was not ready. */
  public resume(controller: SyncLinkController): Promise<void> {
    return this.runExecutor(controller);
  }

  /**
   * Serialize one caller-specific reconciliation operation through the link
   * executor. The operation must not await another call to `execute()` for
   * the same controller: that nested operation is ordered after its caller
   * and cannot start until the caller settles.
   */
  public execute<T>(controller: SyncLinkController, operation: () => Promise<T>): Promise<T | undefined> {
    const result = controller.executor.enqueue(operation);
    if (controller.executor.isReady) {
      // Awaited administrative calls already run inside their caller's sync
      // or lifecycle task. Start the executor in that ownership boundary so
      // stopSync() cannot close task intake between enqueue and a nested task.
      void this.runExecutor(controller);
    }
    return result;
  }

  /** Emit and coalesce a named durable-reconciliation request for a live link. */
  public scheduleLinkReconcileByKey(
    controller: SyncLinkController,
    reason: string,
    delayMs?: number,
  ): void {
    const { link } = controller;
    if (link.status !== 'live' || !controller.isActive) {
      return;
    }
    if (!this.scheduleReconcile(controller, delayMs)) {
      return;
    }
    this.emitReconcileNeeded(controller, reason);
  }

  /** Schedule the earliest reconciliation fenced by the captured controller lifetime. */
  public scheduleReconcile(controller: SyncLinkController, delayMs = this._reconcileDelayMs): boolean {
    const normalizedDelay = Math.max(0, delayMs);
    const runtime = this._operations.getRuntime();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(controller.link.tenantDid);
    const timerKey = SyncLinkRecoveryCoordinator.reconcileTimerKey(controller.linkKey);
    return runtime.armTimeoutIfEarlier(timerKey, (): void => {
      if (this.isStale(controller, runtime)) {
        return;
      }
      // Collapse queued directions only when the full pass may actually run.
      // An unrelated earlier timer must leave eligible directional work alone.
      if (this.isWorkEligible(controller, 'reconcile')) {
        controller.executor.consumePending('pull');
        controller.executor.consumePending('push');
        controller.executor.consumePending('reconcile');
      }
      controller.executor.request('reconcile');
      void runIdentityTask(() => this.runExecutor(controller));
    }, normalizedDelay);
  }

  private superviseExecutor(controller: SyncLinkController): void {
    const runIdentityTask = this._operations.captureIdentityTaskRunner(controller.link.tenantDid);
    void runIdentityTask(() => this.runExecutor(controller));
  }

  private runExecutor(controller: SyncLinkController): Promise<void> {
    return controller.executor.drain(
      (kind): Promise<void> => this.executeWork(controller, kind),
      (kind): boolean => this.isWorkEligible(controller, kind),
    );
  }

  /** Keep retained wakes parked until the failed direction's retry deadline. */
  private isWorkEligible(controller: SyncLinkController, kind: SyncLinkWorkKind): boolean {
    if (kind === 'repair') {
      return true;
    }

    const retryDelayMs = controller.getRetryDelayMs(kind);
    if (retryDelayMs === undefined) {
      return true;
    }

    this.scheduleReconcile(controller, retryDelayMs);
    return false;
  }

  private async executeWork(controller: SyncLinkController, kind: SyncLinkWorkKind): Promise<void> {
    if (kind === 'pull' || kind === 'push') {
      await this.reconcileDirectionExclusive(controller, kind);
      return;
    }
    if (kind === 'reconcile') {
      await this.reconcileExclusive(controller);
      return;
    }
    const shouldContinue = this._repairShouldContinue.get(controller);
    if (this.isRepairCancelled(controller, this._operations.getRuntime())) {
      if (shouldContinue !== undefined) {
        this._repairShouldContinue.delete(controller);
      }
      return;
    }

    try {
      await this.repairExclusive(controller);
    } catch {
      this.scheduleRepairRetry(controller);
      return;
    } finally {
      if (shouldContinue !== undefined && this._repairShouldContinue.get(controller) === shouldContinue) {
        this._repairShouldContinue.delete(controller);
      }
    }

    // A queued reconciliation provides the verification pass, while a
    // trailing repair owns recovery from here. Do not schedule both.
    if (
      !controller.executor.hasPending('repair') &&
      controller.isActive &&
      controller.link.status === 'live' &&
      !controller.executor.hasWork('reconcile')
    ) {
      this.scheduleLinkReconcileByKey(
        controller,
        'post-repair-gap',
        POST_REPAIR_RECONCILE_DELAY_MS,
      );
    }
  }

  /** The repair body. Runs only inside the controller's executor. */
  private async repairExclusive(controller: SyncLinkController): Promise<void> {
    const { link } = controller;
    const runtime = this._operations.getRuntime();
    runtime.cancelTimer(SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey));
    const attempts = controller.incrementRepairAttempts();
    this._operations.emitEvent({
      type           : 'repair:started',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      attempt        : attempts,
    });

    try {
      await controller.closeSubscriptions();
      if (this.isRepairSuperseded(controller, runtime)) {
        return;
      }
      controller.resetReplicationGeneration();
      if (this.isRepairSuperseded(controller, runtime)) {
        return;
      }

      const target = SyncLinkRecoveryCoordinator.targetFromController(controller);
      // The repair's full durable pass subsumes a reconcile wake already
      // pending at this boundary. A mark arriving during the pass remains
      // pending and runs afterward.
      controller.executor.consumePending('reconcile');
      const outcome = await this._operations.reconcileTarget(
        controller,
        target,
        undefined,
        () => !this.isRepairSuperseded(controller, runtime),
      );
      if (outcome.aborted || this.isRepairSuperseded(controller, runtime)) {
        return;
      }
      if (!await this.reopenSubscriptions(target, controller, runtime)) {
        return;
      }
      await this.completeRepair(controller, runtime, outcome.pushFailures ?? []);
    } catch (error: unknown) {
      await this.handleRepairFailure(controller, runtime, attempts, error);
    } finally {
      // A newer recovery signal supersedes this attempt, but it must not make
      // the executor spin close/reconcile/reopen without a delay while a
      // transport is flapping. Retain the signal through the runtime-owned
      // retry timer and leave genuine failures as the attempt-budget owner.
      if (controller.executor.consumePending('repair')) {
        controller.retireRepairAttempt(attempts);
        this.scheduleRepairRetry(controller);
      }
    }
  }

  private async reopenSubscriptions(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    runtime: SyncRuntimeHandle,
  ): Promise<boolean> {
    if (this.isRepairSuperseded(controller, runtime)) {
      return false;
    }
    const pullOpened = await this._operations.openPullSubscription(target, controller);
    if (!pullOpened) {
      return false;
    }
    if (this.isRepairSuperseded(controller, runtime)) {
      await controller.closeSubscriptions();
      return false;
    }
    if (controller.link.authorization.kind === 'role') {
      return true;
    }

    try {
      if (this.isRepairSuperseded(controller, runtime)) {
        await controller.closeSubscriptions();
        return false;
      }
      if (!await this._operations.openPushSubscription(target, controller)) {
        await controller.closeSubscriptions();
        return false;
      }
    } catch (error: unknown) {
      await controller.closeSubscriptions();
      throw error;
    }

    if (!this.isRepairSuperseded(controller, runtime)) {
      return true;
    }
    await controller.closeSubscriptions();
    return false;
  }

  private async completeRepair(
    controller: SyncLinkController,
    runtime: SyncRuntimeHandle,
    pushFailures: PushFailure[],
  ): Promise<void> {
    // A pause, caller cancellation, or newer repair request can land in the
    // continuation gap after the reopen path's final check — a terminal
    // callback from the freshly reopened subscription is enough. A
    // superseded pass must not clear progress, write the live status, or emit
    // completion.
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }

    const { link } = controller;
    const recovery = link.recovery;
    const previousConnectivity = link.connectivity;
    const repairGeneration = controller.replicationGeneration;
    link.connectivity = 'online';
    await this._operations.setStatus(link, 'live');
    if (this.isRepairSuperseded(controller, runtime)) {
      if (
        this.isRepairCallerCancelled(controller) &&
        controller.isReplicationGenerationCurrent(repairGeneration) &&
        link.status === 'live'
      ) {
        await controller.closeSubscriptions();
        if (!controller.isReplicationGenerationCurrent(repairGeneration) || link.status !== 'live') {
          return;
        }
        link.connectivity = 'offline';
        await this._operations.setStatus(link, 'repairing');
        if (!controller.isReplicationGenerationCurrent(repairGeneration) || controller.link.status !== 'repairing') {
          return;
        }
        await this._operations.setRecovery(link, recovery);
      }
      return;
    }

    controller.clearRepairAttempts();
    controller.clearRetryNotBefore(ALL_SYNC_DIRECTIONS);
    this._operations.getRuntime().cancelTimer(
      SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey),
    );
    controller.markReplicationReady();

    if (pushFailures.length > 0 && !this.isRepairSuperseded(controller, runtime)) {
      this.handlePushFailures(controller, pushFailures);
    }

    const linkEventScope = eventScope(link.scope);
    this._operations.emitEvent({
      type           : 'repair:completed',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...linkEventScope,
    });
    if (previousConnectivity !== 'online') {
      this._operations.emitEvent({
        type           : 'link:connectivity-change',
        tenantDid      : link.tenantDid,
        remoteEndpoint : link.remoteEndpoint,
        ...linkEventScope,
        from           : previousConnectivity,
        to             : 'online',
      });
    }
    this._operations.emitEvent({
      type           : 'link:status-change',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...linkEventScope,
      from           : 'repairing',
      to             : 'live',
    });
  }

  private async handleRepairFailure(
    controller: SyncLinkController,
    runtime: SyncRuntimeHandle,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    // A repair failing after it was superseded — caller cancellation, an
    // external pause tearing down its I/O, or a newer repair request taking
    // ownership — is a quiet handoff: no report and no repair:failed. The
    // retained signal follows the supersession backoff without inheriting
    // this pass's failure or consuming its attempt budget.
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }

    const { link, linkKey } = controller;
    const errorMessage = syncErrorMessage(error);
    const terminal = isTerminalSyncAuthorizationFailure(errorMessage);
    const exhausted = attempts >= this._maxRepairAttempts;
    const retryDelayMs = terminal || exhausted ? undefined : this.repairRetryDelayMs(attempts);
    await this._operations.setRecovery(
      link,
      SyncLinkRecoveryCoordinator.recoveryState(errorMessage, retryDelayMs),
    );
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }
    const failedEvent: SyncEvent = {
      type           : 'repair:failed',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      attempt        : attempts,
      error          : errorMessage,
    };
    if (terminal) {
      this._operations.warn(
        `SyncLinkRecoveryCoordinator: sync authorization for ${link.tenantDid} -> ${link.remoteEndpoint} ` +
        'was revoked or expired — pausing link (reconnect to resume).',
      );
      this._operations.emitEvent(failedEvent);
      await this.transitionToPaused(linkKey, link);
      return;
    }

    this._operations.reportError(
      `SyncLinkRecoveryCoordinator: Repair failed for ${link.tenantDid} -> ${link.remoteEndpoint} (attempt ${attempts})`,
      error,
    );
    this._operations.emitEvent(failedEvent);
    if (exhausted) {
      // End this bounded batch without converting a transient outage into the
      // durable pause used by authorization and convergence policy. A later
      // sync/settle check (or explicit retry) starts a fresh bounded batch.
      this._operations.warn(
        `SyncLinkRecoveryCoordinator: Max repair attempts reached for ${link.tenantDid} -> ${link.remoteEndpoint}; ` +
        'waiting for the next sync check or explicit retry',
      );
      controller.clearRepairAttempts();
      return;
    }
    throw error;
  }

  /** The reconciliation body. Runs only inside the controller's executor. */
  private async reconcileExclusive(controller: SyncLinkController): Promise<void> {
    const { link } = controller;
    if (!controller.isActive || link.status !== 'live') {
      return;
    }

    const runtime = this._operations.getRuntime();
    const shouldContinue = (): boolean =>
      !this.isStale(controller, runtime) && link.status === 'live';
    const target = syncTargetFromLink(link);
    // This pass owns every reconcile deadline armed before it starts. Cancel
    // that stale retry now; a fresh deadline armed while the pass is in
    // flight remains distinguishable and survives the result.
    runtime.cancelTimer(SyncLinkRecoveryCoordinator.reconcileTimerKey(controller.linkKey));
    try {
      const outcome = await this._operations.reconcileTarget(
        controller,
        target,
        { verifyConvergence: true },
        shouldContinue,
      );
      if (outcome.aborted || !shouldContinue()) {
        return;
      }
      controller.clearRetryNotBefore(ALL_SYNC_DIRECTIONS);
      await this.handleReconcileOutcome(controller, target, outcome, shouldContinue);
    } catch (error: unknown) {
      await this.handleReconcileFailure(
        controller,
        error,
        'Reconciliation',
        'reconcile-failed',
        ALL_SYNC_DIRECTIONS,
        shouldContinue,
      );
    }
  }

  private async handleReconcileOutcome(
    controller: SyncLinkController,
    target: SyncTarget,
    outcome: SyncDurableFeedReconcileResult,
    shouldContinue: () => boolean,
  ): Promise<void> {
    const { link, linkKey } = controller;
    const pushFailures = outcome.pushFailures ?? [];
    if (pushFailures.length > 0) {
      this.handlePushFailures(controller, pushFailures);
      return;
    }
    // A pause took the link before the cycle ran, so nothing was compared.
    // It is neither converged nor divergent: completing the repair would
    // claim a verification that never happened, and handling divergence
    // would fight the pause. The pause owns the link now.
    if (outcome.paused === true) {
      return;
    }
    // A deferred remote root holds its durable page until a later wake or
    // settle pass. It is neither divergence nor a transport failure, so it
    // must not enter the fixed-delay verified-reconcile retry loop.
    if (outcome.deferredPull !== undefined) {
      return;
    }

    const reconciled = link.authorization.kind === 'role'
      ? outcome.pullDrained === true
      : outcome.converged === true;
    if (!reconciled) {
      if (link.authorization.kind !== 'role' && shouldContinue()) {
        await this._feedConvergenceManager.handleVerifiedDivergence(target, outcome, { link, linkKey });
      }
      return;
    }

    if (link.recovery !== undefined) {
      await this._operations.setRecovery(link, undefined);
    }
    if (!shouldContinue()) {
      return;
    }
    this._feedConvergenceManager.clearLink(linkKey);
    this.restoreLinkConnectivity(link);
    this._operations.emitEvent({
      type           : 'reconcile:completed',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
    });
  }

  /** Reconcile one durable direction from its checkpoint inside the link executor. */
  private async reconcileDirectionExclusive(
    controller: SyncLinkController,
    direction: SyncDirection,
  ): Promise<void> {
    const { link } = controller;
    if (!controller.isActive || link.status !== 'live') {
      return;
    }

    const runtime = this._operations.getRuntime();
    const shouldContinue = (): boolean =>
      !this.isStale(controller, runtime) && link.status === 'live';
    try {
      const outcome = await this._operations.reconcileTarget(
        controller,
        syncTargetFromLink(link),
        { direction },
        shouldContinue,
      );
      if (outcome.aborted || !shouldContinue()) {
        return;
      }
      controller.clearRetryNotBefore([direction]);
      const pushFailures = outcome.pushFailures ?? [];
      if (direction === 'push' && pushFailures.length > 0) {
        this.handlePushFailures(controller, pushFailures);
      }
    } catch (error: unknown) {
      await this.handleReconcileFailure(
        controller,
        error,
        `Durable ${direction} pass`,
        `${direction}-retryable`,
        [direction],
        shouldContinue,
      );
    }
  }

  /** A retryable push failure falls back to the verified reconciliation path. */
  private schedulePushRetry(controller: SyncLinkController): void {
    this.scheduleReconcileRetry(controller, ['push']);
    this.emitReconcileNeeded(controller, 'push-retryable');
  }

  /** Report retryable failures once at this boundary, then schedule their retry. */
  private handlePushFailures(controller: SyncLinkController, failures: PushFailure[]): void {
    // Terminal failures were already dead-lettered and reported while their
    // push result was folded. They must neither be reported again nor retried.
    const retryableFailures = failures.filter(failure => !isTerminalPushFailure(failure));
    if (retryableFailures.length === 0) {
      return;
    }

    const { link } = controller;
    const error = new SyncPushFailuresError({
      authorization  : link.authorization,
      failures       : retryableFailures,
      remoteEndpoint : link.remoteEndpoint,
      tenantDid      : link.tenantDid,
    });
    this._operations.reportError('SyncLinkRecoveryCoordinator: Reconciliation push failed', error);
    this.schedulePushRetry(controller);
  }

  private async handleReconcileFailure(
    controller: SyncLinkController,
    error: unknown,
    failureLabel: string,
    retryReason: string,
    directions: readonly SyncDirection[],
    shouldContinue: () => boolean,
  ): Promise<void> {
    // A rejection landing after an external pause (or a repair transition)
    // is cancellation, not a fault: reporting it and rearming the retry
    // timer would revive work the pause just cancelled.
    if (!shouldContinue()) {
      return;
    }

    const { link } = controller;
    this._operations.reportError(
      `SyncLinkRecoveryCoordinator: ${failureLabel} failed for ${link.tenantDid} -> ${link.remoteEndpoint}`,
      error,
    );

    const nextRetryAt = this.scheduleReconcileRetry(controller, directions);
    const recovery = SyncLinkRecoveryCoordinator.recoveryState(syncErrorMessage(error));
    await this._operations.setRecovery(link, { ...recovery, nextRetryAt });
    if (!shouldContinue()) {
      return;
    }
    this.emitReconcileNeeded(controller, retryReason);
  }

  /** Arm one authoritative retry deadline while retaining coalesced wake work. */
  private scheduleReconcileRetry(
    controller: SyncLinkController,
    directions: readonly SyncDirection[],
  ): string {
    const now = Date.now();
    const retryNotBefore = controller.setRetryNotBefore(
      directions,
      now + RECONCILE_RETRY_DELAY_MS,
    );
    this.scheduleReconcile(controller, retryNotBefore - now);
    return new Date(retryNotBefore).toISOString();
  }

  private emitReconcileNeeded(controller: SyncLinkController, reason: string): void {
    this._operations.emitEvent({
      type           : 'reconcile:needed',
      tenantDid      : controller.link.tenantDid,
      remoteEndpoint : controller.link.remoteEndpoint,
      ...eventScope(controller.link.scope),
      reason,
    });
  }

  private repairRetryDelayMs(attempts: number): number {
    return this._repairBackoffMs[
      Math.min(attempts - 1, this._repairBackoffMs.length - 1)
    ] ?? 0;
  }

  /**
   * A verified convergence just round-tripped the endpoint, so reachability
   * is proven. Stream attachment remains transport-owned and is reported by
   * its lifecycle events.
   */
  private restoreLinkConnectivity(link: ReplicationLinkState): void {
    const previous = link.connectivity;
    if (previous === 'online') {
      return;
    }

    link.connectivity = 'online';
    this._operations.emitEvent({
      type           : 'link:connectivity-change',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      from           : previous,
      to             : 'online',
    });
  }

  private async setOfflineStatus(
    link: ReplicationLinkState,
    status: ReplicationLinkState['status'],
  ): Promise<void> {
    const previousStatus = link.status;
    const previousConnectivity = link.connectivity;
    link.connectivity = 'offline';
    await this._operations.setStatus(link, status);

    const scope = eventScope(link.scope);
    this._operations.emitEvent({
      type           : 'link:status-change',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...scope,
      from           : previousStatus,
      to             : status,
    });
    if (previousConnectivity !== 'offline') {
      this._operations.emitEvent({
        type           : 'link:connectivity-change',
        tenantDid      : link.tenantDid,
        remoteEndpoint : link.remoteEndpoint,
        ...scope,
        from           : previousConnectivity,
        to             : 'offline',
      });
    }
  }

  private isStale(controller: SyncLinkController, runtime: SyncRuntimeHandle): boolean {
    return runtime.disposed || !controller.isActive;
  }

  /**
   * Whether an in-flight repair lost its mandate. Caller cancellation and
   * pausing are deliberately prompt and executor-independent; the repair must
   * observe both at every checkpoint and abandon the link instead of
   * reopening subscriptions or marking it live again. A pause caused by
   * revoked authorization must stay fail-safe until an explicit reconnect.
   */
  private isRepairCancelled(controller: SyncLinkController, runtime: SyncRuntimeHandle): boolean {
    return this.isStale(controller, runtime) ||
      controller.link.status === 'paused' ||
      this.isRepairCallerCancelled(controller);
  }

  /** Whether the caller awaiting this exact repair mark withdrew its mandate. */
  private isRepairCallerCancelled(controller: SyncLinkController): boolean {
    return this._repairShouldContinue.get(controller)?.() === false;
  }

  /**
   * Whether the executing repair pass has been superseded: cancelled, or a
   * newer repair request has taken ownership of the link's recovery. The
   * superseded pass must not reopen subscriptions, clear progress, write
   * the live status, or emit completion — the trailing turn begins with the
   * link still repairing so its failures feed the normal retry ladder.
   */
  private isRepairSuperseded(controller: SyncLinkController, runtime: SyncRuntimeHandle): boolean {
    return this.isRepairCancelled(controller, runtime) || controller.executor.hasPending('repair');
  }

  private static targetFromController(controller: SyncLinkController): SyncLinkRecoveryTarget {
    return {
      ...syncTargetFromLink(controller.link),
      linkKey: controller.linkKey,
    };
  }

  private static reconcileTimerKey(linkKey: string): string {
    return `${RECONCILE_TIMER_PREFIX}${linkKey}`;
  }

  private static repairRetryTimerKey(linkKey: string): string {
    return `${REPAIR_RETRY_TIMER_PREFIX}${linkKey}`;
  }

  private static recoveryState(error: string, retryDelayMs?: number): SyncLinkRecoveryState {
    const failedAt = new Date().toISOString();
    return {
      error,
      failedAt,
      nextRetryAt: retryDelayMs === undefined
        ? undefined
        : new Date(Date.parse(failedAt) + retryDelayMs).toISOString(),
    };
  }
}
