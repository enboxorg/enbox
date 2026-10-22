/** Persistence of auth sessions and their durable revocation journal. */

import type { EnboxUserAgent } from '@enbox/agent';
import type { StorageAdapter } from '../types.js';

import { STORAGE_KEYS } from '../types.js';

/** One atomic record binds restoration and revocations to their owning DIDs. */
export type PersistedSession = {
  connectedDid: string;
  delegateDid?: string;
  revocations: RevocationEntry[];
};

export async function readPersistedSession(storage: StorageAdapter): Promise<PersistedSession | null> {
  const json = await storage.get(STORAGE_KEYS.SESSION);
  return json === null ? null : parsePersistedSession(json);
}

function parsePersistedSession(json: string): PersistedSession {
  try {
    const session: unknown = JSON.parse(json);
    validatePersistedSession(session);
    return session;
  } catch (error: unknown) {
    throw new Error('AuthManager: Persisted session is invalid.', { cause: error });
  }
}

function validatePersistedSession(session: unknown): asserts session is PersistedSession {
  if (!isRecord(session) || !isNonEmptyString(session.connectedDid) ||
      (session.delegateDid !== undefined && !isNonEmptyString(session.delegateDid)) ||
      !isSessionRevocations(session.revocations) ||
      (session.delegateDid === undefined && session.revocations.length > 0)) {
    throw new Error('AuthManager: Persisted session is invalid.');
  }
}

export function hasSessionBinding(
  session: PersistedSession | null,
  connectedDid: string | undefined,
  delegateDid: string | undefined,
): boolean {
  return session !== null && session.connectedDid === connectedDid && session.delegateDid === delegateDid;
}

/**
 * Commit a complete session under the auth-session lifecycle lock.
 * A replaced delegate retains its original revocation binding and signing keys until retry settles.
 */
export async function persistSessionBinding(params: {
  userAgent: EnboxUserAgent;
  storage: StorageAdapter;
  connectedDid: string;
  delegateDid?: string;
  /** An approval replaces this map. Omission preserves a matching session's map. */
  sessionRevocations?: RevocationEntry[];
}): Promise<void> {
  const { userAgent, storage, connectedDid, delegateDid, sessionRevocations } = params;
  const previous = await readPersistedSession(storage);
  const sameBinding = hasSessionBinding(previous, connectedDid, delegateDid);
  const session: PersistedSession = {
    connectedDid,
    delegateDid,
    revocations: sessionRevocations ?? (sameBinding && previous !== null ? previous.revocations : []),
  };
  validatePersistedSession(session);

  if (previous?.delegateDid !== undefined && !sameBinding) {
    if (previous.revocations.length > 0) {
      await stageRevocationRetryEntry(storage, await readRevocationRetryEntries(storage), {
        connectedDid : previous.connectedDid,
        delegateDid  : previous.delegateDid,
        revocations  : previous.revocations,
      });
    }
    // The new approval may already have installed another delegate for this owner.
    await userAgent.sync.removeIdentity(previous.connectedDid, { expectedDelegateDid: previous.delegateDid });
  }

  await storage.set(STORAGE_KEYS.SESSION, JSON.stringify(session));
}

export type RevocationEntry = { grantId: string; revocationGrantId: string };

export type RetryEntry = {
  delegateDid: string;
  connectedDid: string;
  revocations: RevocationEntry[];
};

const MAX_REVOCATION_RETRY_ENTRIES = 4_096;

/**
 * Load and validate all durable retry entries. Invalid state is retained and
 * rejected so callers never mistake an unreadable journal for completed work.
 */
export async function readRevocationRetryEntries(
  storage: StorageAdapter,
): Promise<RetryEntry[]> {
  const json = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  if (json === null) {
    return [];
  }

  return parseRevocationRetryEntries(json);
}

export function parseRevocationRetryEntries(json: string): RetryEntry[] {
  try {
    const entries: unknown = JSON.parse(json);
    validateRevocationRetryEntries(entries);
    return entries;
  } catch (error: unknown) {
    throw new Error('AuthManager: Revocation retry context is invalid.', { cause: error });
  }
}

function validateRevocationRetryEntries(entries: unknown): asserts entries is RetryEntry[] {
  if (!Array.isArray(entries) || entries.length > MAX_REVOCATION_RETRY_ENTRIES || !entries.every(isRetryEntry)) {
    throw new Error('invalid retry entries');
  }
  const delegateDids = new Set<string>();
  let revocationCount = 0;
  for (const entry of entries) {
    revocationCount += entry.revocations.length;
    if (delegateDids.has(entry.delegateDid)) {
      throw new Error('duplicate delegate retry entry');
    }
    if (revocationCount > MAX_REVOCATION_RETRY_ENTRIES) {
      throw new Error('AuthManager: Revocation retry context is too large.');
    }
    delegateDids.add(entry.delegateDid);
  }
}

/** Durably merge an active session's complete revocation set before any attempt. */
export async function stageRevocationRetryEntry(
  storage: StorageAdapter,
  entries: RetryEntry[],
  entry: RetryEntry,
): Promise<RetryEntry[]> {
  if (!isRetryEntry(entry)) {
    throw new Error('AuthManager: Session revocation binding is invalid.');
  }
  const existing = entries.find(candidate => candidate.delegateDid === entry.delegateDid);
  if (existing !== undefined && existing.connectedDid !== entry.connectedDid) {
    throw new Error('AuthManager: Revocation retry binding is inconsistent.');
  }
  const revocations = mergeRevocations(existing?.revocations ?? [], entry.revocations);
  if (revocations.length === existing?.revocations.length) {
    return entries;
  }
  const staged = entries.filter(candidate => candidate.delegateDid !== entry.delegateDid);
  staged.push({ ...entry, revocations });
  validateRevocationRetryEntries(staged);
  await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(staged));
  return staged;
}

function isRetryEntry(value: unknown): value is RetryEntry {
  return isRecord(value) && isNonEmptyString(value.delegateDid) && isNonEmptyString(value.connectedDid) &&
    isSessionRevocations(value.revocations) && value.revocations.length > 0;
}

function isSessionRevocations(value: unknown): value is RevocationEntry[] {
  return Array.isArray(value) && value.length <= MAX_REVOCATION_RETRY_ENTRIES &&
    Array.from(value).every(isRevocationEntry) && hasUniqueRevocations(value);
}

function isRevocationEntry(value: unknown): value is RevocationEntry {
  return isRecord(value) && isNonEmptyString(value.grantId) && isNonEmptyString(value.revocationGrantId);
}

function hasUniqueRevocations(entries: RevocationEntry[]): boolean {
  return new Set(entries.map(entry => entry.grantId)).size === entries.length &&
    new Set(entries.map(entry => entry.revocationGrantId)).size === entries.length;
}

function mergeRevocations(left: RevocationEntry[], right: RevocationEntry[]): RevocationEntry[] {
  const merged = [...left];
  for (const revocation of right) {
    const sameGrant = merged.find(entry => entry.grantId === revocation.grantId);
    const sameRevocationGrant = merged.find(entry => entry.revocationGrantId === revocation.revocationGrantId);
    if ((sameGrant !== undefined && sameGrant.revocationGrantId !== revocation.revocationGrantId) ||
        (sameRevocationGrant !== undefined && sameRevocationGrant.grantId !== revocation.grantId)) {
      throw new Error('AuthManager: Revocation retry mapping is inconsistent.');
    }
    if (sameGrant === undefined) {
      merged.push(revocation);
    }
  }
  if (merged.length > MAX_REVOCATION_RETRY_ENTRIES) {
    throw new Error('AuthManager: Revocation retry context is too large.');
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048;
}
