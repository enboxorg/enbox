import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { persistLocalDwnPairingRecord } from '../src/discovery.js';
import { vaultConnect } from '../src/connect/vault.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../src/types.js';

describe('vaultConnect', () => {
  test('first launch: initializes vault, creates identity when createIdentity is true', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const initCalls: any[] = [];
    const createCalls: any[] = [];
    const identity = createMockIdentity();

    const agent = createMockAgent({
      firstLaunch    : async () => true,
      initialize     : async (params) => { initCalls.push(params); return 'recovery phrase words'; },
      identityList   : async () => [],
      identityCreate : async (params) => { createCalls.push(params); return identity; },
    });

    const session = await vaultConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass', createIdentity: true },
    );

    // Vault was initialized with the password
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].password).toBe('test-pass');
    expect(initCalls[0].dwnEndpoints).toEqual(['https://enbox-dwn.fly.dev']);

    // Identity was created
    expect(createCalls).toHaveLength(1);

    // Session has recovery phrase
    expect(session.recoveryPhrase).toBe('recovery phrase words');
    expect(session.did).toBe('did:dht:testuser123');
    expect(session.agent).toBe(agent);

    // Storage was updated
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBe('did:dht:testuser123');
  });

  test('subsequent launch: unlocks vault, reconnects to existing identity', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity();

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [identity],
    });

    const session = await vaultConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass' },
    );

    // No recovery phrase on reconnect
    expect(session.recoveryPhrase).toBeUndefined();
    expect(session.did).toBe('did:dht:testuser123');
  });

  test('uses insecure default password and warns', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity();
    const startCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [identity],
      start        : async (params) => { startCalls.push(params); },
    });

    // No password passed — should use insecure default
    await vaultConnect(
      { userAgent: agent, emitter, storage },
      {},
    );

    expect(startCalls[0].password).toBe(INSECURE_DEFAULT_PASSWORD);
  });

  test('uses manager default password when no override given', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity();
    const startCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [identity],
      start        : async (params) => { startCalls.push(params); },
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage, defaultPassword: 'manager-pass' },
      {},
    );

    expect(startCalls[0].password).toBe('manager-pass');
  });

  test('emits vault-unlocked, identity-added, and session-start events', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const events: string[] = [];

    emitter.on('vault-unlocked', () => { events.push('vault-unlocked'); });
    emitter.on('identity-added', () => { events.push('identity-added'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [createMockIdentity()],
    });

    await vaultConnect({ userAgent: agent, emitter, storage }, {});

    expect(events).toEqual(['vault-unlocked', 'identity-added', 'session-start']);
  });

  test('registers explicit identity sync scope for new identities and agent DID when sync is not off', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch          : async () => true,
      identityList         : async () => [],
      identityCreate       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    await vaultConnect(
      {
        userAgent                    : agent,
        emitter,
        storage,
        defaultSync                  : '15s',
        defaultIdentitySyncProtocols : ['https://proto.example/profile'],
      },
      { createIdentity: true },
    );

    // Two registrations: agent DID (early, for recovery support) + new identity DID
    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[0].did).toBe('did:dht:testagent');
    expect(syncCalls[0].options.protocols).toEqual([
      'https://identity.foundation/protocols/web5/identity-store',
      'https://identity.foundation/protocols/web5/jwk-store',
    ]);
    expect(syncCalls[1].did).toBe('did:dht:testuser123');
    expect(syncCalls[1].options.protocols).toEqual(['https://proto.example/profile']);
  });

  test('recovers remote identities before creating a fallback identity on fresh vault restore', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const createCalls: any[] = [];
    const syncCalls: any[] = [];
    const updateCalls: any[] = [];
    const identity = createMockIdentity({
      metadata: { name: 'Recovered', tenant: 'did:dht:testagent' },
    });
    let pullCount = 0;
    let recoveredIdentityRegistrationCount = 0;

    const agent = createMockAgent({
      firstLaunch          : async () => true,
      initialize           : async () => 'recovery phrase words',
      identityList         : async () => (pullCount > 0 ? [identity] : []),
      identityCreate       : async (params) => { createCalls.push(params); return createMockIdentity(); },
      syncSync             : async () => { pullCount++; },
      syncRegisterIdentity : async (params) => {
        syncCalls.push(params);
        if (params.did === 'did:dht:testuser123') {
          recoveredIdentityRegistrationCount++;
          if (recoveredIdentityRegistrationCount > 1) {
            throw new Error('already registered');
          }
        }
      },
      syncUpdateIdentityOptions: async (params) => { updateCalls.push(params); },
    });

    const session = await vaultConnect(
      {
        userAgent                    : agent,
        emitter,
        storage,
        defaultSync                  : '15s',
        defaultIdentitySyncProtocols : ['https://proto.example/profile'],
      },
      { recoveryPhrase: 'existing recovery phrase', password: 'pass', createIdentity: true },
    );

    expect(session.did).toBe('did:dht:testuser123');
    expect(session.identity.name).toBe('Recovered');
    expect(createCalls).toHaveLength(0);
    expect(pullCount).toBe(2);
    expect(syncCalls.map((call) => call.did)).toEqual([
      'did:dht:testagent',
      'did:dht:testuser123',
      'did:dht:testuser123',
    ]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].did).toBe('did:dht:testuser123');
  });

  test('creates a fallback identity when fresh vault remote recovery fails', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const createCalls: any[] = [];
    const warn = console.warn;
    console.warn = (): void => {};

    try {
      const agent = createMockAgent({
        firstLaunch    : async () => true,
        initialize     : async () => 'recovery phrase words',
        identityList   : async () => [],
        identityCreate : async (params) => { createCalls.push(params); return createMockIdentity(); },
        syncSync       : async () => { throw new Error('remote unavailable'); },
      });

      const session = await vaultConnect(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
        { recoveryPhrase: 'existing recovery phrase', password: 'pass', createIdentity: true },
      );

      expect(session.did).toBe('did:dht:testuser123');
      expect(createCalls).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  test('registers the newly created identity tenant when registration options are provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    let registrationSuccesses = 0;

    const agent = createMockAgent({
      firstLaunch      : async () => true,
      identityList     : async () => [],
      identityCreate   : async () => createMockIdentity(),
      rpcGetServerInfo : async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await vaultConnect(
      {
        userAgent    : agent,
        emitter,
        storage,
        registration : {
          onSuccess : () => { registrationSuccesses++; },
          onFailure : () => {},
        },
      },
      { createIdentity: true },
    );

    expect(registrationSuccesses).toBe(2);
  });

  test('registers agent DID for sync even without identity creation', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch          : async () => true,
      initialize           : async () => 'phrase',
      identityList         : async () => [],
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    await vaultConnect(
      {
        userAgent                    : agent,
        emitter,
        storage,
        defaultIdentitySyncProtocols : ['https://proto.example/profile'],
      },
      { password: 'test-pass' },
    );

    // Only recovery registration; app identity scope must not overwrite the agent DID.
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:testagent');
    expect(syncCalls[0].options.protocols).toEqual([
      'https://identity.foundation/protocols/web5/identity-store',
      'https://identity.foundation/protocols/web5/jwk-store',
    ]);
  });

  test('skips sync registration when sync is off', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch          : async () => true,
      identityList         : async () => [],
      identityCreate       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
      syncStartSync        : async () => {},
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { createIdentity: true },
    );

    expect(syncCalls).toHaveLength(0);
  });

  test('uses custom DWN endpoints', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const initCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch    : async () => true,
      initialize     : async (params) => { initCalls.push(params); return 'phrase'; },
      identityList   : async () => [],
      identityCreate : async () => createMockIdentity(),
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage },
      { createIdentity: true, dwnEndpoints: ['https://custom-dwn.example.com'] },
    );

    expect(initCalls[0].dwnEndpoints).toEqual(['https://custom-dwn.example.com']);
  });

  test('handles wallet-connected identity (connectedDid set)', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate123' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [identity],
    });

    const session = await vaultConnect({ userAgent: agent, emitter, storage }, {});

    expect(session.did).toBe('did:dht:external');
    expect(session.delegateDid).toBe('did:dht:delegate123');
  });

  test('repairs persisted delegate sync scope from current grants', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const grantData = JSON.stringify({
      dateExpires : '2040-06-25T16:09:16.693356Z',
      scope       : { interface: 'Messages', method: 'Read', protocol: 'https://proto.example/chat' },
      delegated   : true,
    });
    const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const grantEntry = {
      recordId    : 'grant-1',
      contextId   : 'grant-1',
      encodedData : encoded,
      descriptor  : {
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/dwn/permissions',
        protocolPath : 'grant',
        recipient    : 'did:dht:external',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
        dataFormat   : 'application/json',
        dataCid      : 'bafytest',
        dataSize     : 100,
      },
      authorization: { signature: { signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner1#sig' })) }] } },
    };

    const delegateIdentity = createMockIdentity({
      metadata: { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      firstLaunch          : async () => false,
      identityList         : async () => [delegateIdentity],
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
      processDwnRequest    : async () => ({
        reply: { status: { code: 200 }, entries: [grantEntry] },
      }),
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[0].did).toBe('did:dht:testagent');
    expect(syncCalls[1].did).toBe('did:dht:external');
    expect(syncCalls[1].options.protocols).toEqual(['https://proto.example/chat']);
    expect(syncCalls[1].options.delegateDid).toBe('did:dht:testuser123');
  });

  test('clears stale persisted delegate sync registration when grants are gone', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const registerCalls: any[] = [];
    const unregisterCalls: string[] = [];

    const delegateIdentity = createMockIdentity({
      metadata: { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      firstLaunch            : async () => false,
      identityList           : async () => [delegateIdentity],
      syncRegisterIdentity   : async (params) => { registerCalls.push(params); },
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200 }, entries: [] },
      }),
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].did).toBe('did:dht:testagent');
    expect(unregisterCalls).toEqual(['did:dht:external']);
  });

  test('repairs persisted delegate sync registration even when sync is off', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const registerCalls: any[] = [];
    const unregisterCalls: string[] = [];

    const delegateIdentity = createMockIdentity({
      metadata: { name: 'Default', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      firstLaunch            : async () => false,
      identityList           : async () => [delegateIdentity],
      syncRegisterIdentity   : async (params) => { registerCalls.push(params); },
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200 }, entries: [] },
      }),
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(registerCalls).toHaveLength(0);
    expect(unregisterCalls).toEqual(['did:dht:external']);
  });

  test('does not re-register a persisted local identity during restore', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const registerCalls: any[] = [];
    const unregisterCalls: string[] = [];

    const agent = createMockAgent({
      firstLaunch            : async () => false,
      identityList           : async () => [createMockIdentity()],
      syncRegisterIdentity   : async (params) => { registerCalls.push(params); },
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].did).toBe('did:dht:testagent');
    expect(unregisterCalls).toHaveLength(0);
  });

  test('uses recovery phrase option for re-derivation', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const initCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch  : async () => true,
      initialize   : async (params) => { initCalls.push(params); return 'new-phrase'; },
      identityList : async () => [createMockIdentity()],
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage },
      { recoveryPhrase: 'existing recovery phrase', password: 'pass' },
    );

    expect(initCalls[0].recoveryPhrase).toBe('existing recovery phrase');
  });

  test('uses metadata name for new identity', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const createCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch    : async () => false,
      identityList   : async () => [],
      identityCreate : async (params) => { createCalls.push(params); return createMockIdentity({ metadata: { name: 'My Custom Name', tenant: 'did:dht:testagent' } }); },
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage },
      { createIdentity: true, metadata: { name: 'My Custom Name' } },
    );

    expect(createCalls[0].metadata.name).toBe('My Custom Name');
  });

  test('applies local DWN discovery from stored pairing', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity();

    await persistLocalDwnPairingRecord(storage, {
      createdAt    : 123,
      endpoint     : 'http://127.0.0.1:55557',
      pairedOrigin : 'https://app.example',
      token        : 'paired-token',
      version      : 1,
    });

    const setCalls: string[] = [];
    const agent = createMockAgent({
      firstLaunch                  : async () => false,
      identityList                 : async () => [identity],
      dwnSetCachedLocalDwnEndpoint : async (endpoint) => { setCalls.push(endpoint); return true; },
    });

    await vaultConnect({ userAgent: agent, emitter, storage }, {});

    // The stored endpoint should have been injected into the agent.
    expect(setCalls).toEqual(['http://127.0.0.1:55557']);
  });

  test('calls registration when registration options are provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity();

    let registrationSucceeded = false;
    const agent = createMockAgent({
      firstLaunch      : async () => false,
      identityList     : async () => [identity],
      rpcGetServerInfo : async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await vaultConnect(
      {
        userAgent    : agent,
        emitter,
        storage,
        registration : {
          onSuccess : () => { registrationSucceeded = true; },
          onFailure : () => {},
        },
      },
      {},
    );

    expect(registrationSucceeded).toBe(true);
  });

  test('createIdentity: false skips identity creation and uses agent DID', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const createCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch    : async () => true,
      initialize     : async () => 'recovery phrase words',
      identityList   : async () => [],
      identityCreate : async (params) => { createCalls.push(params); return createMockIdentity(); },
    });

    const session = await vaultConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass', createIdentity: false },
    );

    // Identity was NOT created
    expect(createCalls).toHaveLength(0);

    // Session uses the agent DID instead
    expect(session.did).toBe('did:dht:testagent');
    expect(session.agent).toBe(agent);
    expect(session.recoveryPhrase).toBe('recovery phrase words');

    // Session identity info uses the agent DID with fallback name
    expect(session.identity.didUri).toBe('did:dht:testagent');
    expect(session.identity.name).toBe('Agent');

    // Storage was updated with agent DID
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBe('did:dht:testagent');
  });

  test('createIdentity: false with existing identities uses the existing identity', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const identity = createMockIdentity();

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [identity],
    });

    const session = await vaultConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass', createIdentity: false },
    );

    // Existing identity is used, not the agent DID
    expect(session.did).toBe('did:dht:testuser123');
    expect(session.identity.name).toBe('Default');
  });

  test('createIdentity: false does not emit identity-added event', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const events: string[] = [];

    emitter.on('vault-unlocked', () => { events.push('vault-unlocked'); });
    emitter.on('identity-added', () => { events.push('identity-added'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({
      firstLaunch  : async () => true,
      initialize   : async () => 'phrase',
      identityList : async () => [],
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage },
      { createIdentity: false },
    );

    // identity-added should NOT be emitted since no identity was created
    expect(events).toEqual(['vault-unlocked', 'session-start']);
  });

  test('default (no createIdentity) skips identity creation', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const createCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch    : async () => true,
      initialize     : async () => 'phrase',
      identityList   : async () => [],
      identityCreate : async (params) => { createCalls.push(params); return createMockIdentity(); },
    });

    const session = await vaultConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass' },
    );

    // Identity was NOT created (default is false)
    expect(createCalls).toHaveLength(0);
    expect(session.did).toBe('did:dht:testagent');
  });

  test('skips startSync when sync is already running (hot-add path)', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const startSyncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch                : async () => false,
      identityList               : async () => [createMockIdentity()],
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : true,
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass' },
    );

    // startSync should NOT have been called because sync is already running.
    // registerIdentity would have hot-added the identity inline.
    expect(startSyncCalls).toHaveLength(0);
  });

  test('calls startSync when sync is not yet running', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const startSyncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch                : async () => false,
      identityList               : async () => [createMockIdentity()],
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await vaultConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass' },
    );

    // startSync should have been called because sync is not running yet.
    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ mode: 'live', interval: '5m' });
  });

  test('empty-string password fires the security warning (regression for #12)', async () => {
    // Empty string previously survived `??=` nullish-coalescing in
    // resolvePassword and reached `userAgent.initialize` silently — leaving
    // the vault encrypted with nothing. The warning now fires whenever
    // the effective password has zero length, in addition to the
    // INSECURE_DEFAULT_PASSWORD branch.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => { warnings.push(args.join(' ')); };
    try {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        initialize   : async () => 'phrase',
        identityList : async () => [],
      });

      await vaultConnect(
        { userAgent: agent, emitter, storage },
        { password: '' },
      );

      expect(warnings.some((w) => w.includes('SECURITY WARNING') && w.includes('empty string'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('no-password (insecure default) still fires the security warning', async () => {
    // Companion to the empty-string case above — verifies the original
    // INSECURE_DEFAULT_PASSWORD branch is still triggered when no
    // password is supplied anywhere.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => { warnings.push(args.join(' ')); };
    try {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      const agent = createMockAgent({
        firstLaunch  : async () => true,
        initialize   : async () => 'phrase',
        identityList : async () => [],
      });

      await vaultConnect(
        { userAgent: agent, emitter, storage },
        {},
      );

      expect(warnings.some((w) => w.includes('SECURITY WARNING'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
