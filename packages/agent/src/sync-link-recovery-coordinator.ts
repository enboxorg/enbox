import type { SyncFeedConvergenceLinkContext } from './sync-feed-convergence-manager.js';
import type { SyncIdentityTaskRunner } from './sync-lifecycle-coordinator.js';
import type { SyncLinkController } from './sync-link-controller.js';
import type { SyncLinkWorkKind } from './sync-link-executor.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type {
  PushFailure,
  ReplicationLinkState,
  SyncDirection,
  SyncEvent,
} from './types/sync.js';
import type {
  SyncDurableFeedReconcileOptions,
  SyncDurableFeedReconcileResult,
} from './sync-durable-feed-reconciler.js';
import type { SyncRuntime, SyncRuntimeHandle } from './sync-runtime.js';

import { syncEventScope as eventScope } from './types/sync.js';
import { syncTargetFromLink } from './sync-target-resolver.js';
import { isTerminalSyncAuthorizationFailure, syncErrorMessage } from './sync-runtime-errors.js';

export type SyncLinkRecoveryTarget = SyncTarget & { linkKey: string };

export interface SyncLinkRecoveryCoordinatorOperations {
  captureIdentityTaskRunner(tenantDid: string): SyncIdentityTaskRunner;
  clearConvergence(linkKey: string): void;
  emitEvent(event: SyncEvent): void;
  getController(linkKey: string): SyncLinkController | undefined;
  getRuntime(): SyncRuntime;
  handleDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
    context: SyncFeedConvergenceLinkContext,
  ): Promise<unknown>;
  openPullSubscription(target: SyncLinkRecoveryTarget, controller: SyncLinkController): Promise<boolean>;
  openPushSubscription(target: SyncLinkRecoveryTarget, controller: SyncLinkController): Promise<boolean>;
  reconcileTarget(
    controller: SyncLinkController,
    target: SyncTarget,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult>;
  reportError(message: string, error: unknown): void;
  setStatus(link: ReplicationLinkState, status: ReplicationLinkState['status']): Promise<void>;
  warn(message: string): void;
}

export type SyncLinkRecoveryCoordinatorParams = {
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

/**
 * Coordinates per-link repair and durable reconciliation without depending on
 * Level storage. A backend supplies checkpoint/status persistence, durable
 * feed reconciliation, transport creation, and lifecycle supervision.
 */
export class SyncLinkRecoveryCoordinator {
  private readonly _maxRepairAttempts: number;
  private readonly _operations: SyncLinkRecoveryCoordinatorOperations;
  private readonly _reconcileDelayMs: number;
  private readonly _repairBackoffMs: readonly number[];

  public constructor({
    maxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS,
    operations,
    reconcileDelayMs = DEFAULT_RECONCILE_DELAY_MS,
    repairBackoffMs = DEFAULT_REPAIR_BACKOFF_MS,
  }: SyncLinkRecoveryCoordinatorParams) {
    this._maxRepairAttempts = maxRepairAttempts;
    this._operations = operations;
    this._reconcileDelayMs = reconcileDelayMs;
    this._repairBackoffMs = repairBackoffMs;
  }

  /** Move an active link offline and supervise its first repair attempt. */
  public async transitionToRepairing(
    controller: SyncLinkController,
  ): Promise<void> {
    const { link } = controller;
    if (link.status === 'paused' || !controller.isActive) {
      return;
    }

    // Publish the entire transition in one synchronous block — stale
    // reconciliation work, the repair mark, and the in-memory
    // repairing status (setOfflineStatus writes it before its first await).
    // Whoever consumes the request afterwards, whether an already-executing
    // pass's trailing turn or the supervision below, observes the complete
    // transition; only durability and supervision trail the block.
    controller.resetReplicationGeneration();
    controller.executor.request('repair');
    await this.setOfflineStatus(link, 'repairing');
    if (!controller.isActive) {
      return;
    }

    this.superviseExecutor(controller);
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
    if (link.status === 'paused') {
      return;
    }

    const controller = this._operations.getController(linkKey);
    if (controller !== undefined && controller.link !== link) {
      return;
    }
    if (controller?.isActive === true) {
      // Publish the pause's replication-generation bump synchronously, before
      // status persistence and subscription closure. An opener resolving while
      // the close below awaits an in-flight operation must be refused by
      // the replication-generation-fenced attach — attaching after the bump is
      // impossible, and anything attached before it is closed below.
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

  /** Cancel every runtime-owned timer for one exact link lifetime. */
  public cancelScheduledWork(controller: SyncLinkController): void {
    const runtime = this._operations.getRuntime();
    runtime.cancelTimer(SyncLinkRecoveryCoordinator.reconcileTimerKey(controller.linkKey));
    runtime.cancelTimer(SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey));
  }

  /** Schedule a failed repair using the bounded per-link backoff ladder. */
  private scheduleRepairRetry(controller: SyncLinkController): void {
    const { link } = controller;
    const runtime = this._operations.getRuntime();
    const timerKey = SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey);
    if (!controller.isActive || link.status !== 'repairing' || runtime.hasTimer(timerKey)) {
      return;
    }

    const attempts = controller.repairAttempts || 1;
    const delayMs = this._repairBackoffMs[
      Math.min(attempts - 1, this._repairBackoffMs.length - 1)
    ] ?? 0;
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

    this._operations.emitEvent({
      type           : 'reconcile:needed',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      reason,
    });
  }

  /** Schedule the earliest requested reconciliation for an exact link lifetime. */
  public scheduleReconcile(controller: SyncLinkController, delayMs = this._reconcileDelayMs): boolean {
    const normalizedDelay = Math.max(0, delayMs);
    const runtime = this._operations.getRuntime();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(controller.link.tenantDid);
    const timerKey = SyncLinkRecoveryCoordinator.reconcileTimerKey(controller.linkKey);
    return runtime.armTimeoutIfEarlier(timerKey, (): void => {
      if (this.isStale(controller, runtime)) {
        return;
      }
      controller.executor.request('reconcile');
      void runIdentityTask(() => this.runExecutor(controller));
    }, normalizedDelay);
  }

  /** Coalesce a durable reconciliation request into the link executor. */
  public reconcile(controller: SyncLinkController): Promise<void> {
    controller.executor.request('reconcile');
    return this.runExecutor(controller);
  }

  private superviseExecutor(controller: SyncLinkController): void {
    const runIdentityTask = this._operations.captureIdentityTaskRunner(controller.link.tenantDid);
    void runIdentityTask(() => this.runExecutor(controller));
  }

  private runExecutor(controller: SyncLinkController): Promise<void> {
    return controller.executor.drain(
      (kind): Promise<void> => this.executeWork(controller, kind),
    );
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
    if (this.isRepairCancelled(controller, this._operations.getRuntime())) {
      return;
    }

    try {
      await this.repairExclusive(controller);
    } catch {
      this.scheduleRepairRetry(controller);
      return;
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
      if (controller.executor.hasPending('repair')) {
        controller.retireRepairAttempt(attempts);
      }
    }
  }

  private async reopenSubscriptions(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    runtime: SyncRuntimeHandle,
  ): Promise<boolean> {
    const pullOpened = await this._operations.openPullSubscription(target, controller);
    if (!pullOpened) {
      return false;
    }
    if (this.isRepairSuperseded(controller, runtime)) {
      await controller.closeSubscriptions();
      return false;
    }

    try {
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
    // A pause or a newer repair request can land in the continuation gap
    // after the reopen path's final check — a terminal callback from the
    // freshly reopened subscription is enough. A superseded pass must not
    // clear progress, write the live status, or emit completion.
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }

    const { link } = controller;
    const previousConnectivity = link.connectivity;
    link.connectivity = 'online';
    await this._operations.setStatus(link, 'live');
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }

    controller.clearRepairAttempts();
    this._operations.getRuntime().cancelTimer(
      SyncLinkRecoveryCoordinator.repairRetryTimerKey(controller.linkKey),
    );
    controller.markReplicationReady();

    if (pushFailures.length > 0 && !this.isRepairSuperseded(controller, runtime)) {
      this.schedulePushRetry(controller);
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
    // A repair failing after it was superseded — an external pause tearing
    // down its I/O, or a newer repair request taking ownership — is a quiet
    // handoff: no report, no repair:failed, no rethrow into the retry
    // ladder, so the trailing turn (if any) runs immediately with the
    // newest transition state instead of inheriting this pass's failure.
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }

    const { link, linkKey } = controller;
    const errorMessage = syncErrorMessage(error);
    const failedEvent: SyncEvent = {
      type           : 'repair:failed',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      attempt        : attempts,
      error          : errorMessage,
    };
    if (isTerminalSyncAuthorizationFailure(errorMessage)) {
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
    if (attempts >= this._maxRepairAttempts) {
      this._operations.warn(
        `SyncLinkRecoveryCoordinator: Max repair attempts reached for ${link.tenantDid} -> ${link.remoteEndpoint}, pausing link`,
      );
      await this.transitionToPaused(linkKey, link);
      return;
    }
    throw error;
  }

  /** The reconciliation body. Runs only inside the controller's executor. */
  private async reconcileExclusive(controller: SyncLinkController): Promise<void> {
    const { link, linkKey } = controller;
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
      const pushFailures = outcome.pushFailures ?? [];
      if (pushFailures.length > 0) {
        this.schedulePushRetry(controller);
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
      if (outcome.converged) {
        this._operations.clearConvergence(linkKey);
        this.restoreLinkConnectivity(link);
        this._operations.emitEvent({
          type           : 'reconcile:completed',
          tenantDid      : link.tenantDid,
          remoteEndpoint : link.remoteEndpoint,
          ...eventScope(link.scope),
        });
      } else if (!this.isStale(controller, runtime)) {
        await this._operations.handleDivergence(target, outcome, { link, linkKey });
      }
    } catch (error: unknown) {
      // A rejection landing after an external pause (or a repair transition)
      // is cancellation, not a fault: reporting it and rearming the retry
      // timer would revive work the pause just cancelled.
      if (!shouldContinue()) {
        return;
      }
      this._operations.reportError(
        `SyncLinkRecoveryCoordinator: Reconciliation failed for ${link.tenantDid} -> ${link.remoteEndpoint}`,
        error,
      );
      // A trailing pass is already requested: it subsumes this retry, so
      // arming a timer as well would run a third full pass later.
      if (!controller.executor.hasPending('reconcile')) {
        this.scheduleReconcile(controller, RECONCILE_RETRY_DELAY_MS);
      }
    }
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
      if (direction === 'push' && (outcome.pushFailures?.length ?? 0) > 0) {
        this.schedulePushRetry(controller);
      }
    } catch (error: unknown) {
      if (!shouldContinue()) {
        return;
      }
      this._operations.reportError(
        `SyncLinkRecoveryCoordinator: Durable ${direction} pass failed for ${link.tenantDid} -> ${link.remoteEndpoint}`,
        error,
      );
      if (direction === 'push') {
        this.schedulePushRetry(controller);
      } else {
        this.scheduleLinkReconcileByKey(controller, 'pull-retryable', RECONCILE_RETRY_DELAY_MS);
      }
    }
  }

  /** A retryable push failure falls back to the verified reconciliation path. */
  private schedulePushRetry(controller: SyncLinkController): void {
    this.scheduleLinkReconcileByKey(controller, 'push-retryable', RECONCILE_RETRY_DELAY_MS);
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
   * Whether an in-flight repair lost its mandate. Pausing is deliberately
   * prompt and executor-independent, so an external pause lands while a repair is
   * mid-flight; the repair must observe the paused status at every
   * checkpoint and abandon the link instead of reopening subscriptions and
   * marking it live again — a pause caused by revoked authorization must
   * stay failed-safe until an explicit reconnect.
   */
  private isRepairCancelled(controller: SyncLinkController, runtime: SyncRuntimeHandle): boolean {
    return this.isStale(controller, runtime) || controller.link.status === 'paused';
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
}
