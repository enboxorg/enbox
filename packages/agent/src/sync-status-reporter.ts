import type { SyncQuotaBlockState } from './sync-quota-store.js';
import type {
  DeadLetterEntry,
  RemoteSyncState,
  RemoteSyncStatus,
  ReplicationCurrentness,
  ReplicationLinkSnapshot,
  ReplicationLinkState,
  SyncConnectivityState,
  SyncHealthSummary,
} from './types/sync.js';

import { buildCurrentLinkIdentityKey } from './sync-link-key.js';
import { resolveSyncConnectivityState } from './sync-connectivity-manager.js';
import { lexicographicalCompare, projectReplicationCurrentness } from './types/sync.js';

/** Current link identities, or `undefined` when target resolution was incomplete. */
export type SyncStatusCurrentKeySet = ReadonlySet<string> | undefined;

/** Durable link row with current replication-session facts overlaid by the engine. */
export type SyncStatusLink = ReplicationLinkState & { isPullCurrent: boolean };

/** Combined projections produced from one set of durable status reads. */
export type SyncStatusSnapshot = {
  connectivity: SyncConnectivityState;
  currentness: ReplicationCurrentness;
  health: SyncHealthSummary;
  lastActivityAt?: string;
  links: ReplicationLinkSnapshot[];
  remotes: RemoteSyncStatus[];
};

export type SyncStatusProjectionParams = {
  connectivity: SyncConnectivityState;
  currentLinkIdentityKeys: SyncStatusCurrentKeySet;
  currentQuotaLinkKeys: SyncStatusCurrentKeySet;
  deadLetters: readonly DeadLetterEntry[];
  links: readonly SyncStatusLink[];
  quotaBlocks: readonly SyncQuotaBlockState[];
  tenantDid?: string;
};

export type SyncReplicationLinksProjectionParams = {
  currentLinkIdentityKeys: SyncStatusCurrentKeySet;
  links: readonly SyncStatusLink[];
  tenantDid?: string;
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

/** Project one already-read durable status snapshot without owning engine state or persistence. */
export function projectSyncStatus({
  connectivity,
  currentLinkIdentityKeys,
  currentQuotaLinkKeys,
  deadLetters: allDeadLetters,
  links: allLinks,
  quotaBlocks: allQuotaBlocks,
  tenantDid,
}: SyncStatusProjectionParams): SyncStatusSnapshot {
  const links = allLinks.filter((link): boolean =>
    matchesTenant(link.tenantDid, tenantDid)
    && isCurrentLink(link, currentLinkIdentityKeys));
  const quotaBlocks = allQuotaBlocks.filter((state): boolean =>
    matchesTenant(state.tenantDid, tenantDid)
    && isCurrentQuotaBlock(state, currentQuotaLinkKeys));
  const deadLetters = allDeadLetters.filter((entry): boolean =>
    matchesTenant(entry.tenantDid, tenantDid));

  const rows = new Map<string, RemoteStatusAccumulator>();
  accumulateLinkStatus(rows, links);
  accumulateQuotaBlockStatus(rows, quotaBlocks);
  accumulateDeadLetterStatus(rows, deadLetters);

  const degradedLinkCount = links.filter((link): boolean => isUnhealthyLinkStatus(link.status)).length;
  const failedMessageCount = deadLetters.length;
  const quotaBlockedMessageCount = quotaBlocks.length;
  const health: SyncHealthSummary = {
    connectivity: tenantDid === undefined
      ? connectivity
      : resolveSyncConnectivityState(links.map((link): SyncConnectivityState => link.connectivity)),
    failedMessageCount,
    degradedLinkCount,
    quotaBlockedMessageCount,
    syncHealthy: failedMessageCount === 0 && degradedLinkCount === 0 && quotaBlockedMessageCount === 0,
  };
  const linkSnapshots = links.map((link): ReplicationLinkSnapshot => linkSnapshotFrom(link));
  const remotes = [...rows.values()].map((row): RemoteSyncStatus => remoteStatusFromRow(row));
  linkSnapshots.sort(compareRemoteRows);
  remotes.sort(compareRemoteRows);

  return {
    connectivity: resolveSyncConnectivityState(
      links.map((link): SyncConnectivityState => link.connectivity),
      connectivity,
    ),
    currentness    : projectReplicationCurrentness(linkSnapshots),
    health,
    lastActivityAt : latestLinkActivityAt(links),
    links          : linkSnapshots,
    remotes,
  };
}

function latestLinkActivityAt(links: readonly SyncStatusLink[]): string | undefined {
  let latest: string | undefined;
  for (const { lastActivityAt } of links) {
    if (lastActivityAt !== undefined) {
      latest = latestTimestamp(latest, lastActivityAt);
    }
  }
  return latest;
}

/** Project read-only per-link snapshots without reading unrelated status stores. */
export function projectReplicationLinks({
  currentLinkIdentityKeys,
  links,
  tenantDid,
}: SyncReplicationLinksProjectionParams): ReplicationLinkSnapshot[] {
  return links
    .filter((link): boolean =>
      matchesTenant(link.tenantDid, tenantDid)
      && isCurrentLink(link, currentLinkIdentityKeys))
    .map((link): ReplicationLinkSnapshot => linkSnapshotFrom(link))
    .sort(compareRemoteRows);
}

/** Project a durable link into its public, mutation-safe snapshot shape. */
function linkSnapshotFrom(link: SyncStatusLink): ReplicationLinkSnapshot {
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
function accumulateLinkStatus(
  rows: Map<string, RemoteStatusAccumulator>,
  links: readonly SyncStatusLink[],
): void {
  for (const link of links) {
    const row = remoteStatusRowFor(rows, link.tenantDid, link.remoteEndpoint);
    row.connectivity = mergeConnectivity(row.connectivity, link.connectivity);
    if (isUnhealthyLinkStatus(link.status)) { row.degraded = true; }
    if (link.lastActivityAt !== undefined) {
      row.lastActivityAt = latestTimestamp(row.lastActivityAt, link.lastActivityAt);
    }
  }
}

/** Quota blocks contribute their count, soonest probe, and latest detail. */
function accumulateQuotaBlockStatus(
  rows: Map<string, RemoteStatusAccumulator>,
  quotaBlocks: readonly SyncQuotaBlockState[],
): void {
  for (const state of quotaBlocks) {
    const row = remoteStatusRowFor(rows, state.tenantDid, state.remoteEndpoint);
    row.quotaBlockedMessageCount++;
    row.nextProbeAt = earliestTimestamp(row.nextProbeAt, state.nextProbeAt);
    recordLatestError(row, state.lastBlockedAt, state.detail);
  }
}

/** Dead letters contribute terminal failure counts per tenant and remote. */
function accumulateDeadLetterStatus(
  rows: Map<string, RemoteStatusAccumulator>,
  deadLetters: readonly DeadLetterEntry[],
): void {
  for (const entry of deadLetters) {
    const row = remoteStatusRowFor(rows, entry.tenantDid, entry.remoteEndpoint);
    row.failedMessageCount++;
    row.degraded = true;
    recordLatestError(row, entry.failedAt, entry.errorDetail);
  }
}

function isCurrentLink(
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

function isCurrentQuotaBlock(
  state: SyncQuotaBlockState,
  currentLinkKeys: SyncStatusCurrentKeySet,
): boolean {
  return state.supersededAt === undefined && (currentLinkKeys === undefined || currentLinkKeys.has(state.linkKey));
}

function isUnhealthyLinkStatus(status: ReplicationLinkState['status']): boolean {
  return status === 'repairing' || status === 'paused';
}

function matchesTenant(candidateDid: string, tenantDid: string | undefined): boolean {
  return tenantDid === undefined || candidateDid === tenantDid;
}

function mergeConnectivity(
  current: SyncConnectivityState,
  candidate: SyncConnectivityState,
): SyncConnectivityState {
  if (current === 'offline' || candidate === 'offline') { return 'offline'; }
  if (current === 'online' || candidate === 'online') { return 'online'; }
  return 'unknown';
}

function compareRemoteRows(
  a: { tenantDid: string; remoteEndpoint: string },
  b: { tenantDid: string; remoteEndpoint: string },
): number {
  return lexicographicalCompare(
    remoteRowKey(a.tenantDid, a.remoteEndpoint),
    remoteRowKey(b.tenantDid, b.remoteEndpoint),
  );
}

function remoteRowKey(did: string, remote: string): string {
  return `${did}|${remote}`;
}

function remoteStatusRowFor(
  rows: Map<string, RemoteStatusAccumulator>,
  did: string,
  remote: string,
): RemoteStatusAccumulator {
  const key = remoteRowKey(did, remote);
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

function recordLatestError(
  row: RemoteStatusAccumulator,
  candidateAt: string,
  detail: string | undefined,
): void {
  if (row.lastErrorAt === undefined || lexicographicalCompare(candidateAt, row.lastErrorAt) > 0) {
    row.lastErrorAt = candidateAt;
    row.lastError = detail;
  }
}

function remoteStatusFromRow(row: RemoteStatusAccumulator): RemoteSyncStatus {
  return {
    tenantDid                : row.tenantDid,
    remoteEndpoint           : row.remoteEndpoint,
    state                    : rollUpRemoteState(row),
    connectivity             : row.connectivity,
    quotaBlockedMessageCount : row.quotaBlockedMessageCount,
    failedMessageCount       : row.failedMessageCount,
    ...(row.nextProbeAt === undefined ? {} : { nextProbeAt: row.nextProbeAt }),
    ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
    ...(row.lastActivityAt === undefined ? {} : { lastActivityAt: row.lastActivityAt }),
  };
}

function rollUpRemoteState(row: RemoteStatusAccumulator): RemoteSyncState {
  if (row.connectivity === 'offline') { return 'offline'; }
  if (row.quotaBlockedMessageCount > 0) { return 'quota-blocked'; }
  if (row.degraded || row.failedMessageCount > 0) { return 'degraded'; }
  return 'healthy';
}

function earliestTimestamp(current: string | undefined, candidate: string): string {
  return current === undefined || lexicographicalCompare(candidate, current) < 0 ? candidate : current;
}

function latestTimestamp(current: string | undefined, candidate: string): string {
  return current === undefined || lexicographicalCompare(candidate, current) > 0 ? candidate : current;
}
