import type { EnboxUserAgent } from '@enbox/agent';

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import {
  AUTH_SESSION_STORAGE_FORMAT,
  persistSessionBinding,
  readPersistedSession,
  readRevocationRetryEntries,
  stageRevocationRetryEntry,
} from '../src/connect/session-state.js';

describe('auth session format boundary', () => {
  it('rejects an old session without modifying its stored state', async () => {
    const storage = new MemoryStorage();
    const previous = JSON.stringify({ connectedDid: 'did:example:owner', revocations: [] });
    await storage.set(STORAGE_KEYS.SESSION, previous);

    await expect(readPersistedSession(storage)).rejects.toThrow('unsupported format');
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(previous);
    expect(await storage.get(STORAGE_KEYS.SESSION_FORMAT)).toBeNull();
  });

  it('rejects an orphaned old revocation journal before restore or retry', async () => {
    const storage = new MemoryStorage();
    const previous = JSON.stringify([{
      connectedDid : 'did:example:owner',
      delegateDid  : 'did:example:delegate',
      revocations  : [{ grantId: 'grant', revocationGrantId: 'revocation-grant' }],
    }]);
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, previous);

    await expect(readPersistedSession(storage)).rejects.toThrow('unsupported format');
    await expect(readRevocationRetryEntries(storage)).rejects.toThrow('unsupported format');
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBe(previous);
  });

  it('rejects an unknown format even when no session remains', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.SESSION_FORMAT, 'unknown');

    await expect(readPersistedSession(storage)).rejects.toThrow('unsupported format');
    await expect(readRevocationRetryEntries(storage)).rejects.toThrow('unsupported format');
  });

  it('reads an empty fresh store without marking it initialized', async () => {
    const storage = new MemoryStorage();

    expect(await readPersistedSession(storage)).toBeNull();
    expect(await readRevocationRetryEntries(storage)).toEqual([]);
    expect(await storage.get(STORAGE_KEYS.SESSION_FORMAT)).toBeNull();
  });

  it('marks a new session before persisting its binding', async () => {
    const storage = new MemoryStorage();
    const userAgent = {} as EnboxUserAgent;

    await persistSessionBinding({ userAgent, storage, connectedDid: 'did:example:owner' });

    expect(await storage.get(STORAGE_KEYS.SESSION_FORMAT)).toBe(AUTH_SESSION_STORAGE_FORMAT);
    expect(await readPersistedSession(storage)).toEqual({ connectedDid: 'did:example:owner', revocations: [] });
  });

  it('does not overwrite old state when establishing a new session', async () => {
    const storage = new MemoryStorage();
    const previous = JSON.stringify({ connectedDid: 'did:example:old-owner', revocations: [] });
    await storage.set(STORAGE_KEYS.SESSION, previous);

    await expect(persistSessionBinding({
      userAgent    : {} as EnboxUserAgent,
      storage,
      connectedDid : 'did:example:new-owner',
    })).rejects.toThrow('unsupported format');
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(previous);
    expect(await storage.get(STORAGE_KEYS.SESSION_FORMAT)).toBeNull();
  });

  it('marks an independently created revocation journal in the new format', async () => {
    const storage = new MemoryStorage();
    const entry = {
      connectedDid : 'did:example:owner',
      delegateDid  : 'did:example:delegate',
      revocations  : [{ grantId: 'grant', revocationGrantId: 'revocation-grant' }],
    };

    await stageRevocationRetryEntry(storage, [], entry);

    expect(await storage.get(STORAGE_KEYS.SESSION_FORMAT)).toBe(AUTH_SESSION_STORAGE_FORMAT);
    expect(await readRevocationRetryEntries(storage)).toEqual([entry]);
  });
});
