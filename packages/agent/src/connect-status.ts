import type { ConnectSessionMetadata } from './types/dwn.js';
import type { PermissionGrantEntry, PermissionsApi } from './types/permissions.js';

import { Time } from '@enbox/dwn-sdk-js';

/** Lifecycle state of the newest delegated connect approval. */
export type ConnectionState =
  | 'active'
  | 'expiring-soon'
  | 'expired'
  | 'revoked'
  | 'none';

/** Status of the current delegated connect approval. */
export type ConnectionStatus = {
  state: ConnectionState;
  connectSessionId?: string;
  connectedDid?: string;
  delegateDid?: string;
  /** Earliest enforcing `dateExpires` among the session's grants. */
  expiresAt?: string;
  secondsUntilExpiry?: number;
};

/** Minimal grant shape consumed by {@link computeConnectionStatus}. */
export type ConnectionStatusGrant = {
  id: string;
  grantor: string;
  grantee: string;
  dateExpires: string;
  connectSession?: ConnectSessionMetadata;
  revoked?: boolean;
};

/** Options for the pure connection-status computation. */
export type ComputeConnectionStatusOptions = {
  /**
   * Seconds before expiry at which the state becomes `expiring-soon`.
   * Defaults to the smaller of one hour or 10% of the approval lifetime.
   */
  expiringSoonThresholdSeconds?: number;
  /** DWN timestamp used as the clock. Defaults to the current time. */
  now?: string;
};

/** Options for fetching the current delegated connection status. */
export type GetConnectionStatusOptions = Omit<ComputeConnectionStatusOptions, 'now'> & {
  /** Check revocations visible in the connected identity's local partition. Defaults to `true`. */
  checkRevoked?: boolean;
};

const MAX_DEFAULT_EXPIRING_SOON_THRESHOLD_SECONDS = 60 * 60;
const DEFAULT_EXPIRING_SOON_LIFETIME_RATIO = 0.1;

type ConnectionSessionGroup = {
  id: string;
  createdAt: string;
  grants: ConnectionStatusGrant[];
};

/**
 * Reconciles owner- and delegate-partition grant copies before status is
 * computed. A session is admitted only when both partitions contain the same
 * complete set of user-facing grant IDs. Owner-active IDs then mark which of
 * those enforcing grants have a locally-visible revocation.
 */
export function reconcileConnectionStatusGrants(params: {
  ownerGrants: ConnectionStatusGrant[];
  delegateGrants: ConnectionStatusGrant[];
  activeOwnerGrantIds?: ReadonlySet<string>;
}): ConnectionStatusGrant[] {
  const ownerGrantIds = collectSessionGrantIds(params.ownerGrants);
  const delegateGrantIds = collectSessionGrantIds(params.delegateGrants);
  const completeSessionIds = new Set<string>();

  for (const [sessionId, ownerIds] of ownerGrantIds) {
    const delegateIds = delegateGrantIds.get(sessionId);
    if (delegateIds !== undefined && setsEqual(ownerIds, delegateIds)) {
      completeSessionIds.add(sessionId);
    }
  }

  return params.ownerGrants
    .filter(grant => grant.connectSession !== undefined && completeSessionIds.has(grant.connectSession.id))
    .map(grant => ({
      ...grant,
      revoked: params.activeOwnerGrantIds === undefined
        ? false
        : !params.activeOwnerGrantIds.has(grant.id),
    }));
}

/**
 * Computes the lifecycle state of the newest connect approval represented by
 * a collection of grants.
 *
 * The newest approval is selected by `connectSession.createdAt`. Its enforcing
 * expiry is the earliest grant `dateExpires`; `connectSession.expiresAt` is
 * display metadata and is deliberately not used for authorization status.
 */
export function computeConnectionStatus(
  grants: ConnectionStatusGrant[],
  options: ComputeConnectionStatusOptions = {},
): ConnectionStatus {
  const { threshold, nowMs } = resolveStatusTimestamps(options);

  const groups = groupGrantsBySession(grants);
  const newest = findNewestSessionGroup(groups);

  if (newest === undefined) {
    return { state: 'none' };
  }

  return deriveConnectionStatusFromGroup(newest, nowMs, threshold);
}

/**
 * Fetches the owner- and delegate-partition grant copies for one connected
 * identity and computes its connection lifecycle state. Revocation detection
 * is best-effort and reflects revocation records that have reached the local
 * agent.
 */
export async function fetchConnectionStatus(input: {
  connectedDid: string;
  delegateDid: string;
  options?: GetConnectionStatusOptions;
  permissions: Pick<PermissionsApi, 'fetchGrants'>;
}): Promise<ConnectionStatus> {
  const { connectedDid, delegateDid, permissions } = input;
  const options = input.options ?? {};

  const query = {
    author  : delegateDid,
    grantor : connectedDid,
    grantee : delegateDid,
  };
  const [ownerGrantEntries, activeOwnerGrantEntries, delegateGrantEntries] = await Promise.all([
    permissions.fetchGrants({ ...query, target: connectedDid }),
    options.checkRevoked === false
      ? Promise.resolve(undefined)
      : permissions.fetchGrants({ ...query, target: connectedDid, checkRevoked: true }),
    permissions.fetchGrants({ ...query, target: delegateDid }),
  ]);
  const activeOwnerGrantIds = activeOwnerGrantEntries === undefined
    ? undefined
    : new Set<string>(activeOwnerGrantEntries.map(({ grant }) => grant.id));
  const toStatusGrant = ({ grant }: PermissionGrantEntry): ConnectionStatusGrant => ({
    id             : grant.id,
    grantor        : grant.grantor,
    grantee        : grant.grantee,
    dateExpires    : grant.dateExpires,
    connectSession : grant.connectSession,
  });
  const grants = reconcileConnectionStatusGrants({
    ownerGrants    : ownerGrantEntries.map(toStatusGrant),
    delegateGrants : delegateGrantEntries.map(toStatusGrant),
    activeOwnerGrantIds,
  });

  return computeConnectionStatus(grants, {
    expiringSoonThresholdSeconds: options.expiringSoonThresholdSeconds,
  });
}

/**
 * Resolve and validate the expiring-soon threshold and "current time" inputs
 * used by {@link computeConnectionStatus}.
 */
function resolveStatusTimestamps(
  options: ComputeConnectionStatusOptions,
): { threshold?: number; nowMs: number } {
  const threshold = options.expiringSoonThresholdSeconds;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0)) {
    throw new RangeError('Connection status expiry threshold must be a non-negative finite number.');
  }

  const now = options.now ?? Time.getCurrentTimestamp();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`Connection status received an invalid current timestamp: ${now}`);
  }

  return { threshold, nowMs };
}

/** Group grants by their `connectSession.id`, tracking each group's newest `createdAt`. */
function groupGrantsBySession(grants: ConnectionStatusGrant[]): Map<string, ConnectionSessionGroup> {
  const groups = new Map<string, ConnectionSessionGroup>();
  for (const grant of grants) {
    const session = grant.connectSession;
    if (session === undefined) {
      continue;
    }

    const existing = groups.get(session.id);
    if (existing === undefined) {
      groups.set(session.id, {
        id        : session.id,
        createdAt : session.createdAt,
        grants    : [grant],
      });
    } else {
      existing.grants.push(grant);
      if (session.createdAt > existing.createdAt) {
        existing.createdAt = session.createdAt;
      }
    }
  }
  return groups;
}

/** Select the newest session group, breaking `createdAt` ties by the higher session id. */
function findNewestSessionGroup(
  groups: Map<string, ConnectionSessionGroup>,
): ConnectionSessionGroup | undefined {
  let newest: ConnectionSessionGroup | undefined;
  for (const group of groups.values()) {
    if (newest === undefined || group.createdAt > newest.createdAt ||
      (group.createdAt === newest.createdAt && group.id > newest.id)) {
      newest = group;
    }
  }
  return newest;
}

/** Derive the final `ConnectionStatus` from the newest session group. */
function deriveConnectionStatusFromGroup(
  newest: ConnectionSessionGroup,
  nowMs: number,
  threshold: number | undefined,
): ConnectionStatus {
  const expiresAt = newest.grants.reduce(
    (earliest, grant) => grant.dateExpires < earliest ? grant.dateExpires : earliest,
    newest.grants[0].dateExpires,
  );
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new RangeError(`Connection status received an invalid grant expiry timestamp: ${expiresAt}`);
  }

  const createdAtMs = Date.parse(newest.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw new RangeError(`Connection status received an invalid session creation timestamp: ${newest.createdAt}`);
  }
  const effectiveThreshold = threshold ?? Math.min(
    MAX_DEFAULT_EXPIRING_SOON_THRESHOLD_SECONDS,
    Math.max(0, (expiresAtMs - createdAtMs) / 1000 * DEFAULT_EXPIRING_SOON_LIFETIME_RATIO),
  );

  const firstGrant = newest.grants[0];
  const secondsUntilExpiry = (expiresAtMs - nowMs) / 1000;
  let state: ConnectionStatus['state'];
  if (newest.grants.some(grant => grant.revoked === true)) {
    state = 'revoked';
  } else if (secondsUntilExpiry <= 0) {
    state = 'expired';
  } else if (secondsUntilExpiry <= effectiveThreshold) {
    state = 'expiring-soon';
  } else {
    state = 'active';
  }

  return {
    state,
    connectSessionId : newest.id,
    connectedDid     : firstGrant.grantor,
    delegateDid      : firstGrant.grantee,
    expiresAt,
    secondsUntilExpiry,
  };
}

function collectSessionGrantIds(grants: ConnectionStatusGrant[]): Map<string, Set<string>> {
  const grantIds = new Map<string, Set<string>>();
  for (const grant of grants) {
    if (grant.connectSession === undefined) {
      continue;
    }

    let sessionGrantIds = grantIds.get(grant.connectSession.id);
    if (sessionGrantIds === undefined) {
      sessionGrantIds = new Set<string>();
      grantIds.set(grant.connectSession.id, sessionGrantIds);
    }
    sessionGrantIds.add(grant.id);
  }
  return grantIds;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}
