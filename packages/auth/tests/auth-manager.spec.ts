import type { Web5UserAgent } from '@enbox/agent';
import { describe, expect, test } from 'bun:test';

import { AuthManager } from '../src/auth-manager.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

/**
 * Construct an AuthManager instance with a pre-built mock agent.
 *
 * We use `Object.create()` + manual assignment to bypass the private
 * constructor and `Web5UserAgent.create()` call, testing orchestration
 * logic in isolation.
 */
function createTestManager(
  agent: Web5UserAgent,
  overrides: {
    storage?: MemoryStorage;
    password?: string;
    sync?: any;
    dwnEndpoints?: string[];
    initialState?: string;
  } = {},
): AuthManager {
  const storage = overrides.storage ?? new MemoryStorage();

  // Use the static create path with a module mock — but that requires
  // mocking Web5UserAgent.create. Instead, craft the instance manually.
  const manager = Object.create(AuthManager.prototype) as any;
  manager._userAgent = agent;
  manager._emitter = new (require('../src/events.js').AuthEventEmitter)();
  manager._storage = storage;
  manager._vault = new (require('../src/vault/vault-manager.js').VaultManager)(agent.vault, manager._emitter);
  manager._session = undefined;
  manager._state = overrides.initialState ?? 'uninitialized';
  manager._isConnecting = false;
  manager._defaultPassword = overrides.password;
  manager._defaultSync = overrides.sync;
  manager._defaultDwnEndpoints = overrides.dwnEndpoints;

  return manager as AuthManager;
}

describe('AuthManager', () => {
  describe('property getters', () => {
    test('state returns current auth state', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'locked' });
      expect(manager.state).toBe('locked');
    });

    test('isConnected returns true when state is connected', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'connected' });
      expect(manager.isConnected).toBe(true);
    });

    test('isConnected returns false when not connected', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      expect(manager.isConnected).toBe(false);
    });

    test('isLocked delegates to vault manager', () => {
      const agent = createMockAgent({ vaultIsLocked: () => true });
      const manager = createTestManager(agent);
      expect(manager.isLocked).toBe(true);
    });

    test('isConnecting returns false initially', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.isConnecting).toBe(false);
    });

    test('session returns undefined when not connected', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.session).toBeUndefined();
    });

    test('vault returns the vault manager', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.vault).toBeDefined();
    });

    test('agent returns the user agent', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.agent).toBe(agent);
    });
  });

  describe('connect()', () => {
    test('calls localConnect and sets state to connected', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      const session = await manager.connect({ password: 'test' });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
      expect(manager.session).toBe(session);
      expect(manager.isConnected).toBe(true);
    });

    test('resets isConnecting after successful connect', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      await manager.connect({ password: 'test' });
      expect(manager.isConnecting).toBe(false);
    });

    test('resets isConnecting after failed connect', async () => {
      const agent = createMockAgent({
        firstLaunch : async () => false,
        start       : async () => { throw new Error('start failed'); },
      });
      const manager = createTestManager(agent);

      try {
        await manager.connect({ password: 'test' });
      } catch { /* expected */ }

      expect(manager.isConnecting).toBe(false);
    });
  });

  describe('concurrency guard', () => {
    test('throws when connect is called concurrently', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        start        : async () => { await new Promise((r) => setTimeout(r, 50)); },
      });
      const manager = createTestManager(agent);

      // Start first connect
      const firstConnect = manager.connect({ password: 'test' });

      // Second connect should throw
      await expect(manager.connect({ password: 'test' })).rejects.toThrow(
        'A connection attempt is already in progress'
      );

      await firstConnect;
    });

    test('throws when restoreSession is called during connect', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        start        : async () => { await new Promise((r) => setTimeout(r, 50)); },
      });
      const manager = createTestManager(agent);

      const firstConnect = manager.connect({ password: 'test' });

      await expect(manager.restoreSession()).rejects.toThrow(
        'A connection attempt is already in progress'
      );

      await firstConnect;
    });
  });

  describe('restoreSession()', () => {
    test('returns undefined when no previous session', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      const session = await manager.restoreSession();
      expect(session).toBeUndefined();
    });

    test('restores session and sets state to connected', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });

      const session = await manager.restoreSession();
      expect(session).toBeDefined();
      expect(manager.state).toBe('connected');
    });
  });

  describe('disconnect()', () => {
    test('clean disconnect removes session markers', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:test');
      await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:delegate');
      await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:connected');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect();

      expect(manager.state).toBe('unlocked');
      expect(manager.session).toBeUndefined();
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
      expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBeNull();
    });

    test('nuclear disconnect clears all storage', async () => {
      const storage = new MemoryStorage();

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.disconnect({ clearStorage: true });

      expect(manager.state).toBe('unlocked');
      expect(manager.session).toBeUndefined();
    });

    test('emits session-end event with DID', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.disconnect();

      expect(events).toHaveLength(1);
      expect(events[0].did).toBe('did:dht:testuser123');
    });

    test('disconnect with no active session does not emit session-end', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.disconnect();

      expect(events).toHaveLength(0);
    });

    test('disconnect calls sync.stopSync when available', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        syncStopSync : async (timeout) => { stopCalls.push(timeout); },
      });

      // Add the sync.stopSync in the format the disconnect code checks
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.disconnect({ timeout: 5000 });

      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0]).toBe(5000);
    });
  });

  describe('events', () => {
    test('on() subscribes to auth events', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      const states: any[] = [];

      manager.on('state-change', (payload) => { states.push(payload); });

      await manager.connect({ password: 'test' });

      expect(states.length).toBeGreaterThan(0);
      expect(states[states.length - 1].current).toBe('connected');
    });

    test('on() returns unsubscribe function', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      const unsub = manager.on('state-change', () => {});
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('listIdentities()', () => {
    test('returns mapped identity info', async () => {
      const agent = createMockAgent({
        identityList: async () => [
          createMockIdentity({ did: { uri: 'did:1' }, metadata: { name: 'Alice', tenant: 't1' } }),
          createMockIdentity({ did: { uri: 'did:2' }, metadata: { name: 'Bob', tenant: 't2', connectedDid: 'did:ext' } }),
        ],
      });
      const manager = createTestManager(agent);

      const identities = await manager.listIdentities();
      expect(identities).toHaveLength(2);
      expect(identities[0]).toEqual({ didUri: 'did:1', name: 'Alice', connectedDid: undefined });
      expect(identities[1]).toEqual({ didUri: 'did:2', name: 'Bob', connectedDid: 'did:ext' });
    });
  });

  describe('switchIdentity()', () => {
    test('disconnects current session and switches to new identity', async () => {
      const identity = createMockIdentity({ did: { uri: 'did:new' }, metadata: { name: 'New', tenant: 'did:dht:testagent' } });
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        identityGet  : async () => identity,
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      const session = await manager.switchIdentity('did:new');
      expect(session.did).toBe('did:new');
      expect(manager.state).toBe('connected');
    });

    test('throws when identity not found', async () => {
      const agent = createMockAgent({
        identityGet: async () => undefined,
      });
      const manager = createTestManager(agent);

      await expect(manager.switchIdentity('did:nonexistent')).rejects.toThrow(
        'Identity not found: did:nonexistent'
      );
    });

    test('handles wallet-connected identity', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:delegate' },
        metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:external' },
      });
      const agent = createMockAgent({ identityGet: async () => identity });
      const manager = createTestManager(agent);

      const session = await manager.switchIdentity('did:delegate');
      expect(session.did).toBe('did:external');
      expect(session.delegateDid).toBe('did:delegate');
    });

    test('emits session-start event', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({ identityGet: async () => identity });
      const manager = createTestManager(agent);
      const events: any[] = [];
      manager.on('session-start', (payload) => { events.push(payload); });

      await manager.switchIdentity('did:dht:testuser123');

      expect(events).toHaveLength(1);
      expect(events[0].session.did).toBe('did:dht:testuser123');
    });

    test('starts sync in poll mode', async () => {
      const syncCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet   : async () => identity,
        syncStartSync : async (params) => { syncCalls.push(params); },
      });
      const manager = createTestManager(agent, { sync: '10s' });

      await manager.switchIdentity('did:dht:testuser123');

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].mode).toBe('poll');
    });

    test('skips sync when off', async () => {
      const syncCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet   : async () => identity,
        syncStartSync : async (params) => { syncCalls.push(params); },
      });
      const manager = createTestManager(agent, { sync: 'off' });

      await manager.switchIdentity('did:dht:testuser123');

      expect(syncCalls).toHaveLength(0);
    });
  });

  describe('deleteIdentity()', () => {
    test('deletes DID and identity', async () => {
      const didDeleteCalls: any[] = [];
      const identityDeleteCalls: any[] = [];
      const identity = createMockIdentity();

      const agent = createMockAgent({
        identityGet    : async () => identity,
        didDelete      : async (params) => { didDeleteCalls.push(params); },
        identityDelete : async (params) => { identityDeleteCalls.push(params); },
      });
      const manager = createTestManager(agent);

      await manager.deleteIdentity('did:dht:testuser123');

      expect(didDeleteCalls).toHaveLength(1);
      expect(didDeleteCalls[0].deleteKey).toBe(true);
      expect(identityDeleteCalls).toHaveLength(1);
    });

    test('disconnects active identity before deleting', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [identity],
        identityGet  : async () => identity,
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.deleteIdentity('did:dht:testuser123');

      expect(manager.session).toBeUndefined();
    });

    test('throws when identity not found', async () => {
      const agent = createMockAgent({ identityGet: async () => undefined });
      const manager = createTestManager(agent);

      await expect(manager.deleteIdentity('did:nonexistent')).rejects.toThrow(
        'Identity not found: did:nonexistent'
      );
    });

    test('emits identity-removed event', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({ identityGet: async () => identity });
      const manager = createTestManager(agent);
      const events: any[] = [];
      manager.on('identity-removed', (payload) => { events.push(payload); });

      await manager.deleteIdentity('did:dht:testuser123');

      expect(events).toHaveLength(1);
      expect(events[0].didUri).toBe('did:dht:testuser123');
    });

    test('handles DID delete failure gracefully', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet : async () => identity,
        didDelete   : async () => { throw new Error('DID delete failed'); },
      });
      const manager = createTestManager(agent);

      // Should not throw — DID deletion failure is logged, not rethrown
      await manager.deleteIdentity('did:dht:testuser123');
    });
  });

  describe('exportIdentity()', () => {
    test('delegates to agent.identity.export', async () => {
      const exportData = { portableDid: { uri: 'did:test' } } as any;
      const agent = createMockAgent({
        identityExport: async () => exportData,
      });
      const manager = createTestManager(agent);

      const result = await manager.exportIdentity('did:test');
      expect(result).toBe(exportData);
    });
  });

  describe('importFromPhrase()', () => {
    test('calls importFromPhrase flow and sets state', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      const session = await manager.importFromPhrase({
        recoveryPhrase : 'test phrase',
        password       : 'pass',
      });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
      expect(manager.isConnecting).toBe(false);
    });
  });

  describe('importFromPortable()', () => {
    test('calls importFromPortable flow and sets state', async () => {
      const agent = createMockAgent({
        identityImport: async () => createMockIdentity(),
      });
      const manager = createTestManager(agent);

      const session = await manager.importFromPortable({
        portableIdentity: {} as any,
      });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
    });
  });

  describe('state machine', () => {
    test('state changes emit state-change events', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      const transitions: any[] = [];
      manager.on('state-change', (payload) => { transitions.push(payload); });

      await manager.connect({ password: 'test' });

      expect(transitions.some((t) => t.current === 'connected')).toBe(true);
    });

    test('same state does not emit event', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { initialState: 'connected' });
      const transitions: any[] = [];
      manager.on('state-change', (payload) => { transitions.push(payload); });

      // Connect again — state is already 'connected', so the final
      // _setState('connected') should be a no-op.
      await manager.connect({ password: 'test' });

      // Should not have emitted a connected→connected transition
      const connectToConnect = transitions.filter(
        (t) => t.previous === 'connected' && t.current === 'connected'
      );
      expect(connectToConnect).toHaveLength(0);
    });
  });
});
