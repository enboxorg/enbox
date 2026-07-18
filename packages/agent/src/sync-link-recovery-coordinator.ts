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
  handlePushFailures(linkKey: string, link: ReplicationLinkState, failures: PushFailure[]): Promise<void>;
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
    linkKey: string,
    link: ReplicationLinkState,
    options?: SyncRepairTransitionOptions,
  ): Promise<void> {
    if (link.status === 'paused') {
      return;
    }

    const controller = this.matchingController(linkKey, link);
    if (controller?.isActive !== true) {
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

  /** Park a link and discard every transient runtime owned by its controller. */
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
    const scope = this._operations.getRuntimeScope();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(link.tenantDid);
    const timer = setTimeout((): void => {
      if (!controller.consumeRepairRetryTimer(timer)) {
        return;
      }
      if (this.isStale(controller, scope) || link.status !== 'repairing') {
        return;
      }
      this.startSupervisedRepair(controller, runIdentityTask);
    }, delayMs);
    controller.setRepairRetryTimer(timer);
  }

  /** Deduplicate repair callers for one link lifetime. */
  public repair(controller: SyncLinkController): Promise<void> {
    if (!controller.isActive) {
      return Promise.resolve();
    }

    const existing = controller.repairInFlight;
    if (existing !== undefined) {
      return existing;
    }

    const promise = this.runRepair(controller).finally(() => {
      controller.clearRepairInFlight(promise);
      if (controller.isActive && controller.link.status === 'live') {
        this.scheduleLinkReconcile(
          controller.linkKey,
          controller.link,
          'post-repair-gap',
          this._postRepairReconcileDelayMs,
        );
      }
    });
    controller.setRepairInFlight(promise);
    return promise;
  }

  /** Emit and coalesce a named durable-reconciliation request for a live link. */
  public scheduleLinkReconcile(
    linkKey: string,
    link: ReplicationLinkState,
    reason: string,
    delayMs?: number,
  ): void {
    if (link.status !== 'live' || this.matchingController(linkKey, link)?.isActive !== true) {
      return;
    }
    if (!this.scheduleReconcile(linkKey, delayMs)) {
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
  public scheduleReconcile(linkKey: string, delayMs = this._reconcileDelayMs): boolean {
    const controller = this._operations.getController(linkKey);
    if (controller === undefined || controller.repairInFlight !== undefined) {
      return false;
    }

    const normalizedDelay = Math.max(0, delayMs);
    const dueAt = Date.now() + normalizedDelay;
    if (!this.replaceLaterReconcileTimer(controller, dueAt)) {
      return false;
    }

    const scope = this._operations.getRuntimeScope();
    const runIdentityTask = this._operations.captureIdentityTaskRunner(controller.link.tenantDid);
    const timer = setTimeout((): void => {
      if (!controller.consumeReconcileTimer(timer) || this.isStale(controller, scope)) {
        return;
      }
      void runIdentityTask(async (): Promise<void> => {
        try {
          await this.reconcile(controller);
        } catch {
          // runReconcile reports failures before rejecting.
        }
      });
    }, normalizedDelay);
    controller.setReconcileTimer(timer, dueAt);
    return true;
  }

  /** Deduplicate durable reconciliation callers for one link lifetime. */
  public reconcile(controller: SyncLinkController): Promise<void> {
    const existing = controller.reconcileInFlight;
    if (existing !== undefined) {
      return existing;
    }

    const promise = this.runReconcile(controller).finally(() => {
      controller.clearReconcileInFlight(promise);
    });
    controller.setReconcileInFlight(promise);
    return promise;
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

  private async runRepair(controller: SyncLinkController): Promise<void> {
    const { link } = controller;
    const scope = this._operations.getRuntimeScope();
    const attempts = controller.incrementRepairAttempts();
    this._operations.emitEvent({
      type           : 'repair:started',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...eventScope(link.scope),
      attempt        : attempts,
    });

    await controller.closeSubscriptions();
    if (this.isStale(controller, scope)) {
      return;
    }
    controller.resetPullRuntime();

    try {
      const target = SyncLinkRecoveryCoordinator.targetFromController(controller);
      const outcome = await this._operations.reconcileTarget(
        target,
        undefined,
        () => !this.isStale(controller, scope),
      );
      if (outcome.aborted || this.isStale(controller, scope)) {
        return;
      }
      this.emitApplied(link, outcome.admittedCids);

      const resumeToken = controller.repairResumeToken ?? link.pull.contiguousAppliedToken;
      await this._operations.resetPullCheckpoint(link, resumeToken);
      if (this.isStale(controller, scope)) {
        return;
      }
      if (!await this.reopenSubscriptions(target, controller, scope)) {
        return;
      }

      await this.completeRepair(controller, scope, outcome.pushFailures ?? []);
    } catch (error: unknown) {
      await this.handleRepairFailure(controller, scope, attempts, error);
    }
  }

  private async reopenSubscriptions(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    scope: SyncRuntimeHandle,
  ): Promise<boolean> {
    const pullOpened = await this.openRepairPullSubscription(target, controller, scope);
    if (!pullOpened) {
      return false;
    }
    if (this.isStale(controller, scope)) {
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

    if (!this.isStale(controller, scope)) {
      return true;
    }
    await controller.closeSubscriptions();
    return false;
  }

  private async openRepairPullSubscription(
    target: SyncLinkRecoveryTarget,
    controller: SyncLinkController,
    scope: SyncRuntimeHandle,
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
      if (this.isStale(controller, scope)) {
        return false;
      }
      return this._operations.openPullSubscription(target, controller);
    }
  }

  private async completeRepair(
    controller: SyncLinkController,
    scope: SyncRuntimeHandle,
    pushFailures: PushFailure[],
  ): Promise<void> {
    const { link, linkKey } = controller;
    controller.clearRepairProgress();
    const previousConnectivity = link.connectivity;
    link.connectivity = 'online';
    await this._operations.setStatus(link, 'live');
    if (this.isStale(controller, scope)) {
      return;
    }

    if (pushFailures.length > 0) {
      await this._operations.handlePushFailures(linkKey, link, pushFailures);
      if (this.isStale(controller, scope)) {
        return;
      }
    }

    const completedEventScope = eventScope(link.scope);
    this._operations.emitEvent({
      type           : 'repair:completed',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...completedEventScope,
    });
    if (previousConnectivity !== 'online') {
      this._operations.emitEvent({
        type           : 'link:connectivity-change',
        tenantDid      : link.tenantDid,
        remoteEndpoint : link.remoteEndpoint,
        ...scope,
        from           : previousConnectivity,
        to             : 'online',
      });
    }
    this._operations.emitEvent({
      type           : 'link:status-change',
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      ...scope,
      from           : 'repairing',
      to             : 'live',
    });
  }

  private async handleRepairFailure(
    controller: SyncLinkController,
    scope: SyncRuntimeHandle,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    if (this.isStale(controller, scope)) {
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

  private async runReconcile(controller: SyncLinkController): Promise<void> {
    const { link, linkKey } = controller;
    if (!controller.isActive || link.status !== 'live' || controller.repairInFlight !== undefined) {
      return;
    }

    const scope = this._operations.getRuntimeScope();
    const shouldContinue = (): boolean =>
      !this.isStale(controller, scope) && link.status === 'live';
    const target = syncTargetFromLink(link);
    try {
      const outcome = await this._operations.reconcileTarget(
        target,
        { verifyConvergence: true },
        shouldContinue,
      );
      if (outcome.aborted || this.isStale(controller, scope)) {
        return;
      }
      this.emitApplied(link, outcome.admittedCids);

      const pushFailures = outcome.pushFailures ?? [];
      if (pushFailures.length > 0) {
        await this._operations.handlePushFailures(linkKey, link, pushFailures);
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
      } else if (!this.isStale(controller, scope)) {
        await this._operations.handleDivergence(target, outcome, { link, linkKey });
      }
    } catch (error: unknown) {
      if (this.isStale(controller, scope)) {
        return;
      }
      this._operations.reportError(
        `SyncLinkRecoveryCoordinator: Reconciliation failed for ${link.tenantDid} -> ${link.remoteEndpoint}`,
        error,
      );
      this.scheduleReconcile(linkKey, this._reconcileRetryDelayMs);
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

  private matchingController(
    linkKey: string,
    link: ReplicationLinkState,
  ): SyncLinkController | undefined {
    const controller = this._operations.getController(linkKey);
    return controller?.link === link ? controller : undefined;
  }

  private isStale(controller: SyncLinkController, scope: SyncRuntimeHandle): boolean {
    return scope.disposed || !controller.isActive;
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
