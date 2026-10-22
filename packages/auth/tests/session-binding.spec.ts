import type { RevocationEntry } from '../src/connect/session-state.js';
import type { EnboxUserAgent, PortableIdentity } from '@enbox/agent';

import { describe, expect, spyOn, test } from 'bun:test';

import { AuthManager } from '../src/auth-manager.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { retryOrphanedRevocations } from '../src/connect/restore.js';
import { setStoredSession } from './helpers/session.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { persistSessionBinding, readPersistedSession } from '../src/connect/session-state.js';

const OWNER_A = 'did:dht:owner-a';
const DELEGATE_A = 'did:dht:delegate-a';
const OWNER_B = 'did:dht:owner-b';
const DELEGATE_B = 'did:dht:delegate-b';
const REVOCATIONS_A = [{ grantId: 'grant-a', revocationGrantId: 'revoker-a' }];

async function seedDelegate(storage: MemoryStorage): Promise<void> {
  await setStoredSession(storage, OWNER_A, DELEGATE_A, REVOCATIONS_A);
}

function portableIdentity(didUri: string, connectedDid?: string): PortableIdentity {
  return {
    portableDid : { uri: didUri, document: { id: didUri }, metadata: {}, privateKeys: [] },
    metadata    : { uri: didUri, name: 'Imported', tenant: 'did:dht:testagent', connectedDid },
  };
}

function replacementAgent(delegate: boolean, removed: unknown[][] = []): EnboxUserAgent {
  const previous = createMockIdentity({
    did      : { uri: DELEGATE_A },
    metadata : { name: 'Previous', tenant: 'did:dht:testagent', connectedDid: OWNER_A },
  });
  const imported = createMockIdentity({
    did      : { uri: delegate ? DELEGATE_B : OWNER_B },
    metadata : { name: 'Imported', tenant: 'did:dht:testagent', connectedDid: delegate ? OWNER_B : undefined },
  });
  const identities = [previous];
  const agent = createMockAgent({
    dwnIsRemoteMode : true,
    identityList    : async () => identities,
    identityImport  : async () => { identities.push(imported); return imported; },
    identityDelete  : async ({ didUri }) => {
      const index = identities.findIndex(identity => identity.did.uri === didUri);
      if (index !== -1) {
        identities.splice(index, 1);
      }
    },
    syncRemoveIdentity: async (...args) => { removed.push(args); },
  });
  // Neither provider is reachable, so old revocations must remain durable.
  agent.dwn.getRemoteDwnEndpointUrls = async (): Promise<string[]> => [];
  return agent;
}

async function managerFor(agent: EnboxUserAgent, storage: MemoryStorage): Promise<AuthManager> {
  return AuthManager.create({ agent, storage, password: 'test', sync: 'off' });
}

describe('persisted session binding', () => {
  test('restores an imported owner while retaining the previous delegate revocations under their original binding', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const removed: unknown[][] = [];
    const agent = replacementAgent(false, removed);
    const deleteDid = spyOn(agent.did, 'delete');
    const manager = await managerFor(agent, storage);
    await manager.restoreSession();
    expect((await readPersistedSession(storage))?.revocations).toEqual(REVOCATIONS_A);
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();

    await manager.importFromPortable({ portableIdentity: portableIdentity(OWNER_B) });

    expect(await readPersistedSession(storage)).toEqual({ connectedDid: OWNER_B, revocations: [] });
    expect(JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!)).toEqual([{
      delegateDid: DELEGATE_A, connectedDid: OWNER_A, revocations: REVOCATIONS_A,
    }]);
    expect(removed).toContainEqual([OWNER_A, { expectedDelegateDid: DELEGATE_A }]);
    await manager.shutdown();

    const restarted = await managerFor(agent, storage);
    const restored = await restarted.restoreSession();
    expect(restored?.did).toBe(OWNER_B);
    expect(restored?.delegateDid).toBeUndefined();
    expect(await agent.identity.get({ didUri: DELEGATE_A })).toBeDefined();
    expect(deleteDid).not.toHaveBeenCalled();
    await restarted.shutdown();
  });

  test('persists an imported delegate binding without attaching the previous delegate revocations to it', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const manager = await managerFor(replacementAgent(true), storage);
    await manager.restoreSession();

    await manager.importFromPortable({ portableIdentity: portableIdentity(DELEGATE_B, OWNER_B) });

    expect((await readPersistedSession(storage))?.delegateDid).toBe(DELEGATE_B);
    expect((await readPersistedSession(storage))?.connectedDid).toBe(OWNER_B);
    await manager.disconnect();
    expect(JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!)).toEqual([{
      delegateDid: DELEGATE_A, connectedDid: OWNER_A, revocations: REVOCATIONS_A,
    }]);
    await manager.shutdown();
  });

  test('does not commit a replacement binding when removing the previous sync registration fails', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const agent = replacementAgent(false);
    const manager = await managerFor(agent, storage);
    await manager.restoreSession();
    agent.sync.removeIdentity = async (): Promise<void> => { throw new Error('sync storage unavailable'); };

    await expect(manager.importFromPortable({ portableIdentity: portableIdentity(OWNER_B) })).rejects.toThrow('sync storage unavailable');

    expect((await readPersistedSession(storage))?.connectedDid).toBe(OWNER_A);
    expect((await readPersistedSession(storage))?.revocations).toEqual(REVOCATIONS_A);
    await manager.shutdown();
  });

  test('rejects sparse approval revocations before changing the previous session or retry journal', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const originalSession = await storage.get(STORAGE_KEYS.SESSION);
    const removed: unknown[][] = [];

    await expect(persistSessionBinding({
      userAgent          : replacementAgent(true, removed), storage, connectedDid       : OWNER_B, delegateDid        : DELEGATE_B,
      sessionRevocations : new Array<RevocationEntry>(1),
    })).rejects.toThrow('Persisted session is invalid');

    expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(originalSession);
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(removed).toEqual([]);
  });

  test('preserves the complete previous session record when the atomic replacement write fails', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const originalSession = await storage.get(STORAGE_KEYS.SESSION);
    const agent = replacementAgent(true);
    const set = storage.set.bind(storage);
    storage.set = async (key: string, value: string): Promise<void> => {
      if (key === STORAGE_KEYS.SESSION) {
        throw new Error('session storage unavailable');
      }
      await set(key, value);
    };

    await expect(persistSessionBinding({
      userAgent          : agent, storage, connectedDid       : OWNER_B, delegateDid        : DELEGATE_B,
      sessionRevocations : [{ grantId: 'grant-b', revocationGrantId: 'revoker-b' }],
    })).rejects.toThrow('session storage unavailable');

    expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(originalSession);
    storage.set = set;
    await persistSessionBinding({ userAgent: agent, storage, connectedDid: 'did:dht:owner-c' });
    expect(JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!)).toEqual([{
      delegateDid: DELEGATE_A, connectedDid: OWNER_A, revocations: REVOCATIONS_A,
    }]);
  });

  test('preserves a fresh approval while retrying older grants for the same delegate', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const agent = replacementAgent(true);
    const deleteDid = spyOn(agent.did, 'delete');
    const set = storage.set.bind(storage);
    storage.set = async (key: string, value: string): Promise<void> => {
      if (key === STORAGE_KEYS.SESSION) {
        throw new Error('session storage unavailable');
      }
      await set(key, value);
    };

    await expect(persistSessionBinding({
      userAgent    : agent,
      storage,
      connectedDid : OWNER_B,
      delegateDid  : DELEGATE_B,
    })).rejects.toThrow('session storage unavailable');

    storage.set = set;
    const freshRevocations = [{ grantId: 'fresh-grant', revocationGrantId: 'fresh-revoker' }];
    await persistSessionBinding({
      userAgent          : agent,
      storage,
      connectedDid       : OWNER_A,
      delegateDid        : DELEGATE_A,
      sessionRevocations : freshRevocations,
    });
    const freshSession = await storage.get(STORAGE_KEYS.SESSION);
    const pendingJournal = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    expect(JSON.parse(pendingJournal!)).toEqual([{
      connectedDid: OWNER_A, delegateDid: DELEGATE_A, revocations: REVOCATIONS_A,
    }]);

    await retryOrphanedRevocations(agent, storage);

    expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(freshSession);
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBe(pendingJournal);
    expect(await agent.identity.get({ didUri: DELEGATE_A })).toBeDefined();
    expect(deleteDid).not.toHaveBeenCalled();

    const restarted = await managerFor(agent, storage);
    try {
      await restarted.disconnect();
      expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(freshSession);
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBe(pendingJournal);

      const restored = await restarted.restoreSession();
      expect(restored?.did).toBe(OWNER_A);
      expect(restored?.delegateDid).toBe(DELEGATE_A);
      expect((await readPersistedSession(storage))?.revocations).toEqual(freshRevocations);
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBe(pendingJournal);
      expect(await agent.identity.get({ didUri: DELEGATE_A })).toBeDefined();
      expect(deleteDid).not.toHaveBeenCalled();
    } finally {
      await restarted.shutdown();
    }
  });

  test('a stale manager disconnect preserves the replacement session and its revocation ownership', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const agent = replacementAgent(true);
    const stale = await managerFor(agent, storage);
    await stale.restoreSession();
    const replacement = {
      connectedDid : OWNER_B, delegateDid  : DELEGATE_B,
      revocations  : [{ grantId: 'grant-b', revocationGrantId: 'revoker-b' }],
    };
    await persistSessionBinding({
      userAgent          : agent, storage, connectedDid       : OWNER_B, delegateDid        : DELEGATE_B,
      sessionRevocations : replacement.revocations,
    });

    await stale.disconnect();

    expect(await readPersistedSession(storage)).toEqual(replacement);
    expect(JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!)).toEqual([{
      delegateDid: DELEGATE_A, connectedDid: OWNER_A, revocations: REVOCATIONS_A,
    }]);
    await stale.shutdown();
  });

  test('a manager without a session cannot disconnect a persisted session from another context', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const manager = await managerFor(replacementAgent(false), storage);
    const originalSession = await storage.get(STORAGE_KEYS.SESSION);

    await manager.disconnect();

    expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(originalSession);
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    await manager.shutdown();
  });

  test('retains the valid retry journal and restore marker when a new entry would exceed aggregate bounds', async () => {
    const storage = new MemoryStorage();
    await seedDelegate(storage);
    const previousJournal = JSON.stringify([{
      delegateDid  : 'did:dht:older-delegate',
      connectedDid : 'did:dht:older-owner',
      revocations  : Array.from({ length: 4_096 }, (_, index) => ({ grantId: `grant-${index}`, revocationGrantId: `revoker-${index}` })),
    }]);
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, previousJournal);
    const manager = await managerFor(replacementAgent(false), storage);
    await manager.restoreSession();

    await expect(manager.disconnect()).rejects.toThrow('Revocation retry context is too large');

    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBe(previousJournal);
    expect(await readPersistedSession(storage)).not.toBeNull();
    expect((await readPersistedSession(storage))?.revocations).toEqual(REVOCATIONS_A);
    await manager.shutdown();
  });
});
