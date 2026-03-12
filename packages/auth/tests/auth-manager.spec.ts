import type { EnboxUserAgent } from '@enbox/agent';
import { describe, expect, test } from 'bun:test';

import { AuthManager } from '../src/auth-manager.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { PasswordProvider } from '../src/password-provider.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

/**
 * Construct an AuthManager instance with a pre-built mock agent.
 *
 * We use `Object.create()` + manual assignment to bypass the private
 * constructor and `EnboxUserAgent.create()` call, testing orchestration
 * logic in isolation.
 */
function createTestManager(
  agent: EnboxUserAgent,
  overrides: {
    storage?: MemoryStorage;
    password?: string;
    passwordProvider?: PasswordProvider;
    sync?: any;
    dwnEndpoints?: string[];
    initialState?: string;
  } = {},
): AuthManager {
  const storage = overrides.storage ?? new MemoryStorage();

  // Use the static create path with a module mock — but that requires
  // mocking EnboxUserAgent.create. Instead, craft the instance manually.
  const manager = Object.create(AuthManager.prototype) as any;
  manager._userAgent = agent;
  manager._emitter = new (require('../src/events.js').AuthEventEmitter)();
  manager._storage = storage;
  manager._session = undefined;
  manager._state = overrides.initialState ?? 'uninitialized';
  manager._isConnecting = false;
  manager._isShutDown = false;
  manager._defaultPassword = overrides.password;
  manager._passwordProvider = overrides.passwordProvider;
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

    test('vault returns the underlying identity vault', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.vault).toBe(agent.vault);
    });

    test('agent returns the user agent', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.agent).toBe(agent);
    });

    test('localDwnEndpoint returns undefined when not set', () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);
      expect(manager.localDwnEndpoint).toBeUndefined();
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

  describe('lock()', () => {
    test('stops sync, clears session, locks vault, transitions to locked', async () => {
      const lockCalls: any[] = [];
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        vaultLock    : async () => { lockCalls.push('locked'); },
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });
      expect(manager.state).toBe('connected');

      await manager.lock();

      expect(manager.state).toBe('locked');
      expect(manager.session).toBeUndefined();
      expect(lockCalls).toHaveLength(1);
      expect(stopCalls).toHaveLength(1);
    });

    test('emits session-end event when session was active', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.lock();

      expect(events).toHaveLength(1);
      expect(events[0].did).toBe('did:dht:testuser123');
    });

    test('does not emit session-end when no active session', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.lock();

      expect(events).toHaveLength(0);
      expect(manager.state).toBe('locked');
    });

    test('emits vault-locked event', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      const events: any[] = [];
      manager.on('vault-locked', (payload) => { events.push(payload); });

      await manager.lock();

      expect(events).toHaveLength(1);
    });

    test('uses custom timeout for sync stop', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.lock({ timeout: 5000 });

      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0]).toBe(5000);
    });

    test('preserves session storage markers for subsequent restore', async () => {
      const storage = new MemoryStorage();
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      // Verify markers exist after connect
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');

      await manager.lock();

      // Markers should still be present (unlike disconnect)
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    });
  });

  describe('switchIdentity() — sync registration', () => {
    test('calls sync.registerIdentity for the target identity', async () => {
      const registerCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet          : async () => identity,
        syncRegisterIdentity : async (params) => { registerCalls.push(params); },
        syncStartSync        : async () => {},
      });
      const manager = createTestManager(agent, { sync: '10s' });

      await manager.switchIdentity('did:dht:testuser123');

      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].did).toBe('did:dht:testuser123');
      expect(registerCalls[0].options.protocols).toEqual([]);
    });

    test('passes delegateDid for wallet-connected identity', async () => {
      const registerCalls: any[] = [];
      const identity = createMockIdentity({
        did      : { uri: 'did:delegate' },
        metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:external' },
      });
      const agent = createMockAgent({
        identityGet          : async () => identity,
        syncRegisterIdentity : async (params) => { registerCalls.push(params); },
        syncStartSync        : async () => {},
      });
      const manager = createTestManager(agent, { sync: '10s' });

      await manager.switchIdentity('did:delegate');

      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].did).toBe('did:external');
      expect(registerCalls[0].options.delegateDid).toBe('did:delegate');
    });

    test('handles already-registered identity gracefully', async () => {
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet          : async () => identity,
        syncRegisterIdentity : async () => { throw new Error('Identity already registered'); },
        syncStartSync        : async () => {},
      });
      const manager = createTestManager(agent, { sync: '10s' });

      // Should not throw
      const session = await manager.switchIdentity('did:dht:testuser123');
      expect(session.did).toBe('did:dht:testuser123');
    });

    test('skips registration when sync is off', async () => {
      const registerCalls: any[] = [];
      const identity = createMockIdentity();
      const agent = createMockAgent({
        identityGet          : async () => identity,
        syncRegisterIdentity : async (params) => { registerCalls.push(params); },
      });
      const manager = createTestManager(agent, { sync: 'off' });

      await manager.switchIdentity('did:dht:testuser123');

      expect(registerCalls).toHaveLength(0);
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

  describe('connectHeadless()', () => {
    test('unlocks vault and returns session without sync', async () => {
      const startCalls: any[] = [];
      const syncCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch   : async () => false,
        start         : async (params) => { startCalls.push(params); },
        identityList  : async () => [createMockIdentity()],
        syncStartSync : async (params) => { syncCalls.push(params); },
      });
      const manager = createTestManager(agent);

      const session = await manager.connectHeadless({ password: 'my-password' });

      expect(session.did).toBe('did:dht:testuser123');
      expect(manager.state).toBe('connected');
      expect(manager.session).toBe(session);
      // Agent was started with the password
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('my-password');
      // Sync was NOT started
      expect(syncCalls).toHaveLength(0);
    });

    test('throws when no password is provided and no default', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      await expect(manager.connectHeadless()).rejects.toThrow(
        'connectHeadless() requires a password'
      );
    });

    test('uses default password when no override', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { password: 'default-pw' });

      await manager.connectHeadless();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('default-pw');
    });

    test('initialises vault on first launch', async () => {
      const initCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        initialize   : async (params) => { initCalls.push(params); return 'phrase'; },
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);

      await manager.connectHeadless({ password: 'new-pw' });

      expect(initCalls).toHaveLength(1);
      expect(initCalls[0].password).toBe('new-pw');
    });

    test('throws when no identities exist', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [],
      });
      const manager = createTestManager(agent);

      await expect(manager.connectHeadless({ password: 'pw' })).rejects.toThrow(
        'No identities found in vault'
      );
    });

    test('prefers previously-active identity', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:second');

      const identities = [
        createMockIdentity({ did: { uri: 'did:dht:first' }, metadata: { name: 'First', tenant: 't1' } }),
        createMockIdentity({ did: { uri: 'did:dht:second' }, metadata: { name: 'Second', tenant: 't2' } }),
      ];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => identities,
      });
      const manager = createTestManager(agent, { storage });

      const session = await manager.connectHeadless({ password: 'pw' });

      expect(session.did).toBe('did:dht:second');
    });

    test('falls back to first identity when saved identity not found', async () => {
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:gone');

      const identities = [
        createMockIdentity({ did: { uri: 'did:dht:first' }, metadata: { name: 'First', tenant: 't1' } }),
      ];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => identities,
      });
      const manager = createTestManager(agent, { storage });

      const session = await manager.connectHeadless({ password: 'pw' });

      expect(session.did).toBe('did:dht:first');
    });

    test('handles wallet-connected identity (connectedDid)', async () => {
      const identity = createMockIdentity({
        did      : { uri: 'did:dht:delegate' },
        metadata : { name: 'Wallet', tenant: 't1', connectedDid: 'did:dht:external' },
      });
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [identity],
      });
      const manager = createTestManager(agent);

      const session = await manager.connectHeadless({ password: 'pw' });

      expect(session.did).toBe('did:dht:external');
      expect(session.delegateDid).toBe('did:dht:delegate');
    });

    test('does not persist session markers', async () => {
      const storage = new MemoryStorage();
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent, { storage });

      await manager.connectHeadless({ password: 'pw' });

      // No persistence markers should be set
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
    });

    test('emits vault-unlocked event', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      const events: any[] = [];
      manager.on('vault-unlocked', (payload) => { events.push(payload); });

      await manager.connectHeadless({ password: 'pw' });

      expect(events).toHaveLength(1);
    });
  });

  describe('shutdown()', () => {
    test('stops sync, locks vault, closes storage and sync engine', async () => {
      const stopCalls: any[] = [];
      const lockCalls: any[] = [];
      const syncCloseCalls: any[] = [];
      const storageCloseCalls: any[] = [];

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        vaultLock    : async () => { lockCalls.push('locked'); },
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };
      (agent as any).sync.close = async (): Promise<void> => { syncCloseCalls.push('closed'); };

      const storage = new MemoryStorage();
      (storage as any).close = async (): Promise<void> => { storageCloseCalls.push('closed'); };

      const manager = createTestManager(agent, { storage });
      await manager.connect({ password: 'test' });

      await manager.shutdown();

      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0]).toBe(2000); // default timeout
      expect(lockCalls).toHaveLength(1);
      expect(syncCloseCalls).toHaveLength(1);
      expect(storageCloseCalls).toHaveLength(1);
      expect(manager.state).toBe('locked');
      expect(manager.session).toBeUndefined();
    });

    test('emits session-end when session was active', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.shutdown();

      expect(events).toHaveLength(1);
      expect(events[0].did).toBe('did:dht:testuser123');
    });

    test('does not emit session-end when no active session', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent, { initialState: 'unlocked' });
      const events: any[] = [];
      manager.on('session-end', (payload) => { events.push(payload); });

      await manager.shutdown();

      expect(events).toHaveLength(0);
    });

    test('is idempotent — second call is a no-op', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.shutdown();
      await manager.shutdown(); // second call

      // stopSync called only once
      expect(stopCalls).toHaveLength(1);
    });

    test('uses custom timeout', async () => {
      const stopCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (timeout: number): Promise<void> => { stopCalls.push(timeout); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      await manager.shutdown({ timeout: 5000 });

      expect(stopCalls[0]).toBe(5000);
    });

    test('handles sync.close throwing gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      // Make close throw — shutdown should still succeed (best-effort).
      (agent as any).sync.close = async (): Promise<void> => { throw new Error('db already closed'); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // Should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('handles missing storage.close gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // MemoryStorage has no close() by default — should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('handles sync.stopSync failure gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      (agent as any).sync.stopSync = async (): Promise<void> => { throw new Error('sync error'); };

      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // Should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('handles vault lock failure gracefully', async () => {
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
        vaultLock    : async () => { throw new Error('vault error'); },
      });
      const manager = createTestManager(agent);
      await manager.connect({ password: 'test' });

      // Should not throw
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });

    test('works from uninitialized state', async () => {
      const agent = createMockAgent();
      const manager = createTestManager(agent);

      // Should not throw even with no session/vault
      await manager.shutdown();
      expect(manager.state).toBe('locked');
    });
  });

  describe('passwordProvider integration', () => {
    test('connect() uses provider when no explicit password', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('provider-pw');
    });

    test('connect() prefers explicit password over provider', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect({ password: 'explicit-pw' });

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('explicit-pw');
    });

    test('connect() prefers defaultPassword over provider', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { password: 'default-pw', passwordProvider: provider });

      await manager.connect();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('default-pw');
    });

    test('connect() passes create reason on first launch', async () => {
      const reasons: string[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async (ctx) => {
        reasons.push(ctx.reason);
        return 'pw';
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      expect(reasons).toEqual(['create']);
    });

    test('connect() passes unlock reason on subsequent launch', async () => {
      const reasons: string[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async (ctx) => {
        reasons.push(ctx.reason);
        return 'pw';
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      expect(reasons).toEqual(['unlock']);
    });

    test('connectHeadless() uses provider when no explicit password', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'headless-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connectHeadless();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('headless-pw');
    });

    test('connectHeadless() throws when provider also fails', async () => {
      const agent = createMockAgent();
      const provider = PasswordProvider.fromCallback(async () => {
        throw new Error('provider failed');
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await expect(manager.connectHeadless()).rejects.toThrow(
        'provider failed'
      );
    });

    test('restoreSession() uses provider when no explicit password', async () => {
      const startCalls: any[] = [];
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'restore-pw');
      const manager = createTestManager(agent, { storage, passwordProvider: provider });

      await manager.restoreSession();

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('restore-pw');
    });

    test('restoreSession() prefers onPasswordRequired over provider', async () => {
      const startCalls: any[] = [];
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'provider-pw');
      const manager = createTestManager(agent, { storage, passwordProvider: provider });

      await manager.restoreSession({
        onPasswordRequired: async () => 'callback-pw',
      });

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('callback-pw');
    });

    test('connect() falls back to insecure default when provider fails', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => {
        throw new Error('provider failed');
      });
      const manager = createTestManager(agent, { passwordProvider: provider });

      await manager.connect();

      // Falls back to insecure-static-phrase
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('insecure-static-phrase');
    });

    test('walletConnect() uses provider', async () => {
      const startCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch  : async () => false,
        start        : async (params) => { startCalls.push(params); },
        identityList : async () => [createMockIdentity()],
      });
      const provider = PasswordProvider.fromCallback(async () => 'wallet-pw');
      const manager = createTestManager(agent, { passwordProvider: provider });

      // walletConnect requires specific options — we mock the flow
      // by testing that the password resolution happens before the
      // walletConnect flow starts (which we can verify via start() calls)
      try {
        await manager.walletConnect({
          displayName        : 'Test',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        });
      } catch {
        // walletConnect flow will fail since we're using mocks,
        // but the password resolution should have happened
      }

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].password).toBe('wallet-pw');
    });
  });
});
