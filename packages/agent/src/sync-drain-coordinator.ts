import type { SyncIdentityStore } from './sync-identity-store.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type {
  PushFailure,
  ReplicationLinkState,
  SyncDrainOptions,
  SyncDrainResult,
  SyncDrainTargetResult,
  SyncIdentityOptions,
  SyncScope,
} from './types/sync.js';
import type {
  SyncDurableFeedReconcileOptions,
  SyncDurableFeedReconcileResult,
} from './sync-durable-feed-reconciler.js';

import { syncScopeFromProtocols } from './types/sync.js';

export type SyncDrainStopReason = 'cancelled' | 'topology-changed';

export type SyncDrainPlan = {
  failures: SyncDrainTargetResult[];
  targets: SyncTarget[];
};

export interface SyncDrainCoordinatorOperations {
  buildTargetsForEndpoint(
    did: string,
    remoteEndpoint: string,
    options: SyncIdentityOptions,
  ): Promise<SyncTarget[]>;
  clearFeedConvergenceFailure(target: SyncTarget): Promise<void>;
  getLink(target: SyncTarget): Promise<ReplicationLinkState>;
  getQuotaBlockCount(target: SyncTarget): Promise<number>;
  getTopologyGeneration(): number;
  handleVerifiedFeedDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
  ): Promise<boolean>;
  onReconcileApplied(target: SyncTarget, messageCids: string[]): void;
  prepareLiveTarget(target: SyncTarget): Promise<void>;
  reconcileTarget(
    target: SyncTarget,
    options: SyncDurableFeedReconcileOptions,
    shouldContinue: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult>;
  recordConnectivityFailure(): void;
  recordConnectivitySuccess(): void;
  recordPushFailures(target: SyncTarget, failures: PushFailure[]): Promise<void>;
  registerEndpoint(remoteEndpoint: string): Promise<void>;
  verifyConvergence(
    target: SyncTarget,
    shouldContinue: () => boolean,
  ): Promise<SyncDurableFeedReconcileResult>;
}

export type SyncDrainCoordinatorParams = {
  identityStore: SyncIdentityStore;
  operations: SyncDrainCoordinatorOperations;
};

/**
 * Coordinates a one-shot durable handoff without depending on a persistence
 * backend. Identity storage, target resolution, transport, convergence policy,
 * live-link preparation, and connectivity updates are supplied as operations.
 */
export class SyncDrainCoordinator {
  private readonly _identityStore: SyncIdentityStore;
  private readonly _operations: SyncDrainCoordinatorOperations;

  public constructor({ identityStore, operations }: SyncDrainCoordinatorParams) {
    this._identityStore = identityStore;
    this._operations = operations;
  }

  /** Drain every registered sync target to one normalized remote endpoint. */
  public async drain(remoteEndpoint: string, options: SyncDrainOptions = {}): Promise<SyncDrainResult> {
    await this._operations.registerEndpoint(remoteEndpoint);
    const topologyGeneration = this._operations.getTopologyGeneration();
    const getStopReason = (): SyncDrainStopReason | undefined =>
      this.getStopReason(options, topologyGeneration);

    const plan = await this.buildPlan(remoteEndpoint);
    await this.prepareLiveTargets(plan.targets, getStopReason);
    const targets = [...plan.failures];

    for (const target of plan.targets) {
      targets.push(await this.drainTarget(target, getStopReason));
    }

    const stopReason = getStopReason();
    const cancelled = stopReason === 'cancelled' || targets.some((target): boolean => target.cancelled);
    const topologyChanged = stopReason === 'topology-changed';
    const interrupted = stopReason !== undefined;
    const completed = targets.length > 0 &&
      !cancelled &&
      !topologyChanged &&
      targets.every((target): boolean => target.completed);
    const error = SyncDrainCoordinator.resultError(targets, stopReason);
    this.updateConnectivity(targets, interrupted);

    return {
      endpoint: remoteEndpoint,
      completed,
      cancelled,
      topologyChanged,
      targets,
      ...(error !== undefined ? { error } : {}),
    };
  }

  private async buildPlan(remoteEndpoint: string): Promise<SyncDrainPlan> {
    const plan: SyncDrainPlan = {
      failures : [],
      targets  : [],
    };

    for await (const entry of this._identityStore.entries()) {
      if (entry.status === 'corrupt') {
        plan.failures.push({
          tenantDid : entry.did,
          remoteEndpoint,
          completed : false,
          cancelled : false,
          converged : false,
          error     : `corrupt sync options: ${SyncDrainCoordinator.errorMessage(entry.error)}`,
        });
        continue;
      }

      try {
        plan.targets.push(...await this._operations.buildTargetsForEndpoint(entry.did, remoteEndpoint, entry.options));
      } catch (error: unknown) {
        plan.failures.push({
          tenantDid : entry.did,
          remoteEndpoint,
          scope     : SyncDrainCoordinator.scopeForFailure(entry.options),
          completed : false,
          cancelled : false,
          converged : false,
          error     : SyncDrainCoordinator.errorMessage(error),
        });
      }
    }

    return plan;
  }

  private async prepareLiveTargets(
    targets: SyncTarget[],
    getStopReason: () => SyncDrainStopReason | undefined,
  ): Promise<void> {
    for (const target of targets) {
      if (getStopReason() !== undefined) {
        return;
      }
      await this._operations.prepareLiveTarget(target);
    }
  }

  private async drainTarget(
    target: SyncTarget,
    getStopReason: () => SyncDrainStopReason | undefined,
  ): Promise<SyncDrainTargetResult> {
    const stopReasonAtStart = getStopReason();
    if (stopReasonAtStart !== undefined) {
      return SyncDrainCoordinator.stoppedTarget(target, stopReasonAtStart);
    }

    try {
      return await this.performTargetDrain(target, getStopReason);
    } catch (error: unknown) {
      const stopReason = getStopReason();
      if (stopReason !== undefined) {
        return SyncDrainCoordinator.stoppedTarget(target, stopReason);
      }

      return {
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        scope          : target.scope,
        completed      : false,
        cancelled      : false,
        converged      : false,
        error          : SyncDrainCoordinator.errorMessage(error),
      };
    }
  }

  private async performTargetDrain(
    target: SyncTarget,
    getStopReason: () => SyncDrainStopReason | undefined,
  ): Promise<SyncDrainTargetResult> {
    const shouldContinue = (): boolean => getStopReason() === undefined;
    const result = await this._operations.reconcileTarget(
      target,
      { forceQuotaProbe: true, verifyConvergence: true },
      shouldContinue,
    );
    if (result.admittedCids !== undefined && result.admittedCids.length > 0) {
      this._operations.onReconcileApplied(target, result.admittedCids);
    }

    const pushFailures = result.pushFailures ?? [];
    if (pushFailures.length > 0) {
      await this._operations.recordPushFailures(target, pushFailures);
    }

    const link = await this._operations.getLink(target);
    const feedHeadChanged = await this.verifyStability(target, result, link, pushFailures, getStopReason);
    const divergenceExplained = await this.resolveDivergence(target, result, feedHeadChanged, getStopReason);
    const stopReason = getStopReason();
    const quotaBlocked = await this._operations.getQuotaBlockCount(target) > 0;
    if (divergenceExplained && !quotaBlocked) {
      // A resolved omission is logical convergence: intentionally absent
      // history will not be probed again even though raw fingerprints differ.
      result.converged = true;
    }
    const paused = link.status === 'paused';
    const error = SyncDrainCoordinator.targetError(result, pushFailures, paused, feedHeadChanged, stopReason);

    return {
      tenantDid         : target.did,
      remoteEndpoint    : target.dwnUrl,
      scope             : target.scope,
      completed         : error === undefined,
      cancelled         : stopReason === 'cancelled',
      converged         : SyncDrainCoordinator.targetConverged(result, paused, feedHeadChanged, stopReason),
      ...(quotaBlocked ? { quotaBlocked: true } : {}),
      pushCheckpoint    : link.push.contiguousAppliedToken,
      localFingerprint  : result.localFingerprint,
      remoteFingerprint : result.remoteFingerprint,
      ...(error !== undefined ? { error } : {}),
    };
  }

  /** Recheck a converged feed once so a moving head cannot produce a successful drain. */
  private async verifyStability(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
    link: ReplicationLinkState,
    pushFailures: PushFailure[],
    getStopReason: () => SyncDrainStopReason | undefined,
  ): Promise<boolean> {
    if (
      link.status === 'paused' ||
      result.converged !== true ||
      pushFailures.length !== 0 ||
      getStopReason() !== undefined
    ) {
      return false;
    }

    const stability = await this._operations.verifyConvergence(
      target,
      (): boolean => getStopReason() === undefined,
    );
    const feedHeadChanged = stability.converged !== true ||
      stability.localFingerprint !== result.localFingerprint ||
      stability.remoteFingerprint !== result.remoteFingerprint;
    result.aborted ||= stability.aborted;
    result.converged = !feedHeadChanged;
    result.localFingerprint = stability.localFingerprint ?? result.localFingerprint;
    result.remoteFingerprint = stability.remoteFingerprint ?? result.remoteFingerprint;
    return feedHeadChanged;
  }

  /** Record unexplained divergence, clear recovered state, or accept durable omissions. */
  private async resolveDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
    feedHeadChanged: boolean,
    getStopReason: () => SyncDrainStopReason | undefined,
  ): Promise<boolean> {
    if (getStopReason() !== undefined) {
      return false;
    }
    if (result.converged === false && !feedHeadChanged) {
      return this._operations.handleVerifiedFeedDivergence(target, result);
    }
    if (result.converged === true) {
      await this._operations.clearFeedConvergenceFailure(target);
    }
    return false;
  }

  private getStopReason(
    options: SyncDrainOptions,
    topologyGeneration: number,
  ): SyncDrainStopReason | undefined {
    if (options.signal?.aborted === true) {
      return 'cancelled';
    }
    if (this._operations.getTopologyGeneration() !== topologyGeneration) {
      return 'topology-changed';
    }
  }

  private updateConnectivity(targets: SyncDrainTargetResult[], interrupted: boolean): void {
    if (targets.length === 0) {
      return;
    }
    if (targets.some((target): boolean => target.completed || target.quotaBlocked === true)) {
      this._operations.recordConnectivitySuccess();
      return;
    }
    // An interrupted drain — caller cancellation or a topology change — says
    // nothing about remote reachability: it must not mark the engine
    // offline. Only genuine target failures may.
    if (interrupted) {
      return;
    }
    this._operations.recordConnectivityFailure();
  }

  private static targetError(
    result: SyncDurableFeedReconcileResult,
    pushFailures: PushFailure[],
    paused: boolean,
    feedHeadChanged: boolean,
    stopReason: SyncDrainStopReason | undefined,
  ): string | undefined {
    if (stopReason === 'cancelled') {
      return 'drain aborted';
    }
    if (stopReason === 'topology-changed') {
      return 'sync registrations changed during drain; retry required';
    }
    if (paused) {
      return 'replication link is paused';
    }
    if (feedHeadChanged) {
      return 'feed head changed during drain; retry required';
    }
    if (result.aborted === true) {
      return 'drain aborted';
    }
    if (pushFailures.length > 0) {
      return `drain push failed for ${pushFailures.length} message(s)`;
    }
    if (result.converged !== true) {
      return 'feed fingerprints did not converge';
    }
  }

  private static targetConverged(
    result: SyncDurableFeedReconcileResult,
    paused: boolean,
    feedHeadChanged: boolean,
    stopReason: SyncDrainStopReason | undefined,
  ): boolean {
    return result.converged === true && !paused && !feedHeadChanged && stopReason === undefined;
  }

  private static stoppedTarget(target: SyncTarget, stopReason: SyncDrainStopReason): SyncDrainTargetResult {
    return {
      tenantDid      : target.did,
      remoteEndpoint : target.dwnUrl,
      scope          : target.scope,
      completed      : false,
      cancelled      : stopReason === 'cancelled',
      converged      : false,
      error          : stopReason === 'cancelled'
        ? 'drain aborted'
        : 'sync registrations changed during drain; retry required',
    };
  }

  private static resultError(
    targets: SyncDrainTargetResult[],
    stopReason: SyncDrainStopReason | undefined,
  ): string | undefined {
    if (stopReason === 'cancelled') {
      return 'drain aborted';
    }
    if (stopReason === 'topology-changed') {
      return 'sync registrations changed during drain; retry required';
    }
    if (targets.length === 0) {
      return 'drain plan contained no registered sync targets';
    }
  }

  private static scopeForFailure(options: SyncIdentityOptions): SyncScope | undefined {
    try {
      return syncScopeFromProtocols(options.protocols);
    } catch {
      return;
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
