import type { SyncDurableFeedReconcileResult } from './sync-durable-feed-reconciler.js';
import type { SyncQuotaManager } from './sync-quota-manager.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type { DeadLetterEntry, ReplicationLinkState, SyncScope } from './types/sync.js';

import { syncScopeCoversProtocol } from './types/sync.js';

export type SyncFeedConvergenceLinkContext = {
  link: ReplicationLinkState;
  linkKey: string;
};

export interface SyncFeedConvergenceManagerOperations {
  getActiveLink(linkKey: string): ReplicationLinkState | undefined;
  getDeadLettersForTenant(tenantDid: string): Promise<DeadLetterEntry[]>;
  getLink(target: SyncTarget): Promise<ReplicationLinkState>;
  getLinkKey(target: SyncTarget, link: ReplicationLinkState): string;
  isLinkKeyForTenant(linkKey: string, tenantDid: string): boolean;
  resetCheckpoints(link: ReplicationLinkState): Promise<void>;
  scheduleLinkReconcileByKey(
    linkKey: string,
    link: ReplicationLinkState,
    reason: string,
    delayMs: number,
  ): void;
  scheduleQuotaProbe(linkKey: string, link: ReplicationLinkState, nextProbeAt: string): void;
  transitionToPaused(linkKey: string, link: ReplicationLinkState): Promise<void>;
}

export type SyncFeedConvergenceManagerParams = {
  maxAttempts?: number;
  operations: SyncFeedConvergenceManagerOperations;
  quotaManager: SyncQuotaManager;
};

type SyncFeedConvergenceFailureState = {
  attempts: number;
  signature: string;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const FEED_FINGERPRINT_MISMATCH = 'feed-fingerprint-mismatch';

/**
 * Tracks verified feed divergence and decides whether to accept a durable
 * omission, reset a link for another reconciliation, or pause repeated
 * identical failures. Storage and live-runtime transitions are injected.
 */
export class SyncFeedConvergenceManager {
  private readonly _failures = new Map<string, SyncFeedConvergenceFailureState>();
  private readonly _maxAttempts: number;
  private readonly _operations: SyncFeedConvergenceManagerOperations;
  private readonly _quotaManager: SyncQuotaManager;

  public constructor({
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    operations,
    quotaManager,
  }: SyncFeedConvergenceManagerParams) {
    this._maxAttempts = maxAttempts;
    this._operations = operations;
    this._quotaManager = quotaManager;
  }

  /** Resolve quota-explained divergence or record an unexplained mismatch. */
  public async handleVerifiedDivergence(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
    context?: SyncFeedConvergenceLinkContext,
  ): Promise<boolean> {
    if (await this._quotaManager.reconcileAndExplainFeedDivergence(target, result)) {
      await this.clear(target, context);
      await this.scheduleNextQuotaProbe(target, context);
      return true;
    }

    const deadLetterCids = await this.getAdmissionDeadLetterCids(target);
    await this.handleRepeatedMismatch(target, result, deadLetterCids, context);
    return false;
  }

  /** Clear one target's repeated mismatch state. */
  public async clear(
    target: SyncTarget,
    context?: SyncFeedConvergenceLinkContext,
  ): Promise<void> {
    const { linkKey } = await this.resolveLinkContext(target, context);
    this._failures.delete(linkKey);
  }

  /** Clear mismatch state for one already-resolved link key. */
  public clearLink(linkKey: string): void {
    this._failures.delete(linkKey);
  }

  /** Clear all in-memory mismatch state. */
  public clearAll(): void {
    this._failures.clear();
  }

  /** Clear mismatch state belonging to one tenant. */
  public clearTenant(tenantDid: string): void {
    for (const linkKey of this._failures.keys()) {
      if (this._operations.isLinkKeyForTenant(linkKey, tenantDid)) {
        this._failures.delete(linkKey);
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

  private async handleRepeatedMismatch(
    target: SyncTarget,
    result: SyncDurableFeedReconcileResult,
    deadLetterCids: string[],
    context: SyncFeedConvergenceLinkContext | undefined,
  ): Promise<void> {
    const resolved = await this.resolveLinkContext(target, context);
    const activeLink = this._operations.getActiveLink(resolved.linkKey);
    const link = activeLink ?? resolved.link;
    const signature = SyncFeedConvergenceManager.failureSignature(result, deadLetterCids);
    const previous = this._failures.get(resolved.linkKey);
    const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;
    this._failures.set(resolved.linkKey, { attempts, signature });

    if (attempts >= this._maxAttempts) {
      await this._operations.transitionToPaused(resolved.linkKey, link);
      return;
    }

    await this._operations.resetCheckpoints(link);
    if (activeLink?.status === 'live') {
      this._operations.scheduleLinkReconcileByKey(
        resolved.linkKey,
        activeLink,
        FEED_FINGERPRINT_MISMATCH,
        0,
      );
    }
  }

  private async getAdmissionDeadLetterCids(target: SyncTarget): Promise<string[]> {
    const messageCids = new Set<string>();
    for (const entry of await this._operations.getDeadLettersForTenant(target.did)) {
      if (
        entry.remoteEndpoint === target.dwnUrl &&
        SyncFeedConvergenceManager.deadLetterMatchesScope(entry, target.scope)
      ) {
        messageCids.add(entry.messageCid);
      }
    }
    return [...messageCids].sort((a, b) => a.localeCompare(b));
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

  private static deadLetterMatchesScope(entry: DeadLetterEntry, scope: SyncScope): boolean {
    return entry.protocol === undefined || syncScopeCoversProtocol(scope, entry.protocol);
  }

  private static failureSignature(
    result: SyncDurableFeedReconcileResult,
    deadLetterCids: string[],
  ): string {
    return JSON.stringify({
      deadLetterCids,
      localFingerprint  : result.localFingerprint,
      remoteFingerprint : result.remoteFingerprint,
    });
  }
}
