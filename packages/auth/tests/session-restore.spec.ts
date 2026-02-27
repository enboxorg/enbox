import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { restoreSession } from '../src/flows/session-restore.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

describe('restoreSession', () => {
  test('returns undefined when no previous session exists', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const agent = createMockAgent();

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeUndefined();
  });

  test('returns undefined when vault does not exist (stale flag)', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

    const agent = createMockAgent({ firstLaunch: async () => true });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeUndefined();

    // Stale flag should be cleaned up
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
  });

  test('returns undefined when no identity found', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityGet               : async () => undefined,
      identityList              : async () => [],
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeUndefined();

    // All session data should be cleaned up
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBeNull();
  });

  test('restores session from connected identity', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

    const identity = createMockIdentity({
      metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => identity,
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.did).toBe('did:dht:external');
    expect(session!.delegateDid).toBe('did:dht:testuser123');
  });

  test('restores session from active identity DID', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:specific');

    const identity = createMockIdentity({
      did: { uri: 'did:dht:specific' },
    });

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityGet               : async (params: any) => {
        if (params.didUri === 'did:dht:specific') { return identity; }
        return undefined;
      },
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.did).toBe('did:dht:specific');
  });

  test('falls back to first identity when active identity not found', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:missing');

    const identity = createMockIdentity();

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityGet               : async () => undefined,
      identityList              : async () => [identity],
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.did).toBe('did:dht:testuser123');
  });

  test('emits vault-unlocked and session-start events', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const events: string[] = [];

    emitter.on('vault-unlocked', () => { events.push('vault-unlocked'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({ firstLaunch: async () => false });

    await restoreSession({ userAgent: agent, emitter, storage });

    expect(events).toEqual(['vault-unlocked', 'session-start']);
  });

  test('uses insecure default password when none provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const startCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch : async () => false,
      start       : async (params) => { startCalls.push(params); },
    });

    await restoreSession({ userAgent: agent, emitter, storage });

    expect(startCalls[0].password).toBe('insecure-static-phrase');
  });

  test('uses stored delegate DID for non-connected identities', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:dht:storeddelegate');

    const identity = createMockIdentity();

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityList              : async () => [identity],
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.delegateDid).toBe('did:dht:storeddelegate');
  });

  test('starts sync in poll mode when interval is set', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch   : async () => false,
      syncStartSync : async (params) => { syncCalls.push(params); },
    });

    await restoreSession({ userAgent: agent, emitter, storage, defaultSync: '30s' });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].mode).toBe('poll');
    expect(syncCalls[0].interval).toBe('30s');
  });

  test('skips sync when sync is off', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch   : async () => false,
      syncStartSync : async (params) => { syncCalls.push(params); },
    });

    await restoreSession({ userAgent: agent, emitter, storage, defaultSync: 'off' });

    expect(syncCalls).toHaveLength(0);
  });
});
