import { describe, expect, mock, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

// ── Module-level mocks ──────────────────────────────────────────
// We must preserve ALL original exports from @enbox/agent because
// mock.module() replaces the module globally for the entire test
// process. Only override the specific items we need to control.
//
// IMPORTANT: Do NOT mock @enbox/common — spreading a class (Convert)
// into a plain object loses its static methods, breaking downstream
// code that depends on Convert.uint8Array, Convert.hex, etc.

const actualAgent = await import('@enbox/agent');

const mockInitClient = mock((): any => Promise.resolve({
  delegatePortableDid : { uri: 'did:dht:delegate123' },
  connectedDid        : 'did:dht:connected456',
  delegateGrants      : [],
}));

const mockParseGrant = mock((message: any) => ({
  scope: message._scope ?? {},
}));

const actualWalletConnectClient = await import('../src/wallet-connect-client.js');

mock.module('../src/wallet-connect-client.js', () => ({
  ...actualWalletConnectClient,
  WalletConnect: {
    ...actualWalletConnectClient.WalletConnect,
    initClient: mockInitClient,
  },
}));

mock.module('@enbox/agent', () => ({
  ...actualAgent,
  DwnPermissionGrant: {
    ...actualAgent.DwnPermissionGrant,
    parse: mockParseGrant,
  },
}));

// Import module-under-test lazily. Bun resolves mock.module
// registrations before any import() calls in the same file.
let _walletConnect: any;
let _processConnectedGrants: any;

async function load(): Promise<void> {
  if (!_walletConnect) {
    const mod = await import('../src/connect/wallet.js');
    _walletConnect = mod.walletConnect;
    _processConnectedGrants = mod.processConnectedGrants;
  }
}

describe('processConnectedGrants', () => {
  test('returns empty array for no grants', async () => {
    await load();
    const agent = createMockAgent();
    const result = await _processConnectedGrants({
      agent,
      connectedDid : 'did:dht:connected',
      delegateDid  : 'did:dht:delegate',
      grants       : [],
    });
    expect(result).toEqual([]);
  });

  test('processes grants and returns protocol URIs', async () => {
    await load();
    const processCalls: any[] = [];
    const agent = createMockAgent({
      processDwnRequest: async (params: any) => {
        processCalls.push(params);
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      },
    });

    const grants = [
      {
        _scope        : { protocol: 'https://proto.example/chat' },
        encodedData   : 'dGVzdA',
        recordId      : 'rec1',
        descriptor    : {},
        authorization : {},
      },
      {
        _scope        : { protocol: 'https://proto.example/notes' },
        encodedData   : 'dGVzdA',
        recordId      : 'rec2',
        descriptor    : {},
        authorization : {},
      },
      {
        _scope        : {}, // no protocol — should be excluded
        encodedData   : 'dGVzdA',
        recordId      : 'rec3',
        descriptor    : {},
        authorization : {},
      },
    ] as any;

    const result = await _processConnectedGrants({
      agent,
      connectedDid : 'did:dht:connected',
      delegateDid  : 'did:dht:delegate',
      grants,
    });

    expect(result).toEqual(['https://proto.example/chat', 'https://proto.example/notes']);
    // 3 grants stored in delegate partition via processDwnRequest
    expect(processCalls).toHaveLength(3);

    // Verify processDwnRequest called with delegate partition params
    expect(processCalls[0].author).toBe('did:dht:delegate');
    expect(processCalls[0].target).toBe('did:dht:delegate');
    expect(processCalls[0].messageType).toBe('RecordsWrite');
    expect(processCalls[0].signAsOwner).toBe(true);
    expect(processCalls[0].store).toBe(true);
    // The connected partition writes go through dwn.processRawMessage
    // (not processDwnRequest), so they don't appear in processCalls.
  });

  test('deduplicates protocol URIs', async () => {
    await load();
    const agent = createMockAgent({
      processDwnRequest: async () => ({
        reply: { status: { code: 202, detail: 'Accepted' } },
      }),
    });

    const grants = [
      {
        _scope      : { protocol: 'https://proto.example/chat' },
        encodedData : 'dGVzdA',
        recordId    : 'rec1',
        descriptor  : {},
      },
      {
        _scope      : { protocol: 'https://proto.example/chat' },
        encodedData : 'dGVzdA',
        recordId    : 'rec2',
        descriptor  : {},
      },
    ] as any;

    const result = await _processConnectedGrants({
      agent,
      connectedDid : 'did:dht:connected',
      delegateDid  : 'did:dht:delegate',
      grants,
    });

    expect(result).toEqual(['https://proto.example/chat']);
  });

  test('throws when grant processing fails', async () => {
    await load();
    const agent = createMockAgent({
      processDwnRequest: async () => ({
        reply: { status: { code: 401, detail: 'Unauthorized' } },
      }),
    });

    const grants = [
      {
        _scope      : { protocol: 'https://proto.example/chat' },
        encodedData : 'dGVzdA',
        recordId    : 'rec1',
        descriptor  : {},
      },
    ] as any;

    await expect(
      _processConnectedGrants({
        agent,
        connectedDid : 'did:dht:connected',
        delegateDid  : 'did:dht:delegate',
        grants,
      })
    ).rejects.toThrow('Failed to store grant in delegate partition: Unauthorized');
  });
});

describe('walletConnect', () => {
  test('allows sync off without throwing', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    // Should not throw — sync: 'off' is now allowed.
    const session = await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(session.did).toBe('did:dht:connected456');
  });

  test('throws when initClient returns undefined/null', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const agent = createMockAgent({ firstLaunch: async () => false });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve(undefined));

    await expect(
      _walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Wallet connect flow was cancelled');
  });

  test('successful wallet connect creates session', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });
    const events: string[] = [];

    emitter.on('identity-added', () => { events.push('identity-added'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    const session = await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(session.did).toBe('did:dht:connected456');
    expect(session.delegateDid).toBe('did:dht:delegate123');
    expect(events).toEqual(['identity-added', 'session-start']);

    // Check storage
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBe('did:dht:connected456');
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBe('did:dht:delegate123');
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBe('did:dht:connected456');
  });

  test('passes correct options to initClient', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    let capturedOptions: any;
    mockInitClient.mockImplementationOnce((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve({
        delegatePortableDid : { uri: 'did:dht:delegate123' },
        connectedDid        : 'did:dht:connected456',
        delegateGrants      : [],
      });
    });

    await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(capturedOptions.displayName).toBe('Test App');
    expect(capturedOptions.connectServerUrl).toBe('https://relay.example.com');
    expect(capturedOptions.walletUri).toBe('enbox://connect');
  });

  test('uses custom walletUri when provided', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
    });

    let capturedOptions: any;
    mockInitClient.mockImplementationOnce((...args: any[]): any => {
      capturedOptions = args[0];
      return Promise.resolve({
        delegatePortableDid : { uri: 'did:dht:delegate123' },
        connectedDid        : 'did:dht:connected456',
        delegateGrants      : [],
      });
    });

    await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
        walletUri          : 'custom://wallet',
      },
    );

    expect(capturedOptions.walletUri).toBe('custom://wallet');
  });

  test('live sync mode when no interval specified', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncStartSync  : async (params: any) => { syncCalls.push(params); },
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    await _walletConnect(
      { userAgent: agent, emitter, storage }, // no defaultSync = live mode
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].mode).toBe('live');
    expect(syncCalls[0].interval).toBe('5m');
  });

  test('poll sync mode when interval specified', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncStartSync  : async (params: any) => { syncCalls.push(params); },
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].mode).toBe('poll');
    expect(syncCalls[0].interval).toBe('30s');
  });

  test('processes grants with identity import', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const processCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch       : async () => false,
      identityImport    : async () => identity,
      processDwnRequest : async (params: any) => {
        processCalls.push(params);
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      },
    });

    const grantData = [
      {
        _scope      : { protocol: 'https://proto.example/chat' },
        encodedData : 'dGVzdA',
        recordId    : 'rec1',
        descriptor  : {},
      },
    ];

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : grantData,
    }));

    const session = await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(session.did).toBe('did:dht:connected456');
    // 1 grant stored in delegate partition via processDwnRequest
    // (connected partition goes through dwn.processRawMessage)
    expect(processCalls).toHaveLength(1);
  });

  test('cleans up on identity import failure', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => { throw new Error('import failed'); },
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    await expect(
      _walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Wallet connect failed: import failed');
  });

  test('cleans up identity on post-import failure', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const deletedDids: string[] = [];
    const deletedIdentities: string[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch          : async () => false,
      identityImport       : async () => identity,
      didDelete            : async (params: any) => { deletedDids.push(params.didUri); },
      identityDelete       : async (params: any) => { deletedIdentities.push(params.didUri); },
      syncRegisterIdentity : async () => { throw new Error('sync reg failed'); },
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    await expect(
      _walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Wallet connect failed');

    expect(deletedDids).toContain('did:dht:delegate123');
    expect(deletedIdentities).toContain('did:dht:delegate123');
  });

  test('cleanup handles DID delete failure gracefully', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch          : async () => false,
      identityImport       : async () => identity,
      didDelete            : async () => { throw new Error('DID delete failed'); },
      identityDelete       : async () => { throw new Error('identity delete failed'); },
      syncRegisterIdentity : async () => { throw new Error('trigger cleanup'); },
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    // Should not throw from cleanup — only from the original error
    await expect(
      _walletConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        {
          displayName        : 'Test App',
          connectServerUrl   : 'https://relay.example.com',
          permissionRequests : [],
          onWalletUriReady   : () => {},
          validatePin        : async () => '1234',
        },
      )
    ).rejects.toThrow('Wallet connect failed: trigger cleanup');
  });

  test('option sync overrides context defaultSync', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncStartSync  : async (params: any) => { syncCalls.push(params); },
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
        sync               : '45s',
      },
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].interval).toBe('45s');
  });

  test('does not call sync.sync pull after registering identity (deferred to startSync)', async () => {
    await load();
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: string[] = [];
    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
    });

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityImport : async () => identity,
      syncSync       : async (dir: string) => { syncCalls.push(dir); },
    });

    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    await _walletConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    // sync('pull') is no longer called in importDelegateAndSetupSync —
    // startSyncIfEnabled() handles the initial sync cycle instead.
    expect(syncCalls).not.toContain('pull');
  });

  test('calls registration when registration options are provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    mockInitClient.mockClear();
    mockInitClient.mockImplementationOnce((): any => Promise.resolve({
      delegatePortableDid : { uri: 'did:dht:delegate123' },
      connectedDid        : 'did:dht:connected456',
      delegateGrants      : [],
    }));

    let registrationSucceeded = false;
    const agent = createMockAgent({
      identityImport: async () => createMockIdentity({
        did      : { uri: 'did:dht:delegate123' },
        metadata : { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:connected456' },
      }),
      rpcGetServerInfo: async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await _walletConnect(
      {
        userAgent    : agent,
        emitter,
        storage,
        defaultSync  : '15s',
        registration : {
          onSuccess : () => { registrationSucceeded = true; },
          onFailure : () => {},
        },
      },
      {
        displayName        : 'Test App',
        connectServerUrl   : 'https://relay.example.com',
        permissionRequests : [],
        onWalletUriReady   : () => {},
        validatePin        : async () => '1234',
      },
    );

    expect(registrationSucceeded).toBe(true);
  });
});
