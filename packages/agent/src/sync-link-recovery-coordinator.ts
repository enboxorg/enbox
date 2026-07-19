import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncFeedConvergenceLinkContext } from './sync-feed-convergence-manager.js';
import type { SyncIdentityTaskRunner } from './sync-lifecycle-coordinator.js';
import type { SyncLinkController } from './sync-link-controller.js';
import type { SyncRuntimeHandle } from './sync-runtime.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type {
  NonEmptyStringArray,
  PushFailure,
  ReplicationLinkState,
  SyncEvent,
  SyncEventScope,
  SyncScope,
} from './types/sync.js';
import type {
  SyncDurableFeedReconcileOptions,
  SyncDurableFeedReconcileResult,
} from './sync-durable-feed-reconciler.js';

import { protocolsForSyncScope } from './types/sync.js';
import { syncTargetFromLink } from './sync-target-resolver.js';
import { isSyncProgressGapError, isTerminalSyncAuthorizationFailure, syncErrorMessage } from './sync-runtime-errors.js';

export type SyncLinkRecoveryTarget = SyncTarget & { linkKey: string };

export interface SyncLinkRecoveryCoordinatorOperations {
  captureIdentityTaskRunner(tenantDid: string): SyncIdentityTaskRunner;
  clearConvergence(linkKey: string): void;
  emitEvent(event: SyncEvent): void;
  getController(linkKey: string): SyncLinkController | undefined;
  getRuntimeScope(): SyncRuntimeHandle;
  handleDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
    context: SyncFeedConvergenceLinkContext,
  ): Promise<unknown>;
  handlePushFailures(controller: SyncLinkController, failures: PushFailure[]): Promise<void>;
  openPullSubscription(target: SyncLinkRecoveryTarget, controller: SyncLinkController): Promise<boolean>;
  openPushSubscription(target: SyncLinkRecoveryTarget, controller: SyncLinkController): Promise<boolean>;
  reconcileTarget(
    target: SyncTarget,
    options?: SyncDurableFeedReconcileOptions,
    shouldContinue?: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult>;
  reportError(message: string, error: unknown): void;
  resetPullCheckpoint(link: ReplicationLinkState, resumeToken?: ProgressToken): Promise<void>;
  setStatus(link: ReplicationLinkState, status: ReplicationLinkState['status']): Promise<void>;
  warn(message: string): void;
}

export type SyncLinkRecoveryCoordinatorParams = {
  maxRepairAttempts?: number;
  operations: SyncLinkRecoveryCoordinatorOperations;
  postRepairReconcileDelayMs?: number;
  reconcileDelayMs?: number;
  reconcileRetryDelayMs?: number;
  repairBackoffMs?: readonly number[];
};

export type SyncRepairTransitionOptions = {
  resumeToken?: ProgressToken;
};

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
const DEFAULT_POST_REPAIR_RECONCILE_DELAY_MS = 500;
const DEFAULT_RECONCILE_DELAY_MS = 1500;
const DEFAULT_RECONCILE_RETRY_DELAY_MS = 5000;
const DEFAULT_REPAIR_BACKOFF_MS = [1000, 3000, 10_000] as const;

/**
 * Coordinates per-link repair and durable reconciliation without depending on
 * Level storage. A backend supplies checkpoint/status persistence, durable
 * feed reconciliation, transport creation, and lifecycle supervision.
 */
export class SyncLinkRecoveryCoordinator {
  private readonly _maxRepairAttempts: number;
  private readonly _operations: SyncLinkRecoveryCoordinatorOperations;
  private readonly _postRepairReconcileDelayMs: number;
  private readonly _reconcileDelayMs: number;
  private readonly _reconcileRetryDelayMs: number;
  private readonly _repairBackoffMs: readonly number[];

  public constructor({
    maxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS,
    operations,
    postRepairReconcileDelayMs = DEFAULT_POST_REPAIR_RECONCILE_DELAY_MS,
    reconcileDelayMs = DEFAULT_RECONCILE_DELAY_MS,
    reconcileRetryDelayMs = DEFAULT_RECONCILE_RETRY_DELAY_MS,
    repairBackoffMs = DEFAULT_REPAIR_BACKOFF_MS,
  }: SyncLinkRecoveryCoordinatorParams) {
    this._maxRepairAttempts = maxRepairAttempts;
    this._operations = operations;
    this._postRepairReconcileDelayMs = postRepairReconcileDelayMs;
    this._reconcileDelayMs = reconcileDelayMs;
    this._reconcileRetryDelayMs = reconcileRetryDelayMs;
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

    await this.setOfflineStatus(link, 'repairing');
    if (!controller.isActive) {
      return;
    }
    if (options?.resumeToken !== undefined) {
      controller.setRepairResumeToken(options.resumeToken);
    }
    controller.clearPullInflight();

    const runIdentityTask = this._operations.captureIdentityTaskRunner(link.tenantDid);
    this.startSupervisedRepair(controller, runIdentityTask);
  }

  /**
   * Park a link and discard every transient runtime owned by its controller.
   * Never enters the mailbox — poll-mode links have no controller, repair
   * failure paths invoke this from inside a mailbox operation, and pausing
   * must take effect promptly. Instead of serializing, the paused status is
   * a cancellation fence: an in-flight repair observes it at every
   * checkpoint and abandons the link rather than overwriting the pause.
   */
  public async transitionToPaused(linkKey: string, link: ReplicationLinkState): Promise<void> {
    if (link.status === 'paused') {
      return;
    }

    const controller = this._operations.getController(linkKey);
    if (controller !== undefined && controller.link !== link) {
      return;
    }

    await this.setOfflineStatus(link, 'paused');
    if (controller?.isActive !== true) {
      return;
    }

    await controller.closeSubscriptions();
    controller.clearPullInflight();
    controller.cancelReconcileTimer();
    controller.clearPushRuntime();
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
    const runtimeScope = this._operations.getRuntimeScope();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(link.tenantDid);
    const timer = setTimeout((): void => {
      if (!controller.consumeRepairRetryTimer(timer)) {
        return;
      }
      if (this.isStale(controller, runtimeScope) || link.status !== 'repairing') {
        return;
      }
      this.startSupervisedRepair(controller, runIdentityTask);
    }, delayMs);
    controller.setRepairRetryTimer(timer);
  }

  /**
   * Coalesce repair callers onto one queued-or-running mailbox repair.
   * The mailbox serializes the repair behind any in-flight push flush or
   * reconciliation for the same link, so repair never tears down
   * subscriptions or pull ordering underneath another link operation.
   */
  public repair(controller: SyncLinkController): Promise<void> {
    if (!controller.isActive) {
      return Promise.resolve();
    }

    controller.requestSharedRun('repair');
    return controller.enqueueShared('repair', async (): Promise<void> => {
      // A repair transition that arrives while a repair is already executing
      // is not a duplicate caller — it carries fresher state, such as a new
      // resume token. One request mark is consumed per pass, so a burst of
      // transitions yields exactly one trailing repair after the current one.
      while (controller.consumeSharedRunRequest('repair')) {
        if (this.repairCancelled(controller, this._operations.getRuntimeScope())) {
          return;
        }
        await this.repairExclusive(controller);
      }

      // A reconcile already queued behind this repair (a timer that expired
      // while the repair held the mailbox) provides the verification pass —
      // arming the post-repair timer too would run a duplicate full pass.
      if (
        controller.isActive &&
        controller.link.status === 'live' &&
        !controller.mailboxBusy('reconcile')
      ) {
        this.scheduleLinkReconcile(
          controller,
          'post-repair-gap',
          this._postRepairReconcileDelayMs,
        );
      }
    });
  }

  /** Emit and coalesce a named durable-reconciliation request for a live link. */
  public scheduleLinkReconcile(
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

    const runtimeScope = this._operations.getRuntimeScope();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(controller.link.tenantDid);
    const timer = setTimeout((): void => {
      if (!controller.consumeReconcileTimer(timer) || this.isStale(controller, runtimeScope)) {
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
   * Coalesce reconciliation callers onto the shared mailbox lane. Callers
   * arriving before the pass takes its remote snapshot join it; a signal
   * arriving after the snapshot is news that pass cannot have seen, so it
   * runs as one trailing pass instead of being silently absorbed.
   */
  public reconcile(controller: SyncLinkController): Promise<void> {
    controller.requestSharedRun('reconcile');
    return controller.enqueueShared('reconcile', async (): Promise<void> => {
      while (controller.consumeSharedRunRequest('reconcile')) {
        await this.reconcileExclusive(controller);
      }
    });
  }

  private startSupervisedRepair(
    controller: SyncLinkController,
    runIdentityTask: SyncIdentityTaskRunner,
  ): void {
    void runIdentityTask(async (): Promise<void> => {
      try {
        await this.repair(controller);
      } catch {
        this.scheduleRepairRetry(controller);
      }
    });
  }

  /** The repair body. Runs only inside the controller's mailbox. */
  private async repairExclusive(controller: SyncLinkController): Promise<void> {
    const { link } = controller;
    const runtimeScope = this._operations.getRuntimeScope();
    const attempts = controller.incrementRepairAttempts();
    this._operations.emitEvent({
      type           : 'repair:started',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      attempt        : attempts,
    });

    await controller.closeSubscriptions();
    if (this.repairCancelled(controller, runtimeScope)) {
      return;
    }
    controller.resetPullRuntime();

    try {
      const target = SyncLinkRecoveryCoordinator.targetFromController(controller);
      const outcome = await this._operations.reconcileTarget(
        target,
        undefined,
        () => !this.repairCancelled(controller, runtimeScope),
      );
      if (outcome.aborted || this.repairCancelled(controller, runtimeScope)) {
        return;
      }
      this.emitApplied(link, outcome.admittedCids);

      const resumeToken = controller.repairResumeToken ?? link.pull.contiguousAppliedToken;
      await this._operations.resetPullCheckpoint(link, resumeToken);
      if (this.repairCancelled(controller, runtimeScope)) {
        return;
      }
      if (!await this.reopenSubscriptions(target, controller, runtimeScope)) {
        return;
      }
      if (this.repairCancelled(controller, runtimeScope)) {
        return;
      }

      await this.completeRepair(controller, runtimeScope, outcome.pushFailures ?? []);
    } catch (error: unknown) {
      await this.handleRepairFailure(controller, runtimeScope, attempts, error);
    }
  }

  private async reopenSubscriptions(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    runtimeScope: SyncRuntimeHandle,
  ): Promise<boolean> {
    const pullOpened = await this.openRepairPullSubscription(target, controller, runtimeScope);
    if (!pullOpened) {
      return false;
    }
    if (this.repairCancelled(controller, runtimeScope)) {
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

    if (!this.repairCancelled(controller, runtimeScope)) {
      return true;
    }
    await controller.closeSubscriptions();
    return false;
  }

  private async openRepairPullSubscription(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    runtimeScope: SyncRuntimeHandle,
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
      if (this.repairCancelled(controller, runtimeScope)) {
        return false;
      }
      return this._operations.openPullSubscription(target, controller);
    }
  }

  private async completeRepair(
    controller: SyncLinkController,
    runtimeScope: SyncRuntimeHandle,
    pushFailures: PushFailure[],
  ): Promise<void> {
    // A pause can land in the continuation gap after the reopen path's final
    // check — a terminal callback from the freshly reopened subscription is
    // enough. Completion must not revive it.
    if (this.repairCancelled(controller, runtimeScope)) {
      return;
    }

    const { link } = controller;
    controller.clearRepairProgress();
    const previousConnectivity = link.connectivity;
    link.connectivity = 'online';
    await this._operations.setStatus(link, 'live');
    if (this.repairCancelled(controller, runtimeScope)) {
      return;
    }

    if (pushFailures.length > 0) {
      await this._operations.handlePushFailures(controller, pushFailures);
      if (this.repairCancelled(controller, runtimeScope)) {
        return;
      }
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
    runtimeScope: SyncRuntimeHandle,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    // A repair failing after an external pause is the pause tearing down the
    // repair's I/O — stay quiet instead of reporting, emitting repair:failed,
    // or feeding the retry ladder.
    if (this.repairCancelled(controller, runtimeScope)) {
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
    if (!controller.isActive || link.status !== 'live' || controller.mailboxBusy('repair')) {
      return;
    }

    const runtimeScope = this._operations.getRuntimeScope();
    const shouldContinue = (): boolean =>
      !this.isStale(controller, runtimeScope) && link.status === 'live';
    const target = syncTargetFromLink(link);
    try {
      const outcome = await this._operations.reconcileTarget(
        target,
        { verifyConvergence: true },
        shouldContinue,
      );
      if (outcome.aborted || this.isStale(controller, runtimeScope) || link.status !== 'live') {
        return;
      }
      this.emitApplied(link, outcome.admittedCids);

      const pushFailures = outcome.pushFailures ?? [];
      if (pushFailures.length > 0) {
        await this._operations.handlePushFailures(controller, pushFailures);
        return;
      }
      if (outcome.converged) {
        this._operations.clearConvergence(linkKey);
        this._operations.emitEvent({
          type           : 'reconcile:completed',
          tenantDid      : link.tenantDid,
          remoteEndpoint : link.remoteEndpoint,
          ...eventScope(link.scope),
        });
      } else if (!this.isStale(controller, runtimeScope)) {
        await this._operations.handleDivergence(target, outcome, { link, linkKey });
      }
    } catch (error: unknown) {
      // A rejection landing after an external pause (or a repair transition)
      // is the teardown, not a fault: reporting it and rearming the retry
      // timer would revive work the pause just cancelled.
      if (!shouldContinue()) {
        return;
      }
      this._operations.reportError(
        `SyncLinkRecoveryCoordinator: Reconciliation failed for ${link.tenantDid} -> ${link.remoteEndpoint}`,
        error,
      );
      this.scheduleReconcile(controller, this._reconcileRetryDelayMs);
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


  private isStale(controller: SyncLinkController, scope: SyncRuntimeHandle): boolean {
    return scope.disposed || !controller.isActive;
  }

  /**
   * Whether an in-flight repair lost its mandate. Pausing is deliberately
   * prompt and mailbox-free, so an external pause lands while a repair is
   * mid-flight; the repair must observe the paused status at every
   * checkpoint and abandon the link instead of reopening subscriptions and
   * marking it live again — a pause caused by revoked authorization must
   * stay failed-safe until an explicit reconnect.
   */
  private repairCancelled(controller: SyncLinkController, scope: SyncRuntimeHandle): boolean {
    return this.isStale(controller, scope) || controller.link.status === 'paused';
  }

  private static targetFromController(controller: SyncLinkController): SyncLinkRecoveryTarget {
    return {
      ...syncTargetFromLink(controller.link),
      linkKey: controller.linkKey,
    };
  }
}

function eventScope(scope: SyncScope | undefined): SyncEventScope {
  if (scope === undefined) {
    return {};
  }
  const coveredProtocols = protocolsForSyncScope(scope);
  if (coveredProtocols === undefined) {
    return {};
  }

  const protocols = [...coveredProtocols] as NonEmptyStringArray;
  return protocols.length === 1
    ? { protocol: protocols[0], protocols }
    : { protocols };
}
