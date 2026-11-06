import type { RevocationEntry } from '../../src/connect/session-state.js';
import type { StorageAdapter } from '../../src/types.js';

import { AUTH_SESSION_STORAGE_FORMAT } from '../../src/connect/session-state.js';
import { STORAGE_KEYS } from '../../src/types.js';

/** Persist one complete auth-session fixture. */
export async function setStoredSession(
  storage: StorageAdapter,
  connectedDid: string,
  delegateDid?: string,
  revocations: RevocationEntry[] = [],
): Promise<void> {
  await storage.set(STORAGE_KEYS.SESSION_FORMAT, AUTH_SESSION_STORAGE_FORMAT);
  await storage.set(STORAGE_KEYS.SESSION, JSON.stringify({ connectedDid, delegateDid, revocations }));
}

/** Persist a retry-journal fixture in the current auth storage format. */
export async function setStoredRetryContext(storage: StorageAdapter, json: string): Promise<void> {
  await storage.set(STORAGE_KEYS.SESSION_FORMAT, AUTH_SESSION_STORAGE_FORMAT);
  await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, json);
}
