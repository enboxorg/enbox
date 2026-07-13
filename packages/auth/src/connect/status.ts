import type {
  ComputeConnectionStatusOptions,
  ConnectionStatus,
  ConnectionStatusGrant,
} from '../types.js';

import { DwnErrorCode, Time } from '@enbox/dwn-sdk-js';

/** DWN error code emitted when an invoked permission grant has expired. */
export const SESSION_EXPIRED_ERROR_CODE = DwnErrorCode.GrantAuthorizationGrantExpired;

/** DWN error code emitted when an invoked permission grant has been revoked. */
export const SESSION_REVOKED_ERROR_CODE = DwnErrorCode.GrantAuthorizationGrantRevoked;

const DEFAULT_EXPIRING_SOON_THRESHOLD_SECONDS = 60 * 60;

type ConnectionSessionGroup = {
  id: string;
  createdAt: string;
  grants: ConnectionStatusGrant[];
};

type NormalizedDwnError = {
  code?: number;
  detail: string;
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
  const threshold = options.expiringSoonThresholdSeconds ?? DEFAULT_EXPIRING_SOON_THRESHOLD_SECONDS;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError('Connection status expiry threshold must be a non-negative finite number.');
  }

  const now = options.now ?? Time.getCurrentTimestamp();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`Connection status received an invalid current timestamp: ${now}`);
  }

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

  let newest: ConnectionSessionGroup | undefined;
  for (const group of groups.values()) {
    if (newest === undefined || group.createdAt > newest.createdAt ||
      (group.createdAt === newest.createdAt && group.id > newest.id)) {
      newest = group;
    }
  }

  if (newest === undefined) {
    return { state: 'none' };
  }

  const expiresAt = newest.grants.reduce(
    (earliest, grant) => grant.dateExpires < earliest ? grant.dateExpires : earliest,
    newest.grants[0].dateExpires,
  );
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new RangeError(`Connection status received an invalid grant expiry timestamp: ${expiresAt}`);
  }

  const firstGrant = newest.grants[0];
  const secondsUntilExpiry = (expiresAtMs - nowMs) / 1000;
  let state: ConnectionStatus['state'];
  if (newest.grants.some(grant => grant.revoked === true)) {
    state = 'revoked';
  } else if (secondsUntilExpiry <= 0) {
    state = 'expired';
  } else if (secondsUntilExpiry <= threshold) {
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

/** Returns whether a DWN result or error reports an expired session grant. */
export function isSessionExpiredError(input: unknown): boolean {
  return matchesSessionError(input, SESSION_EXPIRED_ERROR_CODE);
}

/** Returns whether a DWN result or error reports an expired or revoked session grant. */
export function isSessionInvalidError(input: unknown): boolean {
  return isSessionExpiredError(input) || matchesSessionError(input, SESSION_REVOKED_ERROR_CODE);
}

function matchesSessionError(input: unknown, errorCode: string): boolean {
  const normalized = normalizeDwnError(input);
  if (normalized === undefined || (normalized.code !== undefined && normalized.code !== 401)) {
    return false;
  }

  return normalized.detail.startsWith(errorCode);
}

function normalizeDwnError(input: unknown): NormalizedDwnError | undefined {
  if (input instanceof Error) {
    return normalizeErrorText(input.message);
  }
  if (typeof input === 'string') {
    return normalizeErrorText(input);
  }
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.code === 'number' && typeof record.detail === 'string') {
    return { code: record.code, detail: record.detail };
  }
  if (record.status !== undefined) {
    return normalizeDwnError(record.status);
  }
  if (record.reply !== undefined) {
    return normalizeDwnError(record.reply);
  }

  return undefined;
}

function normalizeErrorText(text: string): NormalizedDwnError {
  const statusPrefix = /^\s*(\d{3})(?:(?:\s*[:-]\s*)|\s+)([^]*)$/.exec(text);
  if (statusPrefix === null) {
    return { detail: text.trim() };
  }

  return {
    code   : Number(statusPrefix[1]),
    detail : statusPrefix[2].trim(),
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
