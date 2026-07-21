import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncFeedConvergenceLinkContext } from './sync-feed-convergence-manager.js';
import type { SyncIdentityTaskRunner } from './sync-lifecycle-coordinator.js';
import type { SyncLinkController } from './sync-link-controller.js';
import type { SyncRuntimeHandle } from './sync-runtime.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type {
  PushFailure,
  ReplicationLinkState,
  SyncEvent,
} from './types/sync.js';
import type {
  SyncDurableFeedReconcileOptions,
  SyncDurableFeedReconcileResult,
} from './sync-durable-feed-reconciler.js';

import { syncEventScope as eventScope } from './types/sync.js';
import { syncTargetFromLink } from './sync-target-resolver.js';
import { isSyncProgressGapError, isTerminalSyncAuthorizationFailure, syncErrorMessage } from './sync-runtime-errors.js';

export type SyncLinkRecoveryTarget = SyncTarget & { linkKey: string };

export interface SyncLinkRecoveryCoordinatorOperations {
  captureIdentityTaskRunner(tenantDid: string): SyncIdentityTaskRunner;
  clearConvergence(linkKey: string): void;
  emitEvent(event: SyncEvent): void;
  getController(linkKey: string): SyncLinkController | undefined;
  getRuntime(): SyncRuntimeHandle;
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
    bypassDirectionQueues?: boolean,
  ): Promise<SyncDurableFeedReconcileResult>;
  reportError(message: string, error: unknown): void;
  resetPullCheckpoint(link: ReplicationLinkState, resumeToken?: ProgressToken): Promise<void>;
  setStatus(link: ReplicationLinkState, status: ReplicationLinkState['status']): Promise<void>;
  warn(message: string): void;
}

export type SyncLinkRecoveryCoordinatorParams = {
  maxRepairAttempts?: number;
  operations: SyncLinkRecoveryCoordinatorOperations;
  reconcileDelayMs?: number;
  repairBackoffMs?: readonly number[];
};

export type SyncRepairTransitionOptions = {
  resumeToken?: ProgressToken;
};

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
const POST_REPAIR_RECONCILE_DELAY_MS = 500;
const DEFAULT_RECONCILE_DELAY_MS = 1500;
const RECONCILE_RETRY_DELAY_MS = 5000;
const DEFAULT_REPAIR_BACKOFF_MS = [1000, 3000, 10_000] as const;

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
    options?: SyncRepairTransitionOptions,
  ): Promise<void> {
    const { link } = controller;
    if (link.status === 'paused' || !controller.isActive) {
      return;
    }

    // Publish the entire transition in one synchronous block — abandoned
    // pull deliveries, the resume token, the run request, and the in-memory
    // repairing status (setOfflineStatus writes it before its first await).
    // Whoever consumes the request afterwards, whether an already-executing
    // pass's trailing turn or the supervision below, observes the complete
    // transition; only durability and supervision trail the block.
    controller.resetReplicationGeneration();
    if (options?.resumeToken !== undefined) {
      controller.setRepairResumeToken(options.resumeToken);
    }
    controller.requestPass('repair');
    await this.setOfflineStatus(link, 'repairing');
    if (!controller.isActive) {
      return;
    }

    const runIdentityTask = this._operations.captureIdentityTaskRunner(link.tenantDid);
    this.superviseRepairPasses(controller, runIdentityTask);
  }

  /**
   * Park a link and discard every transient runtime owned by its controller.
   * Never enters the mailbox — a durable link may have no controller (a
   * one-shot sync() or drain reconciles links without a live runtime, and a
   * rate-limited subscription open leaves a live link controller-less until
   * its init retry), repair failure paths invoke this from inside a mailbox
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
    }

    await this.setOfflineStatus(link, 'paused');
    if (controller?.isActive !== true) {
      return;
    }

    await controller.closeSubscriptions();
    controller.cancelReconcileTimer();
    controller.clearRepairProgress();
  }

  /** Schedule a failed repair using the bounded per-link backoff ladder. */
  public scheduleRepairRetry(controller: SyncLinkController): void {
    const { link } = controller;
    if (!controller.isActive || link.status !== 'repairing' || controller.repairRetryTimer !== undefined) {
      return;
    }

    const attempts = controller.repairAttempts || 1;
    const delayMs = this._repairBackoffMs[
      Math.min(attempts - 1, this._repairBackoffMs.length - 1)
    ] ?? 0;
    const runtime = this._operations.getRuntime();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(link.tenantDid);
    const timer = setTimeout((): void => {
      if (!controller.consumeRepairRetryTimer(timer)) {
        return;
      }
      if (this.isStale(controller, runtime) || link.status !== 'repairing') {
        return;
      }
      controller.requestPass('repair');
      this.superviseRepairPasses(controller, runIdentityTask);
    }, delayMs);
    controller.setRepairRetryTimer(timer);
  }

  /**
   * Coalesce repair callers onto one queued-or-running mailbox repair.
   * The mailbox serializes the repair behind any in-flight push or
   * reconciliation pass for the same link, so repair never tears down
   * subscriptions or direction replay queues underneath another link operation.
   */
  public repair(controller: SyncLinkController): Promise<void> {
    controller.requestPass('repair');
    return this.runRequestedRepairPasses(controller);
  }

  /** Run requested repair passes; requests are marked by their transitions. */
  private runRequestedRepairPasses(controller: SyncLinkController): Promise<void> {
    return controller.runRequestedPasses('repair', async (): Promise<void> => {
      if (this.isRepairCancelled(controller, this._operations.getRuntime())) {
        return;
      }
      await this.repairExclusive(controller);

      // A reconcile already queued behind this repair (a timer that expired
      // while the repair held the mailbox) provides the verification pass —
      // arming the post-repair timer too would run a duplicate full pass.
      // Likewise, a trailing repair request owns the link's recovery from
      // here.
      if (
        !controller.isPassRequested('repair') &&
        controller.isActive &&
        controller.link.status === 'live' &&
        !controller.isMailboxBusy('reconcile')
      ) {
        this.scheduleLinkReconcileByKey(
          controller,
          'post-repair-gap',
          POST_REPAIR_RECONCILE_DELAY_MS,
        );
      }
    });
  }

  /** Coalesce local feed signals into ordered durable push passes. */
  public push(controller: SyncLinkController): Promise<void> {
    controller.requestPass('push');
    return controller.runRequestedPasses('push', (): Promise<void> => this.pushExclusive(controller));
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
    const dueAt = Date.now() + normalizedDelay;
    if (!this.replaceLaterReconcileTimer(controller, dueAt)) {
      return false;
    }

    const runtime = this._operations.getRuntime();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(controller.link.tenantDid);
    const timer = setTimeout((): void => {
      if (!controller.consumeReconcileTimer(timer) || this.isStale(controller, runtime)) {
        return;
      }
      void runIdentityTask(async (): Promise<void> => {
        try {
          await this.reconcile(controller);
        } catch {
          // reconcileExclusive reports failures before rejecting.
        }
      });
    }, normalizedDelay);
    controller.setReconcileTimer(timer, dueAt);
    return true;
  }

  /**
   * Coalesce reconciliation callers onto one mailbox lane. Callers
   * arriving before the pass takes its remote snapshot join it; a signal
   * arriving after the snapshot is news that pass cannot have seen, so it
   * runs as one trailing pass instead of being silently absorbed.
   */
  public async reconcile(controller: SyncLinkController): Promise<void> {
    controller.requestPass('reconcile');
    await controller.runRequestedPasses('reconcile', (): Promise<void> => this.reconcileExclusive(controller));
  }

  private superviseRepairPasses(
    controller: SyncLinkController,
    runIdentityTask: SyncIdentityTaskRunner,
  ): void {
    void runIdentityTask(async (): Promise<void> => {
      try {
        await this.runRequestedRepairPasses(controller);
      } catch {
        this.scheduleRepairRetry(controller);
      }
    });
  }

  /** The repair body. Runs only inside the controller's mailbox. */
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

    await controller.closeSubscriptions();
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }
    controller.resetReplicationGeneration();
    await controller.waitForSupersededDirectionWork();
    if (this.isRepairSuperseded(controller, runtime)) {
      return;
    }

    try {
      const target = SyncLinkRecoveryCoordinator.targetFromController(controller);
      const outcome = await this._operations.reconcileTarget(
        controller,
        target,
        undefined,
        () => !this.isRepairSuperseded(controller, runtime),
        true,
      );
      if (outcome.aborted || this.isRepairSuperseded(controller, runtime)) {
        return;
      }
      this.emitApplied(link, outcome.admittedCids);

      const resumeToken = controller.repairResumeToken ?? link.pull.contiguousAppliedToken;
      await this._operations.resetPullCheckpoint(link, resumeToken);
      if (this.isRepairSuperseded(controller, runtime)) {
        return;
      }
      if (!await this.reopenSubscriptions(target, controller, runtime)) {
        return;
      }
      await this.completeRepair(controller, runtime, outcome.pushFailures ?? []);
    } catch (error: unknown) {
      await this.handleRepairFailure(controller, runtime, attempts, error);
    }
  }

  private async reopenSubscriptions(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    runtime: SyncRuntimeHandle,
  ): Promise<boolean> {
    const pullOpened = await this.openRepairPullSubscription(target, controller, runtime);
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

  private async openRepairPullSubscription(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    runtime: SyncRuntimeHandle,
  ): Promise<boolean> {
    try {
      return await this._operations.openPullSubscription(target, controller);
    } catch (error: unknown) {
      if (!isSyncProgressGapError(error)) {
        throw error;
      }

      this._operations.warn(
        `SyncLinkRecoveryCoordinator: Stale pull resume token for ${target.did} -> ${target.dwnUrl}, resetting to start fresh`,
      );
      await this._operations.resetPullCheckpoint(controller.link);
      if (this.isRepairSuperseded(controller, runtime)) {
        return false;
      }
      return this._operations.openPullSubscription(target, controller);
    }
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

    controller.clearRepairProgress();
    controller.markReplicationReady();
    if (controller.isPassRequested('push')) {
      const runIdentityTask = this._operations.captureIdentityTaskRunner(link.tenantDid);
      void runIdentityTask(() => this.push(controller));
    }

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

  /** The reconciliation body. Runs only inside the controller's mailbox. */
  private async reconcileExclusive(controller: SyncLinkController): Promise<void> {
    const { link, linkKey } = controller;
    // A busy repair lane here can only mean a repair queued behind this
    // pass (a running repair would occupy the mailbox instead of us) —
    // skip the pass and let the repair's own reconciliation cover it.
    if (!controller.isActive || link.status !== 'live' || controller.isMailboxBusy('repair')) {
      return;
    }

    const runtime = this._operations.getRuntime();
    const shouldContinue = (): boolean =>
      !this.isStale(controller, runtime) && link.status === 'live';
    const target = syncTargetFromLink(link);
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
      this.emitApplied(link, outcome.admittedCids);

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
      if (!controller.isPassRequested('reconcile')) {
        this.scheduleReconcile(controller, RECONCILE_RETRY_DELAY_MS);
      }
    }
  }

  private emitApplied(link: ReplicationLinkState, messageCids: string[] | undefined): void {
    if (messageCids === undefined || messageCids.length === 0) {
      return;
    }
    this._operations.emitEvent({
      type           : 'reconcile:applied',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      messageCids,
    });
  }

  /** Push the local durable feed from its checkpoint inside the link mailbox. */
  private async pushExclusive(controller: SyncLinkController): Promise<void> {
    const { link } = controller;
    if (!controller.isActive || link.status !== 'live' || controller.isMailboxBusy('repair')) {
      return;
    }

    const runtime = this._operations.getRuntime();
    const shouldContinue = (): boolean =>
      !this.isStale(controller, runtime) && link.status === 'live';
    try {
      const outcome = await this._operations.reconcileTarget(
        controller,
        syncTargetFromLink(link),
        { direction: 'push' },
        shouldContinue,
      );
      if (outcome.aborted || !shouldContinue()) {
        return;
      }
      if ((outcome.pushFailures?.length ?? 0) > 0) {
        this.schedulePushRetry(controller);
      }
    } catch (error: unknown) {
      if (!shouldContinue()) {
        return;
      }
      this._operations.reportError(
        `SyncLinkRecoveryCoordinator: Durable push pass failed for ${link.tenantDid} -> ${link.remoteEndpoint}`,
        error,
      );
      this.schedulePushRetry(controller);
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

  private replaceLaterReconcileTimer(controller: SyncLinkController, dueAt: number): boolean {
    if (controller.reconcileTimer === undefined) {
      return true;
    }
    if (controller.reconcileTimerDueAt !== undefined && controller.reconcileTimerDueAt <= dueAt) {
      return false;
    }
    controller.cancelReconcileTimer();
    return true;
  }


  private isStale(controller: SyncLinkController, runtime: SyncRuntimeHandle): boolean {
    return runtime.disposed || !controller.isActive;
  }

  /**
   * Whether an in-flight repair lost its mandate. Pausing is deliberately
   * prompt and mailbox-free, so an external pause lands while a repair is
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
    return this.isRepairCancelled(controller, runtime) || controller.isPassRequested('repair');
  }

  private static targetFromController(controller: SyncLinkController): SyncLinkRecoveryTarget {
    return {
      ...syncTargetFromLink(controller.link),
      linkKey: controller.linkKey,
    };
  }
}
