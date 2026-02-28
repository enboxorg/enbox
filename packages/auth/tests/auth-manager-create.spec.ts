/**
 * Tests for AuthManager.create() and walletConnect() — the two uncovered methods.
 *
 * These need module-level mocking of Web5UserAgent.create() because the
 * private constructor is not directly accessible. We use a dedicated test
 * file so mock.module() does not pollute other test files.
 */
import { describe, expect, mock, test } from 'bun:test';

import { MemoryStorage } from '../src/storage/storage.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

// ── Module-level mocks ──────────────────────────────────────────
// Preserve all actual agent exports, only mock Web5UserAgent.create and
// WalletConnect.initClient.

const actualAgent = await import('@enbox/agent');
const actualCommon = await import('@enbox/common');

const mockUserAgentCreate = mock((): any => Promise.resolve(createMockAgent()));

const mockInitClient = mock((): any => Promise.resolve({
  delegatePortableDid : { uri: 'did:dht:delegate123' },
  connectedDid        : 'did:dht:connected456',
  delegateGrants      : [],
}));

mock.module('@enbox/agent', () => ({
  ...actualAgent,
  Web5UserAgent: {
    ...actualAgent.Web5UserAgent,
    create: mockUserAgentCreate,
  },
  WalletConnect: {
    ...actualAgent.WalletConnect,
    initClient: mockInitClient,
  },
  DwnPermissionGrant: {
    ...actualAgent.DwnPermissionGrant,
    parse: (message: any): { scope: any } => ({ scope: message._scope ?? {} }),
  },
}));

mock.module('@enbox/common', () => ({
  ...actualCommon,
  Convert: {
    ...actualCommon.Convert,
    base64Url: (): { toUint8Array: () => Uint8Array } => ({
      toUint8Array: (): Uint8Array => new Uint8Array([1, 2, 3]),
    }),
  },
}));

// Import AuthManager AFTER mocks are registered.
const { AuthManager } = await import('../src/auth-manager.js');

describe('AuthManager.create()', () => {
  test('creates instance with default options', async () => {
    const agent = createMockAgent({ vaultIsInitialized: async () => false });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    expect(manager).toBeInstanceOf(AuthManager);
    expect(manager.state).toBe('uninitialized');
    expect(manager.agent).toBe(agent);
  });

  test('creates instance with custom options', async () => {
    const storage = new MemoryStorage();
    const agent = createMockAgent({ vaultIsInitialized: async () => false });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    const manager = await AuthManager.create({
      storage,
      password     : 'secure-pass',
      sync         : '30s',
      dwnEndpoints : ['https://dwn.example.com'],
      dataPath     : '/custom/path',
    });

    expect(manager).toBeInstanceOf(AuthManager);
    expect(manager.state).toBe('uninitialized');
  });

  test('detects locked vault state', async () => {
    const agent = createMockAgent({
      vaultIsInitialized : async () => true,
      vaultIsLocked      : () => true,
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    expect(manager.state).toBe('locked');
  });

  test('detects unlocked vault state', async () => {
    const agent = createMockAgent({
      vaultIsInitialized : async () => true,
      vaultIsLocked      : () => false,
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    expect(manager.state).toBe('unlocked');
  });

  test('passes dataPath to Web5UserAgent.create', async () => {
    let capturedOptions: any;
    mockUserAgentCreate.mockImplementationOnce((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    await AuthManager.create({ dataPath: '/my/data', storage: new MemoryStorage() });

    expect(capturedOptions.dataPath).toBe('/my/data');
  });

  test('uses pre-built agent when provided', async () => {
    const customAgent = createMockAgent({ vaultIsInitialized: async () => false });
    const callsBefore = mockUserAgentCreate.mock.calls.length;

    const manager = await AuthManager.create({
      agent   : customAgent as any,
      storage : new MemoryStorage(),
    });

    // Web5UserAgent.create() should NOT have been called.
    expect(mockUserAgentCreate.mock.calls.length).toBe(callsBefore);
    expect(manager.agent).toBe(customAgent);
    expect(manager.state).toBe('uninitialized');
  });

  test('agent option ignores dataPath, agentVault, and localDwnStrategy', async () => {
    const customAgent = createMockAgent({ vaultIsInitialized: async () => true, vaultIsLocked: () => false });
    const callsBefore = mockUserAgentCreate.mock.calls.length;

    const manager = await AuthManager.create({
      agent            : customAgent as any,
      dataPath         : '/should/be/ignored',
      agentVault       : { fake: 'vault' } as any,
      localDwnStrategy : 'prefer' as any,
      storage          : new MemoryStorage(),
    });

    // Web5UserAgent.create() should NOT have been called.
    expect(mockUserAgentCreate.mock.calls.length).toBe(callsBefore);
    expect(manager.agent).toBe(customAgent);
    expect(manager.state).toBe('unlocked');
  });

  test('passes agentVault to Web5UserAgent.create', async () => {
    let capturedOptions: any;
    mockUserAgentCreate.mockImplementationOnce((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    const fakeVault = { fake: 'vault' } as any;
    await AuthManager.create({ agentVault: fakeVault, storage: new MemoryStorage() });

    expect(capturedOptions.agentVault).toBe(fakeVault);
  });

  test('passes localDwnStrategy to Web5UserAgent.create', async () => {
    let capturedOptions: any;
    mockUserAgentCreate.mockImplementationOnce((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    await AuthManager.create({ localDwnStrategy: 'prefer' as any, storage: new MemoryStorage() });

    expect(capturedOptions.localDwnStrategy).toBe('prefer');
  });

  test('passes all agent creation options together', async () => {
    let capturedOptions: any;
    mockUserAgentCreate.mockImplementationOnce((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    const fakeVault = { fake: 'vault' } as any;
    await AuthManager.create({
      dataPath         : '/custom/path',
      agentVault       : fakeVault,
      localDwnStrategy : 'only' as any,
      storage          : new MemoryStorage(),
    });

    expect(capturedOptions.dataPath).toBe('/custom/path');
    expect(capturedOptions.agentVault).toBe(fakeVault);
    expect(capturedOptions.localDwnStrategy).toBe('only');
  });
});

describe('AuthManager.walletConnect()', () => {
  test('initializes agent on first launch', async () => {
    const initCalls: any[] = [];
    const startCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => true,
      initialize     : async (params) => { initCalls.push(params); return 'phrase'; },
      start          : async (params) => { startCalls.push(params); },
      identityImport : async () => identity,
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });
    const session = await manager.walletConnect({
      displayName        : 'Test App',
      connectServerUrl   : 'https://relay.example.com',
      permissionRequests : [],
      onWalletUriReady   : () => {},
      validatePin        : async () => '1234',
    });

    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].password).toBe('insecure-static-phrase');
    expect(startCalls).toHaveLength(1);
    expect(session.did).toBe('did:dht:connected456');
    expect(manager.state).toBe('connected');
    expect(manager.session).toBe(session);
  });

  test('skips initialize when not first launch', async () => {
    const initCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      initialize     : async (params) => { initCalls.push(params); return 'phrase'; },
      identityImport : async () => identity,
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });
    await manager.walletConnect({
      displayName        : 'Test App',
      connectServerUrl   : 'https://relay.example.com',
      permissionRequests : [],
      onWalletUriReady   : () => {},
      validatePin        : async () => '1234',
    });

    expect(initCalls).toHaveLength(0);
  });

  test('uses manager default password for agent init', async () => {
    const initCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => true,
      initialize     : async (params) => { initCalls.push(params); return 'phrase'; },
      identityImport : async () => identity,
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    const manager = await AuthManager.create({ password: 'my-password', storage: new MemoryStorage() });
    await manager.walletConnect({
      displayName        : 'Test App',
      connectServerUrl   : 'https://relay.example.com',
      permissionRequests : [],
      onWalletUriReady   : () => {},
      validatePin        : async () => '1234',
    });

    expect(initCalls[0].password).toBe('my-password');
  });

  test('emits vault-unlocked event', async () => {
    const events: string[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });
    manager.on('vault-unlocked', () => { events.push('vault-unlocked'); });

    await manager.walletConnect({
      displayName        : 'Test App',
      connectServerUrl   : 'https://relay.example.com',
      permissionRequests : [],
      onWalletUriReady   : () => {},
      validatePin        : async () => '1234',
    });

    expect(events).toContain('vault-unlocked');
  });

  test('concurrency guard prevents parallel walletConnect', async () => {
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      start          : async () => { await new Promise((r) => setTimeout(r, 50)); },
      identityImport : async () => identity,
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    const first = manager.walletConnect({
      displayName        : 'Test App',
      connectServerUrl   : 'https://relay.example.com',
      permissionRequests : [],
      onWalletUriReady   : () => {},
      validatePin        : async () => '1234',
    });

    await expect(
      manager.walletConnect({
        displayName        : 'Test App 2',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '5678',
      })
    ).rejects.toThrow('A connection attempt is already in progress');

    await first;
  });

  test('resets isConnecting on walletConnect failure', async () => {
    const agent = createMockAgent({
      firstLaunch : async () => false,
      start       : async () => { throw new Error('start failed'); },
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    try {
      await manager.walletConnect({
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      });
    } catch { /* expected */ }

    expect(manager.isConnecting).toBe(false);
  });

  test('passes defaultSync to walletConnect flow', async () => {
    const syncCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncStartSync  : async (params) => { syncCalls.push(params); },
    });
    mockUserAgentCreate.mockImplementationOnce((): any => Promise.resolve(agent));

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    const manager = await AuthManager.create({ sync: '20s', storage: new MemoryStorage() });
    await manager.walletConnect({
      displayName        : 'Test App',
      connectServerUrl   : 'https://relay.example.com',
      permissionRequests : [],
      onWalletUriReady   : () => {},
      validatePin        : async () => '1234',
    });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].interval).toBe('20s');
  });
});
