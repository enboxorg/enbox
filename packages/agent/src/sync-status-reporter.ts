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

import { buildCurrentLinkIdentityKey } from './sync-link-key.js';
import { lexicographicalCompare } from './types/sync.js';
import { resolveSyncConnectivityState } from './sync-connectivity-manager.js';

/** Current link identities, or `undefined` when target resolution was incomplete. */
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

/** Combined projections produced from one set of durable status reads. */
type SyncStatusReport = {
  health: SyncHealthSummary;
  links: ReplicationLinkSnapshot[];
  remotes: RemoteSyncStatus[];
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

  /** Produce every public status projection from one set of durable reads. */
  public async getStatus(tenantDid?: string): Promise<SyncStatusReport> {
    const [currentLinkIdentityKeys, currentQuotaLinkKeys, allLinks, allQuotaBlocks, allDeadLetters] = await Promise.all([
      this._operations.getCurrentLinkIdentityKeys(),
      this._operations.getCurrentQuotaLinkKeys(),
      this._operations.getLinks(),
      this._quotaManager.getAllBlockStates(),
      this._operations.getDeadLetters(),
    ]);
    const links = allLinks.filter((link): boolean =>
      SyncStatusReporter.matchesTenant(link.tenantDid, tenantDid)
      && SyncStatusReporter.isCurrentLink(link, currentLinkIdentityKeys));
    const quotaBlocks = allQuotaBlocks.filter((state): boolean =>
      SyncStatusReporter.matchesTenant(state.tenantDid, tenantDid)
      && SyncStatusReporter.isCurrentQuotaBlock(state, currentQuotaLinkKeys));
    const deadLetters = allDeadLetters.filter((entry): boolean =>
      SyncStatusReporter.matchesTenant(entry.tenantDid, tenantDid));

    const rows = new Map<string, RemoteStatusAccumulator>();
    SyncStatusReporter.accumulateLinkStatus(rows, links);
    SyncStatusReporter.accumulateQuotaBlockStatus(rows, quotaBlocks);
    SyncStatusReporter.accumulateDeadLetterStatus(rows, deadLetters);

    const degradedLinkCount = links.filter((link): boolean =>
      SyncStatusReporter.isUnhealthyLinkStatus(link.status)).length;
    const failedMessageCount = deadLetters.length;
    const quotaBlockedMessageCount = quotaBlocks.length;
    const health: SyncHealthSummary = {
      connectivity: tenantDid === undefined
        ? this._operations.getConnectivityState()
        : resolveSyncConnectivityState(links.map((link): SyncConnectivityState => link.connectivity)),
      failedMessageCount,
      degradedLinkCount,
      quotaBlockedMessageCount,
      syncHealthy: failedMessageCount === 0 && degradedLinkCount === 0 && quotaBlockedMessageCount === 0,
    };
    const linkSnapshots = links.map((link): ReplicationLinkSnapshot =>
      SyncStatusReporter.linkSnapshotFrom(link));
    const remotes = [...rows.values()].map((row): RemoteSyncStatus =>
      SyncStatusReporter.remoteStatusFromRow(row));
    linkSnapshots.sort(SyncStatusReporter.compareRemoteRows);
    remotes.sort(SyncStatusReporter.compareRemoteRows);

    return {
      health,
      links: linkSnapshots,
      remotes,
    };
  }

  /** Summarize current terminal failures, quota blocks, and degraded links. */
  public async getHealth(): Promise<SyncHealthSummary> {
    return (await this.getStatus()).health;
  }

  /** Build stable per-remote status rows, optionally scoped to one tenant. */
  public async getRemoteStatus(tenantDid?: string): Promise<RemoteSyncStatus[]> {
    return (await this.getStatus(tenantDid)).remotes;
  }

  /** Build read-only per-link snapshots of current links, optionally scoped to one tenant. */
  public async getReplicationLinks(tenantDid?: string): Promise<ReplicationLinkSnapshot[]> {
    const currentLinkIdentityKeys = await this._operations.getCurrentLinkIdentityKeys();
    const links = (await this._operations.getLinks()).filter((link): boolean =>
      SyncStatusReporter.matchesTenant(link.tenantDid, tenantDid)
      && SyncStatusReporter.isCurrentLink(link, currentLinkIdentityKeys));
    return links
      .map((link): ReplicationLinkSnapshot => SyncStatusReporter.linkSnapshotFrom(link))
      .sort(SyncStatusReporter.compareRemoteRows);
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
      ...(link.authorization.kind === 'role' ? { followedSourceId: link.authorization.roleRecordId } : {}),
      ...(pullPosition === undefined ? {} : { pullPosition }),
      ...(pushPosition === undefined ? {} : { pushPosition }),
      ...(link.lastActivityAt === undefined ? {} : { lastActivityAt: link.lastActivityAt }),
    };
  }

  /** Durable links seed connectivity, activity, and degraded state. */
  private static accumulateLinkStatus(
    rows: Map<string, RemoteStatusAccumulator>,
    links: readonly SyncStatusLink[],
  ): void {
    for (const link of links) {
      const row = SyncStatusReporter.remoteStatusRowFor(rows, link.tenantDid, link.remoteEndpoint);
      row.connectivity = SyncStatusReporter.mergeConnectivity(row.connectivity, link.connectivity);
      if (SyncStatusReporter.isUnhealthyLinkStatus(link.status)) { row.degraded = true; }
      if (link.lastActivityAt !== undefined) {
        row.lastActivityAt = SyncStatusReporter.latestTimestamp(row.lastActivityAt, link.lastActivityAt);
      }
    }
  }

  /** Quota blocks contribute their count, soonest probe, and latest detail. */
  private static accumulateQuotaBlockStatus(
    rows: Map<string, RemoteStatusAccumulator>,
    quotaBlocks: readonly SyncQuotaBlockState[],
  ): void {
    for (const state of quotaBlocks) {
      const row = SyncStatusReporter.remoteStatusRowFor(rows, state.tenantDid, state.remoteEndpoint);
      row.quotaBlockedMessageCount++;
      row.nextProbeAt = SyncStatusReporter.earliestTimestamp(row.nextProbeAt, state.nextProbeAt);
      SyncStatusReporter.recordLatestError(row, state.lastBlockedAt, state.detail);
    }
  }

  /** Dead letters contribute terminal failure counts per tenant and remote. */
  private static accumulateDeadLetterStatus(
    rows: Map<string, RemoteStatusAccumulator>,
    deadLetters: readonly DeadLetterEntry[],
  ): void {
    for (const entry of deadLetters) {
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
      return link.authorization.kind !== 'role';
    }

    return currentIdentityKeys.has(buildCurrentLinkIdentityKey(
      link.tenantDid,
      link.remoteEndpoint,
      link.projectionId,
      link.authorizationEpoch,
      link.authorization.kind,
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

  private static compareRemoteRows(
    a: { tenantDid: string; remoteEndpoint: string },
    b: { tenantDid: string; remoteEndpoint: string },
  ): number {
    return lexicographicalCompare(
      SyncStatusReporter.remoteRowKey(a.tenantDid, a.remoteEndpoint),
      SyncStatusReporter.remoteRowKey(b.tenantDid, b.remoteEndpoint),
    );
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
