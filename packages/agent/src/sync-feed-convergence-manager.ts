import type { SyncDurableFeedReconcileResult } from './sync-durable-feed-reconciler.js';
import type { SyncQuotaManager } from './sync-quota-manager.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { ReplicationLinkState, SyncDirection } from './types/sync.js';

export type SyncFeedConvergenceLinkContext = {
  link: ReplicationLinkState;
  linkKey: string;
};

export interface SyncFeedConvergenceManagerOperations {
  getActiveLink(linkKey: string): ReplicationLinkState | undefined;
  getLink(target: SyncTarget): Promise<ReplicationLinkState>;
  getLinkKey(target: SyncTarget, link: ReplicationLinkState): string;
  isLinkKeyForTenant(linkKey: string, tenantDid: string): boolean;
  resetCheckpoints(link: ReplicationLinkState): Promise<void>;
  scheduleLinkWorkByKey(
    linkKey: string,
    link: ReplicationLinkState,
    directions: readonly SyncDirection[],
    delayMs: number,
  ): void;
  scheduleQuotaProbe(linkKey: string, link: ReplicationLinkState, nextProbeAt: string): void;
}

export type SyncFeedConvergenceManagerParams = {
  operations: SyncFeedConvergenceManagerOperations;
  quotaManager: SyncQuotaManager;
};

/**
 * Converts an explicit fingerprint mismatch into ordinary durable work.
 *
 * This collaborator owns no retry loop or durable link state. Quota omissions
 * retain their existing Retry-After owner; every distinct verified mismatch
 * resets the two feed checkpoints once and asks the active link executor to
 * rescan. An identical mismatch remains diagnostic until either fingerprint
 * changes or a later probe proves convergence.
 */
export class SyncFeedConvergenceManager {
  private readonly _lastRescanSignature = new Map<string, string>();
  private readonly _operations: SyncFeedConvergenceManagerOperations;
  private readonly _quotaManager: SyncQuotaManager;

  public constructor({ operations, quotaManager }: SyncFeedConvergenceManagerParams) {
    this._operations = operations;
    this._quotaManager = quotaManager;
  }

  /** Explain a durable omission or request one ordinary checkpoint rescan. */
  public async handleVerifiedDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
    context?: SyncFeedConvergenceLinkContext,
  ): Promise<boolean> {
    const resolved = await this.resolveLinkContext(target, context);
    if (await this._quotaManager.reconcileAndExplainFeedDivergence(target, result)) {
      this._lastRescanSignature.delete(resolved.linkKey);
      await this.scheduleNextQuotaProbe(target, resolved);
      return true;
    }

    const signature = SyncFeedConvergenceManager.rescanSignature(result);
    if (this._lastRescanSignature.get(resolved.linkKey) === signature) {
      return false;
    }
    const activeLink = this._operations.getActiveLink(resolved.linkKey);
    const link = activeLink ?? resolved.link;
    await this._operations.resetCheckpoints(link);
    this._lastRescanSignature.set(resolved.linkKey, signature);
    if (activeLink?.status === 'live') {
      this._operations.scheduleLinkWorkByKey(
        resolved.linkKey,
        activeLink,
        ['pull', 'push'],
        0,
      );
    }
    return false;
  }

  /** Clear one target's rescan suppression after verified convergence. */
  public async clear(
    target: SyncTarget,
    context?: SyncFeedConvergenceLinkContext,
  ): Promise<void> {
    const { linkKey } = await this.resolveLinkContext(target, context);
    this._lastRescanSignature.delete(linkKey);
  }

  public clearLink(linkKey: string): void {
    this._lastRescanSignature.delete(linkKey);
  }

  public clearAll(): void {
    this._lastRescanSignature.clear();
  }

  public clearTenant(tenantDid: string): void {
    for (const linkKey of this._lastRescanSignature.keys()) {
      if (this._operations.isLinkKeyForTenant(linkKey, tenantDid)) {
        this._lastRescanSignature.delete(linkKey);
      }
    }
  }

  private async scheduleNextQuotaProbe(
    target: SyncTarget,
    context: SyncFeedConvergenceLinkContext | undefined,
  ): Promise<void> {
    const nextProbeAt = await this._quotaManager.getNextProbeAtForTarget(target);
    if (nextProbeAt === undefined) {
      return;
    }

    const { linkKey } = await this.resolveLinkContext(target, context);
    const liveLink = this._operations.getActiveLink(linkKey);
    if (liveLink?.status === 'live') {
      this._operations.scheduleQuotaProbe(linkKey, liveLink, nextProbeAt);
    }
  }

  private async resolveLinkContext(
    target: SyncTarget,
    context: SyncFeedConvergenceLinkContext | undefined,
  ): Promise<SyncFeedConvergenceLinkContext> {
    if (context !== undefined) {
      return context;
    }
    const link = await this._operations.getLink(target);
    return { link, linkKey: this._operations.getLinkKey(target, link) };
  }

  private static rescanSignature(result: SyncDurableFeedReconcileResult): string {
    return JSON.stringify({
      localFingerprint  : result.localFingerprint,
      remoteFingerprint : result.remoteFingerprint,
    });
  }
}
