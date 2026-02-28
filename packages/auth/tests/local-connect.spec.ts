import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { localConnect } from '../src/flows/local-connect.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../src/types.js';

describe('localConnect', () => {
  test('first launch: initializes vault, creates identity, returns recovery phrase', async () => {
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

    const session = await localConnect(
      { userAgent: agent, emitter, storage },
      { password: 'test-pass' },
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

    const session = await localConnect(
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
    await localConnect(
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

    await localConnect(
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

    await localConnect({ userAgent: agent, emitter, storage }, {});

    expect(events).toEqual(['vault-unlocked', 'identity-added', 'session-start']);
  });

  test('registers sync for new identities when sync is not off', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch          : async () => true,
      identityList         : async () => [],
      identityCreate       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    await localConnect(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      {},
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:testuser123');
    expect(syncCalls[0].options.protocols).toEqual([]);
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

    await localConnect(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      {},
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

    await localConnect(
      { userAgent: agent, emitter, storage },
      { dwnEndpoints: ['https://custom-dwn.example.com'] },
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

    const session = await localConnect({ userAgent: agent, emitter, storage }, {});

    expect(session.did).toBe('did:dht:external');
    expect(session.delegateDid).toBe('did:dht:delegate123');
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

    await localConnect(
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

    await localConnect(
      { userAgent: agent, emitter, storage },
      { metadata: { name: 'My Custom Name' } },
    );

    expect(createCalls[0].metadata.name).toBe('My Custom Name');
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

    await localConnect(
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
});
