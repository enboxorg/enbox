import type { SyncQuotaBlockState } from './sync-quota-store.js';
import type { SyncQuotaManager } from './sync-quota-manager.js';
import type {
  DeadLetterEntry,
  RemoteSyncState,
  RemoteSyncStatus,
  ReplicationLinkSnapshot,
  ReplicationLinkState,
  SyncConnectivityState,
  SyncHealthSummary,
} from './types/sync.js';

import { buildDurableLinkIdentityKey } from './sync-link-key.js';
import { lexicographicalCompare } from './types/sync.js';

/** Current durable identities, or `undefined` when resolution was incomplete. */
export type SyncStatusCurrentKeySet = ReadonlySet<string> | undefined;

/** Durable link row with current replication-session facts overlaid by the engine. */
export type SyncStatusLink = ReplicationLinkState & { isPullCurrent: boolean };

/** Engine-owned state reads required by backend-neutral status aggregation. */
export interface SyncStatusReporterOperations {
  getConnectivityState(): SyncConnectivityState;

  getCurrentLinkIdentityKeys(): Promise<SyncStatusCurrentKeySet>;

  getCurrentQuotaLinkKeys(): Promise<SyncStatusCurrentKeySet>;

  getDeadLetters(): Promise<DeadLetterEntry[]>;

  getLinks(): Promise<SyncStatusLink[]>;
}

export type SyncStatusReporterParams = {
  operations: SyncStatusReporterOperations;
  quotaManager: SyncQuotaManager;
};

/** Per-(tenant, remote) state folded from links, quota blocks, and dead letters. */
type RemoteStatusAccumulator = {
  connectivity: SyncConnectivityState;
  degraded: boolean;
  failedMessageCount: number;
  lastActivityAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  nextProbeAt?: string;
  quotaBlockedMessageCount: number;
  remoteEndpoint: string;
  tenantDid: string;
};

/**
 * Aggregates sync health and per-remote status independently of a persistence backend.
 *
 * Engine state reads and current-topology resolution are injected. Durable
 * quota state comes from `SyncQuotaManager`, independent of its store backend.
 */
export class SyncStatusReporter {
  private readonly _operations: SyncStatusReporterOperations;
  private readonly _quotaManager: SyncQuotaManager;

  constructor({ operations, quotaManager }: SyncStatusReporterParams) {
    this._operations = operations;
    this._quotaManager = quotaManager;
  }

  /** Summarize current terminal failures, quota blocks, and degraded links. */
  public async getHealth(): Promise<SyncHealthSummary> {
    const failedMessageCount = (await this._operations.getDeadLetters()).length;

    const currentQuotaLinkKeys = await this._operations.getCurrentQuotaLinkKeys();
    let quotaBlockedMessageCount = 0;
    for (const state of await this._quotaManager.getAllBlockStates()) {
      if (SyncStatusReporter.isCurrentQuotaBlock(state, currentQuotaLinkKeys)) {
        quotaBlockedMessageCount++;
      }
    }

    const currentLinkIdentityKeys = await this._operations.getCurrentLinkIdentityKeys();
    let degradedLinkCount = 0;
    for (const link of await this._operations.getLinks()) {
      if (
        SyncStatusReporter.isCurrentLink(link, currentLinkIdentityKeys) &&
        SyncStatusReporter.isUnhealthyLinkStatus(link.status)
      ) {
        degradedLinkCount++;
      }
    }

    return {
      connectivity : this._operations.getConnectivityState(),
      failedMessageCount,
      degradedLinkCount,
      quotaBlockedMessageCount,
      syncHealthy  : failedMessageCount === 0 && degradedLinkCount === 0 && quotaBlockedMessageCount === 0,
    };
  }

  /** Build stable per-remote status rows, optionally scoped to one tenant. */
  public async getRemoteStatus(tenantDid?: string): Promise<RemoteSyncStatus[]> {
    const rows = new Map<string, RemoteStatusAccumulator>();

    await this.accumulateLinkStatus(rows, tenantDid);
    await this.accumulateQuotaBlockStatus(rows, tenantDid);
    await this.accumulateDeadLetterStatus(rows, tenantDid);

    return [...rows.values()]
      .map((row): RemoteSyncStatus => SyncStatusReporter.remoteStatusFromRow(row))
      .sort((a, b) => lexicographicalCompare(
        SyncStatusReporter.remoteRowKey(a.tenantDid, a.remoteEndpoint),
        SyncStatusReporter.remoteRowKey(b.tenantDid, b.remoteEndpoint),
      ));
  }

  /** Build read-only per-link snapshots of current links, optionally scoped to one tenant. */
  public async getReplicationLinks(tenantDid?: string): Promise<ReplicationLinkSnapshot[]> {
    const currentLinkIdentityKeys = await this._operations.getCurrentLinkIdentityKeys();
    const snapshots: ReplicationLinkSnapshot[] = [];
    for (const link of await this._operations.getLinks()) {
      if (!SyncStatusReporter.matchesTenant(link.tenantDid, tenantDid)) { continue; }
      if (!SyncStatusReporter.isCurrentLink(link, currentLinkIdentityKeys)) { continue; }
      snapshots.push(SyncStatusReporter.linkSnapshotFrom(link));
    }

    return snapshots.sort((a, b) => lexicographicalCompare(
      SyncStatusReporter.remoteRowKey(a.tenantDid, a.remoteEndpoint),
      SyncStatusReporter.remoteRowKey(b.tenantDid, b.remoteEndpoint),
    ));
  }

  /**
   * Project a durable link into its public, mutation-safe snapshot shape.
   * `scope` is returned by reference — safe because `getLinks()` deserializes
   * fresh link objects per call, so no engine-held state is exposed.
   */
  private static linkSnapshotFrom(link: SyncStatusLink): ReplicationLinkSnapshot {
    const pullPosition = link.pull.contiguousAppliedToken?.position;
    const pushPosition = link.push.contiguousAppliedToken?.position;
    return {
      tenantDid      : link.tenantDid,
      remoteEndpoint : link.remoteEndpoint,
      scope          : link.scope,
      status         : link.status,
      connectivity   : link.connectivity,
      isPullCurrent  : link.isPullCurrent,
      ...(link.delegateDid === undefined ? {} : { delegateDid: link.delegateDid }),
      ...(pullPosition === undefined ? {} : { pullPosition }),
      ...(pushPosition === undefined ? {} : { pushPosition }),
      ...(link.lastActivityAt === undefined ? {} : { lastActivityAt: link.lastActivityAt }),
    };
  }

  /** Durable links seed connectivity, activity, and degraded state. */
  private async accumulateLinkStatus(
    rows: Map<string, RemoteStatusAccumulator>,
    tenantDid: string | undefined,
  ): Promise<void> {
    const currentLinkIdentityKeys = await this._operations.getCurrentLinkIdentityKeys();
    for (const link of await this._operations.getLinks()) {
      if (!SyncStatusReporter.matchesTenant(link.tenantDid, tenantDid)) { continue; }
      if (!SyncStatusReporter.isCurrentLink(link, currentLinkIdentityKeys)) { continue; }

      const row = SyncStatusReporter.remoteStatusRowFor(rows, link.tenantDid, link.remoteEndpoint);
      row.connectivity = SyncStatusReporter.mergeConnectivity(row.connectivity, link.connectivity);
      if (SyncStatusReporter.isUnhealthyLinkStatus(link.status)) { row.degraded = true; }
      if (link.lastActivityAt !== undefined) {
        row.lastActivityAt = SyncStatusReporter.latestTimestamp(row.lastActivityAt, link.lastActivityAt);
      }
    }
  }

  /** Quota blocks contribute their count, soonest probe, and latest detail. */
  private async accumulateQuotaBlockStatus(
    rows: Map<string, RemoteStatusAccumulator>,
    tenantDid: string | undefined,
  ): Promise<void> {
    const currentQuotaLinkKeys = await this._operations.getCurrentQuotaLinkKeys();
    for (const state of await this._quotaManager.getAllBlockStates()) {
      if (!SyncStatusReporter.matchesTenant(state.tenantDid, tenantDid)) { continue; }
      if (!SyncStatusReporter.isCurrentQuotaBlock(state, currentQuotaLinkKeys)) { continue; }

      const row = SyncStatusReporter.remoteStatusRowFor(rows, state.tenantDid, state.remoteEndpoint);
      row.quotaBlockedMessageCount++;
      row.nextProbeAt = SyncStatusReporter.earliestTimestamp(row.nextProbeAt, state.nextProbeAt);
      SyncStatusReporter.recordLatestError(row, state.lastBlockedAt, state.detail);
    }
  }

  /** Dead letters contribute terminal failure counts per tenant and remote. */
  private async accumulateDeadLetterStatus(
    rows: Map<string, RemoteStatusAccumulator>,
    tenantDid: string | undefined,
  ): Promise<void> {
    for (const entry of await this._operations.getDeadLetters()) {
      if (!SyncStatusReporter.matchesTenant(entry.tenantDid, tenantDid)) {
        continue;
      }

      const row = SyncStatusReporter.remoteStatusRowFor(rows, entry.tenantDid, entry.remoteEndpoint);
      row.failedMessageCount++;
      row.degraded = true;
      SyncStatusReporter.recordLatestError(row, entry.failedAt, entry.errorDetail);
    }
  }

  private static isCurrentLink(
    link: ReplicationLinkState,
    currentIdentityKeys: SyncStatusCurrentKeySet,
  ): boolean {
    if (currentIdentityKeys === undefined) {
      return true;
    }

    return currentIdentityKeys.has(buildDurableLinkIdentityKey(
      link.tenantDid,
      link.projectionId,
      link.authorizationEpoch,
    ));
  }

  private static isCurrentQuotaBlock(
    state: SyncQuotaBlockState,
    currentLinkKeys: SyncStatusCurrentKeySet,
  ): boolean {
    return state.supersededAt === undefined && (currentLinkKeys === undefined || currentLinkKeys.has(state.linkKey));
  }

  private static isUnhealthyLinkStatus(status: ReplicationLinkState['status']): boolean {
    return status === 'repairing' || status === 'paused';
  }

  private static matchesTenant(candidateDid: string, tenantDid: string | undefined): boolean {
    return tenantDid === undefined || candidateDid === tenantDid;
  }

  private static mergeConnectivity(
    current: SyncConnectivityState,
    candidate: SyncConnectivityState,
  ): SyncConnectivityState {
    if (current === 'offline' || candidate === 'offline') { return 'offline'; }
    if (current === 'online' || candidate === 'online') { return 'online'; }
    return 'unknown';
  }

  private static remoteRowKey(did: string, remote: string): string {
    return `${did}|${remote}`;
  }

  private static remoteStatusRowFor(
    rows: Map<string, RemoteStatusAccumulator>,
    did: string,
    remote: string,
  ): RemoteStatusAccumulator {
    const key = SyncStatusReporter.remoteRowKey(did, remote);
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        connectivity             : 'unknown',
        degraded                 : false,
        failedMessageCount       : 0,
        quotaBlockedMessageCount : 0,
        remoteEndpoint           : remote,
        tenantDid                : did,
      };
      rows.set(key, row);
    }
    return row;
  }

  private static recordLatestError(
    row: RemoteStatusAccumulator,
    candidateAt: string,
    detail: string | undefined,
  ): void {
    if (row.lastErrorAt === undefined || lexicographicalCompare(candidateAt, row.lastErrorAt) > 0) {
      row.lastErrorAt = candidateAt;
      row.lastError = detail;
    }
  }

  private static remoteStatusFromRow(row: RemoteStatusAccumulator): RemoteSyncStatus {
    return {
      tenantDid                : row.tenantDid,
      remoteEndpoint           : row.remoteEndpoint,
      state                    : SyncStatusReporter.rollUpRemoteState(row),
      connectivity             : row.connectivity,
      quotaBlockedMessageCount : row.quotaBlockedMessageCount,
      failedMessageCount       : row.failedMessageCount,
      ...(row.nextProbeAt === undefined ? {} : { nextProbeAt: row.nextProbeAt }),
      ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
      ...(row.lastActivityAt === undefined ? {} : { lastActivityAt: row.lastActivityAt }),
    };
  }

  private static rollUpRemoteState(row: RemoteStatusAccumulator): RemoteSyncState {
    if (row.connectivity === 'offline') { return 'offline'; }
    if (row.quotaBlockedMessageCount > 0) { return 'quota-blocked'; }
    if (row.degraded || row.failedMessageCount > 0) { return 'degraded'; }
    return 'healthy';
  }

  private static earliestTimestamp(current: string | undefined, candidate: string): string {
    return current === undefined || lexicographicalCompare(candidate, current) < 0 ? candidate : current;
  }

  private static latestTimestamp(current: string | undefined, candidate: string): string {
    return current === undefined || lexicographicalCompare(candidate, current) > 0 ? candidate : current;
  }
}
