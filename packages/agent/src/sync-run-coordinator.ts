import type { SyncDurableFeedReconcileResult } from './sync-durable-feed-reconciler.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { PushFailure, SyncDirection, SyncRunOptions } from './types/sync.js';

export type { SyncRunOptions } from './types/sync.js';

export interface SyncRunCoordinatorOperations {
  clearFeedConvergenceFailure(target: SyncTarget): Promise<void>;
  getTargets(): Promise<SyncTarget[]>;
  handleVerifiedFeedDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
  ): Promise<void>;
  onReconcileApplied(target: SyncTarget, messageCids: string[]): void;
  probeFeedConvergence(target: SyncTarget): Promise<SyncDurableFeedReconcileResult>;
  reconcileTarget(
    target: SyncTarget,
    direction: SyncDirection | undefined,
    verifyConvergence: boolean | undefined,
  ): Promise<SyncDurableFeedReconcileResult>;
  recordConnectivityFailure(): void;
  recordConnectivitySuccess(): void;
  recordPushFailures(target: SyncTarget, failures: PushFailure[]): Promise<number>;
  reportError(message: string, error: unknown): void;
}

export type SyncRunCoordinatorParams = {
  operations: SyncRunCoordinatorOperations;
};

type SyncTargetGroupRunResult = {
  attempted: boolean;
  dwnUrl: string;
  succeeded: boolean;
};

type SyncTargetGroupSummary = {
  failedUrls: string[];
  groupsFailed: number;
  groupsSucceeded: number;
};

type SyncTargetRunner = (target: SyncTarget) => Promise<boolean>;

/**
 * Coordinates an ordinary one-shot sync cycle without depending on a storage
 * backend. Target planning, reconciliation, persistence policy, observability,
 * and connectivity transitions are supplied as operations.
 */
export class SyncRunCoordinator {
  private readonly _operations: SyncRunCoordinatorOperations;

  public constructor({ operations }: SyncRunCoordinatorParams) {
    this._operations = operations;
  }

  /** Run all current targets, concurrently by endpoint and sequentially within each endpoint. */
  public async run(direction?: SyncDirection, options?: SyncRunOptions): Promise<void> {
    let targets = await this._operations.getTargets();
    if (options?.did !== undefined) {
      // Scoped run: reconcile only the requested identity's targets. The
      // engine validates registration before dispatching, so an empty list
      // here means the identity has no resolvable endpoints — a no-op run.
      targets = targets.filter(target => target.did === options.did);
    }
    const summary = await this.runTargetGroups(
      targets,
      (target): Promise<boolean> => this.runTarget(target, direction, options),
    );
    this.updateConnectivity(summary);
    SyncRunCoordinator.assertTargetGroupsSucceeded(summary);
  }

  /** Probe all current targets and reconcile only feeds whose exact fingerprints differ. */
  public async settle(): Promise<void> {
    const targets = await this._operations.getTargets();
    const summary = await this.runTargetGroups(
      targets,
      (target): Promise<boolean> => this.settleTarget(target),
    );
    this.updateConnectivity(summary);
    SyncRunCoordinator.assertTargetGroupsSucceeded(summary);
  }

  private async runTargetGroups(
    targets: SyncTarget[],
    runTarget: SyncTargetRunner,
  ): Promise<SyncTargetGroupSummary> {
    const byUrl = SyncRunCoordinator.groupTargetsByDwnUrl(targets);
    const results = await Promise.allSettled([...byUrl.entries()].map(([dwnUrl, groupTargets]) =>
      this.runTargetGroupWithUrl(dwnUrl, groupTargets, runTarget)
    ));

    return SyncRunCoordinator.summarizeTargetGroupResults(results);
  }

  private static groupTargetsByDwnUrl(targets: SyncTarget[]): Map<string, SyncTarget[]> {
    const byUrl = new Map<string, SyncTarget[]>();
    for (const target of targets) {
      const group = byUrl.get(target.dwnUrl) ?? [];
      group.push(target);
      byUrl.set(target.dwnUrl, group);
    }
    return byUrl;
  }

  private async runTargetGroupWithUrl(
    dwnUrl: string,
    targets: SyncTarget[],
    runTarget: SyncTargetRunner,
  ): Promise<SyncTargetGroupRunResult> {
    return { dwnUrl, ...await this.runTargetGroup(dwnUrl, targets, runTarget) };
  }

  private async runTargetGroup(
    dwnUrl: string,
    targets: SyncTarget[],
    runTarget: SyncTargetRunner,
  ): Promise<{ attempted: boolean; succeeded: boolean }> {
    let attempted = false;
    for (const target of targets) {
      try {
        attempted = await runTarget(target) || attempted;
      } catch (error: unknown) {
        this._operations.reportError(
          `SyncRunCoordinator: Error syncing ${target.did} with ${dwnUrl}`,
          error,
        );
        return { attempted: true, succeeded: false };
      }
    }
    return { attempted, succeeded: true };
  }

  private async runTarget(
    target: SyncTarget,
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<boolean> {
    const result = await this._operations.reconcileTarget(
      target,
      direction,
      options?.verifyConvergence,
    );

    if (result.admittedCids !== undefined && result.admittedCids.length > 0) {
      this._operations.onReconcileApplied(target, result.admittedCids);
    }

    if (result.pushFailures !== undefined && result.pushFailures.length > 0) {
      const retryableFailures = await this._operations.recordPushFailures(target, result.pushFailures);
      if (retryableFailures > 0) {
        throw new Error(
          `SyncRunCoordinator: reconciliation push failed for ${retryableFailures} retryable message(s).`,
        );
      }
    }

    if (options?.verifyConvergence !== true) {
      return result.aborted !== true && result.paused !== true;
    }
    if (result.converged === false) {
      await this._operations.handleVerifiedFeedDivergence(target, result);
    } else if (result.converged === true) {
      await this._operations.clearFeedConvergenceFailure(target);
    }
    return result.aborted !== true && result.paused !== true;
  }

  private async settleTarget(target: SyncTarget): Promise<boolean> {
    const probe = await this._operations.probeFeedConvergence(target);
    if (probe.aborted === true || probe.paused === true) {
      return false;
    }
    if (probe.converged === true) {
      await this._operations.clearFeedConvergenceFailure(target);
      return true;
    }

    return this.runTarget(target, undefined, { verifyConvergence: true });
  }

  private static summarizeTargetGroupResults(
    results: PromiseSettledResult<SyncTargetGroupRunResult>[],
  ): SyncTargetGroupSummary {
    const summary: SyncTargetGroupSummary = {
      failedUrls      : [],
      groupsFailed    : 0,
      groupsSucceeded : 0,
    };
    for (const result of results) {
      SyncRunCoordinator.countTargetGroupResult(summary, result);
    }
    return summary;
  }

  private static countTargetGroupResult(
    summary: SyncTargetGroupSummary,
    result: PromiseSettledResult<SyncTargetGroupRunResult>,
  ): void {
    if (result.status === 'rejected') {
      summary.groupsFailed++;
      return;
    }
    if (!result.value.attempted) {
      return;
    }
    if (result.value.succeeded) {
      summary.groupsSucceeded++;
      return;
    }
    summary.groupsFailed++;
    summary.failedUrls.push(result.value.dwnUrl);
  }

  private updateConnectivity(summary: SyncTargetGroupSummary): void {
    // Partial endpoint reachability remains online. An empty plan leaves the
    // previous connectivity state untouched.
    if (summary.groupsSucceeded > 0) {
      this._operations.recordConnectivitySuccess();
      return;
    }
    if (summary.groupsFailed > 0) {
      this._operations.recordConnectivityFailure();
    }
  }

  private static assertTargetGroupsSucceeded(summary: SyncTargetGroupSummary): void {
    if (summary.groupsFailed === 0) {
      return;
    }
    throw new Error(
      `SyncRunCoordinator: Sync operation failed for ${summary.groupsFailed} remote endpoint(s)`
      + (summary.failedUrls.length > 0 ? `: ${summary.failedUrls.join(', ')}` : '.'),
    );
  }
}
