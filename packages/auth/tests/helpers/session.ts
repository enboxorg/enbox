import type { RevocationEntry } from '../../src/connect/session-state.js';
import type { StorageAdapter } from '../../src/types.js';

import { STORAGE_KEYS } from '../../src/types.js';

/** Persist one complete auth-session fixture. */
export async function setStoredSession(
  storage: StorageAdapter,
  connectedDid: string,
  delegateDid?: string,
  revocations: RevocationEntry[] = [],
): Promise<void> {
  await storage.set(STORAGE_KEYS.SESSION, JSON.stringify({ connectedDid, delegateDid, revocations }));
}
