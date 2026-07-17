import type { SyncDurableFeedReconcileResult } from './sync-durable-feed-reconciler.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { PushFailure, SyncDirection } from './types/sync.js';

export type SyncRunOptions = {
  verifyConvergence?: boolean;
};

export interface SyncRunCoordinatorOperations {
  clearFeedConvergenceFailure(target: SyncTarget): Promise<void>;
  getTargets(): Promise<SyncTarget[]>;
  handleVerifiedFeedDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
  ): Promise<void>;
  onReconcileApplied(target: SyncTarget, messageCids: string[]): void;
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
  dwnUrl: string;
  succeeded: boolean;
};

type SyncTargetGroupSummary = {
  failedUrls: string[];
  groupsFailed: number;
  groupsSucceeded: number;
};

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
    const targets = await this._operations.getTargets();
    const summary = await this.runTargetGroups(targets, direction, options);
    this.updateConnectivity(summary);
    SyncRunCoordinator.assertTargetGroupsSucceeded(summary);
  }

  private async runTargetGroups(
    targets: SyncTarget[],
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<SyncTargetGroupSummary> {
    const byUrl = SyncRunCoordinator.groupTargetsByDwnUrl(targets);
    const results = await Promise.allSettled([...byUrl.entries()].map(([dwnUrl, groupTargets]) =>
      this.runTargetGroupWithUrl(dwnUrl, groupTargets, direction, options)
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
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<SyncTargetGroupRunResult> {
    return {
      dwnUrl,
      succeeded: await this.runTargetGroup(dwnUrl, targets, direction, options),
    };
  }

  private async runTargetGroup(
    dwnUrl: string,
    targets: SyncTarget[],
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<boolean> {
    for (const target of targets) {
      try {
        await this.runTarget(target, direction, options);
      } catch (error: unknown) {
        this._operations.reportError(
          `SyncRunCoordinator: Error syncing ${target.did} with ${dwnUrl}`,
          error,
        );
        return false;
      }
    }
    return true;
  }

  private async runTarget(
    target: SyncTarget,
    direction: SyncDirection | undefined,
    options: SyncRunOptions | undefined,
  ): Promise<void> {
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
      return;
    }
    if (result.converged === false) {
      await this._operations.handleVerifiedFeedDivergence(target, result);
    } else if (result.converged === true) {
      await this._operations.clearFeedConvergenceFailure(target);
    }
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
