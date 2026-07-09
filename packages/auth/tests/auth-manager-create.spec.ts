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
import { persistLocalDwnEjectionRecord, persistLocalDwnPairingRecord, readLocalDwnEjectionRecord } from '../src/discovery.js';

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

function localNodeInfo(): any {
  return {
    localNode    : true,
    localPairing : {
      pairUrl         : 'http://127.0.0.1:55500/local/pair',
      pollUrlTemplate : 'http://127.0.0.1:55500/local/pair/{requestId}',
    },
    maxFileSize              : 10_000_000,
    registrationRequirements : [],
    server                   : '@enbox/dwn-server',
    sdkVersion               : '0.0.1',
    url                      : 'http://127.0.0.1:55500',
    version                  : '0.0.1',
    webSocketSupport         : true,
  };
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
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
    expect(manager.localDwnStatus).toEqual({ status: 'unavailable' });
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

  test('does not create remote-mode agent from a stored pairing before eject', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, {
      createdAt    : 123,
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      token        : 'paired-token',
      version      : 1,
    });

    sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = url.toString();
      if (href.endsWith('/info')) {
        return jsonResponse(localNodeInfo());
      }

      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer paired-token');
      return jsonResponse({ localNode: true, paired: true });
    });

    let capturedOptions: any;
    userAgentCreateStub.onFirstCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    const manager = await AuthManager.create({ storage });

    expect(capturedOptions.localDwnEndpoint).toBeUndefined();
    expect(capturedOptions.rpcClient).toBeUndefined();
    expect(manager.localDwnEndpoint).toBeUndefined();
    expect(manager.localDwnStatus).toEqual({
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      status       : 'paired',
    });
  });

  test('creates remote-mode agent with a stored local-node pairing after eject', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, {
      createdAt    : 123,
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      token        : 'paired-token',
      version      : 1,
    });
    await persistLocalDwnEjectionRecord(storage, {
      completedAt : 456,
      endpoint    : 'http://127.0.0.1:55500',
      version     : 1,
    });

    sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = url.toString();
      if (href.endsWith('/info')) {
        return jsonResponse(localNodeInfo());
      }

      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer paired-token');
      return jsonResponse({ localNode: true, paired: true });
    });

    let capturedOptions: any;
    userAgentCreateStub.onFirstCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    const manager = await AuthManager.create({ storage });

    expect(capturedOptions.localDwnEndpoint).toBe('http://127.0.0.1:55500');
    expect(capturedOptions.rpcClient).toBeDefined();
    expect(manager.localDwnEndpoint).toBe('http://127.0.0.1:55500');
    expect(manager.localDwnStatus).toEqual({
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      status       : 'paired',
    });
  });

  test('enableLocalNode pairs and emits local-dwn-available', async () => {
    const storage = new MemoryStorage();
    userAgentCreateStub.onFirstCall().resolves(createMockAgent() as any);
    let pollCount = 0;

    sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = url.toString();
      if (href.endsWith('/info')) {
        return jsonResponse(localNodeInfo());
      }

      if (href.endsWith('/local/pair') && init?.method === 'POST') {
        return jsonResponse({ requestId: 'request-1', status: 'pending' });
      }

      pollCount++;
      return pollCount === 1
        ? jsonResponse({ origin: 'https://app.example', status: 'pending' })
        : jsonResponse({ origin: 'https://app.example', status: 'approved', token: 'new-token' });
    });

    const manager = await AuthManager.create({ storage });
    const events: any[] = [];
    manager.on('local-dwn-available', (event) => { events.push(event); });

    const result = await manager.enableLocalNode({
      endpoint       : 'http://127.0.0.1:55500',
      origin         : 'https://app.example',
      pollIntervalMs : 0,
      timeoutMs      : 100,
    });

    expect(result.status).toBe('paired');
    expect(events).toEqual([{ endpoint: 'http://127.0.0.1:55500', paired: true }]);
    expect(manager.localDwnEndpoint).toBeUndefined();
    expect(manager.localDwnStatus).toEqual({
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      status       : 'paired',
    });
  });

  test('probeLocalNode returns unsupported when fetch is unavailable', async () => {
    const manager = await AuthManager.create({ storage: new MemoryStorage() });

    await withoutGlobalFetch(async (): Promise<void> => {
      expect(await manager.probeLocalNode()).toEqual({ reason: 'no-fetch', status: 'unsupported' });
    });
  });

  test('enableLocalNode emits unavailable when endpoint is not a local node', async () => {
    const storage = new MemoryStorage();
    userAgentCreateStub.onFirstCall().resolves(createMockAgent() as any);
    sinon.stub(globalThis, 'fetch').resolves(jsonResponse({ ...localNodeInfo(), localNode: false }));

    const manager = await AuthManager.create({ storage });
    const unavailableEvents: any[] = [];
    manager.on('local-dwn-unavailable', (event) => { unavailableEvents.push(event); });

    const result = await manager.enableLocalNode({ endpoint: 'http://127.0.0.1:55500' });

    expect(result).toEqual({ status: 'not-found' });
    expect(unavailableEvents).toEqual([{}]);
    expect(manager.localDwnStatus).toEqual({ status: 'unavailable' });
  });

  test('enableLocalNode updates remote-mode agent RPC client and cached endpoint', async () => {
    const storage = new MemoryStorage();
    const endpointCalls: string[] = [];
    const agent = createMockAgent({
      dwnIsRemoteMode              : true,
      dwnSetCachedLocalDwnEndpoint : async (endpoint): Promise<boolean> => {
        endpointCalls.push(endpoint);
        return true;
      },
    });
    const originalRpc = (agent as any).rpc;
    userAgentCreateStub.onFirstCall().resolves(agent as any);
    let pollCount = 0;

    sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = url.toString();
      if (href.endsWith('/info')) {
        return jsonResponse(localNodeInfo());
      }

      if (href.endsWith('/local/pair') && init?.method === 'POST') {
        return jsonResponse({ requestId: 'request-1', status: 'pending' });
      }

      pollCount++;
      return pollCount === 1
        ? jsonResponse({ origin: 'https://app.example', status: 'pending' })
        : jsonResponse({ origin: 'https://app.example', status: 'approved', token: 'remote-token' });
    });

    const manager = await AuthManager.create({ storage });
    const result = await manager.enableLocalNode({
      endpoint       : 'http://127.0.0.1:55500',
      origin         : 'https://app.example',
      pollIntervalMs : 0,
      timeoutMs      : 100,
    });

    expect(result.status).toBe('paired');
    expect(manager.localDwnEndpoint).toBe('http://127.0.0.1:55500');
    expect(endpointCalls).toEqual(['http://127.0.0.1:55500']);
    expect((agent as any).rpc).not.toBe(originalRpc);
    expect(manager.localDwnStatus).toEqual({
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      status       : 'paired',
    });
  });

  test('ejectToLocalNode drains paired endpoint and marks the next session for remote mode', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, {
      createdAt    : 123,
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      token        : 'paired-token',
      version      : 1,
    });

    sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = url.toString();
      if (href.endsWith('/info')) {
        return jsonResponse(localNodeInfo());
      }

      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer paired-token');
      return jsonResponse({ localNode: true, paired: true });
    });

    const drainCalls: string[] = [];
    const agent = createMockAgent({
      syncDrainTo: async (endpoint): Promise<any> => {
        drainCalls.push(endpoint);
        return {
          completed : true,
          endpoint,
          targets   : [{
            completed      : true,
            converged      : true,
            remoteEndpoint : endpoint,
            tenantDid      : 'did:dht:alice',
          }],
        };
      },
    });
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    const manager = await AuthManager.create({ storage });
    const result = await manager.ejectToLocalNode();

    expect(result.status).toBe('completed');
    expect(result.nextSessionRemoteMode).toBe(true);
    expect(drainCalls).toEqual(['http://127.0.0.1:55500']);
    expect(manager.localDwnEndpoint).toBeUndefined();
    expect(await readLocalDwnEjectionRecord(storage)).toEqual({
      completedAt : expect.any(Number),
      endpoint    : 'http://127.0.0.1:55500',
      version     : 1,
    });

    let capturedOptions: any;
    userAgentCreateStub.onSecondCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    const nextManager = await AuthManager.create({ storage });

    expect(capturedOptions.localDwnEndpoint).toBe('http://127.0.0.1:55500');
    expect(capturedOptions.rpcClient).toBeDefined();
    expect(nextManager.localDwnEndpoint).toBe('http://127.0.0.1:55500');
  });

  test('ejectToLocalNode does not persist remote-mode marker when drain is incomplete', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, {
      createdAt    : 123,
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      token        : 'paired-token',
      version      : 1,
    });

    sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = url.toString();
      if (href.endsWith('/info')) {
        return jsonResponse(localNodeInfo());
      }

      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer paired-token');
      return jsonResponse({ localNode: true, paired: true });
    });

    const agent = createMockAgent({
      syncDrainTo: async (endpoint): Promise<any> => ({
        completed : false,
        endpoint,
        targets   : [{
          completed      : false,
          converged      : false,
          error          : 'push failed',
          remoteEndpoint : endpoint,
          tenantDid      : 'did:dht:alice',
        }],
      }),
    });
    userAgentCreateStub.onFirstCall().resolves(agent as any);

    const manager = await AuthManager.create({ storage });
    const result = await manager.ejectToLocalNode();

    expect(result.status).toBe('incomplete');
    expect(result.nextSessionRemoteMode).toBe(false);
    expect(await readLocalDwnEjectionRecord(storage)).toBeUndefined();

    let capturedOptions: any;
    userAgentCreateStub.onSecondCall().callsFake((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve(createMockAgent());
    });

    const nextManager = await AuthManager.create({ storage });

    expect(capturedOptions.localDwnEndpoint).toBeUndefined();
    expect(capturedOptions.rpcClient).toBeUndefined();
    expect(nextManager.localDwnEndpoint).toBeUndefined();
  });

  test('ejectToLocalNode returns unavailable and clears stale marker without a pairing', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnEjectionRecord(storage, {
      completedAt : 456,
      endpoint    : 'http://127.0.0.1:55500',
      version     : 1,
    });

    userAgentCreateStub.onFirstCall().resolves(createMockAgent() as any);

    const manager = await AuthManager.create({ storage });
    const events: any[] = [];
    manager.on('local-dwn-unavailable', (event): void => {
      events.push(event);
    });

    const result = await manager.ejectToLocalNode();

    expect(result).toEqual({
      nextSessionRemoteMode : false,
      reason                : 'not-paired',
      status                : 'unavailable',
    });
    expect(events).toEqual([{}]);
    expect(await readLocalDwnEjectionRecord(storage)).toBeUndefined();
  });

  test('ejectToLocalNode rejects remote-mode agents before draining', async () => {
    const storage = new MemoryStorage();
    await persistLocalDwnPairingRecord(storage, {
      createdAt    : 123,
      endpoint     : 'http://127.0.0.1:55500',
      pairedOrigin : 'https://app.example',
      token        : 'paired-token',
      version      : 1,
    });

    sinon.stub(globalThis, 'fetch').callsFake(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = url.toString();
      if (href.endsWith('/info')) {
        return jsonResponse(localNodeInfo());
      }

      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer paired-token');
      return jsonResponse({ localNode: true, paired: true });
    });

    let drainCalls = 0;
    userAgentCreateStub.onFirstCall().resolves(createMockAgent({
      dwnIsRemoteMode : true,
      syncDrainTo     : async (): Promise<any> => {
        drainCalls += 1;
        return { completed: true, endpoint: 'http://127.0.0.1:55500', targets: [] };
      },
    }) as any);

    const manager = await AuthManager.create({ storage });

    await expect(manager.ejectToLocalNode()).rejects.toThrow(
      '[@enbox/auth] Local node eject requires an in-process DWN. The current agent is already in remote mode.'
    );
    expect(drainCalls).toBe(0);
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

type FetchLike = typeof fetch;

async function withoutGlobalFetch<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;

  delete (globalThis as { fetch?: FetchLike }).fetch;

  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      configurable : true,
      value        : originalFetch,
      writable     : true,
    });
  }
}
