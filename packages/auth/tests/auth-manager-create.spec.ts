/**
 * Tests for AuthManager.create() and walletConnect() — the two uncovered methods.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import sinon from 'sinon';

import { EnboxUserAgent } from '@enbox/agent';

import { AuthManager } from '../src/auth-manager.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { WalletConnect } from '../src/wallet-connect-client.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

function createInitClientResult(): any {
  return {
    delegatePortableDid : { uri: 'did:dht:delegate123' },
    connectedDid        : 'did:dht:connected456',
    delegateGrants      : [],
  };
}

let initClientStub: sinon.SinonStub;
let userAgentCreateStub: sinon.SinonStub;

function setupStubs(): void {
  initClientStub = sinon.stub(WalletConnect, 'initClient').resolves(createInitClientResult());
  userAgentCreateStub = sinon.stub(EnboxUserAgent, 'create').resolves(createMockAgent() as any);
}

describe('AuthManager.create()', () => {
  beforeEach((): void => {
    setupStubs();
  });

  afterEach((): void => {
    sinon.restore();
  });

  test('creates instance with default options', async () => {
    const agent = createMockAgent({ vaultIsInitialized: async () => false });
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    expect(manager).toBeInstanceOf(AuthManager);
    expect(manager.state).toBe('uninitialized');
    expect(manager.agent).toBe(agent);
  });

  test('creates instance with custom options', async () => {
    const storage = new MemoryStorage();
    const agent = createMockAgent({ vaultIsInitialized: async () => false });
    userAgentCreateStub.onFirstCall().resolves(agent as any);

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    expect(manager.state).toBe('locked');
  });

  test('detects unlocked vault state', async () => {
    const agent = createMockAgent({
      vaultIsInitialized : async () => true,
      vaultIsLocked      : () => false,
    });
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    expect(manager.state).toBe('unlocked');
  });

  test('passes dataPath to EnboxUserAgent.create', async () => {
    let capturedOptions: any;
    userAgentCreateStub.onFirstCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    await AuthManager.create({ dataPath: '/my/data', storage: new MemoryStorage() });

    expect(capturedOptions.dataPath).toBe('/my/data');
  });

  test('uses pre-built agent when provided', async () => {
    const customAgent = createMockAgent({ vaultIsInitialized: async () => false });
    const callsBefore = userAgentCreateStub.callCount;

    const manager = await AuthManager.create({
      agent   : customAgent as any,
      storage : new MemoryStorage(),
    });

    // EnboxUserAgent.create() should NOT have been called.
    expect(userAgentCreateStub.callCount).toBe(callsBefore);
    expect(manager.agent).toBe(customAgent);
    expect(manager.state).toBe('uninitialized');
  });

  test('agent option ignores dataPath, agentVault, and localDwnStrategy', async () => {
    const customAgent = createMockAgent({ vaultIsInitialized: async () => true, vaultIsLocked: () => false });
    const callsBefore = userAgentCreateStub.callCount;

    const manager = await AuthManager.create({
      agent            : customAgent as any,
      dataPath         : '/should/be/ignored',
      agentVault       : { fake: 'vault' } as any,
      localDwnStrategy : 'prefer' as any,
      storage          : new MemoryStorage(),
    });

    // EnboxUserAgent.create() should NOT have been called.
    expect(userAgentCreateStub.callCount).toBe(callsBefore);
    expect(manager.agent).toBe(customAgent);
    expect(manager.state).toBe('unlocked');
  });

  test('passes agentVault to EnboxUserAgent.create', async () => {
    let capturedOptions: any;
    userAgentCreateStub.onFirstCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    const fakeVault = { fake: 'vault' } as any;
    await AuthManager.create({ agentVault: fakeVault, storage: new MemoryStorage() });

    expect(capturedOptions.agentVault).toBe(fakeVault);
  });

  test('passes localDwnStrategy to EnboxUserAgent.create', async () => {
    let capturedOptions: any;
    userAgentCreateStub.onFirstCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    await AuthManager.create({ localDwnStrategy: 'prefer' as any, storage: new MemoryStorage() });

    expect(capturedOptions.localDwnStrategy).toBe('prefer');
  });

  test('passes all agent creation options together', async () => {
    let capturedOptions: any;
    userAgentCreateStub.onFirstCall().callsFake((...args: any[]): any => {
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
  beforeEach((): void => {
    setupStubs();
  });

  afterEach((): void => {
    sinon.restore();
  });

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    initClientStub.onFirstCall().resolves(createInitClientResult());

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    initClientStub.onFirstCall().resolves(createInitClientResult());

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    initClientStub.onFirstCall().resolves(createInitClientResult());

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    initClientStub.onFirstCall().resolves(createInitClientResult());

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    initClientStub.onFirstCall().resolves(createInitClientResult());

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

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
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    initClientStub.onFirstCall().resolves(createInitClientResult());

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
