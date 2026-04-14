import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { importFromPhrase, importFromPortable } from '../src/connect/import.js';

describe('importFromPhrase', () => {
  test('initializes vault and starts agent with recovery phrase', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const initCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch  : async () => true,
      initialize   : async (params) => { initCalls.push(params); return 'derived-phrase'; },
      identityList : async () => [createMockIdentity()],
    });

    const session = await importFromPhrase(
      { userAgent: agent, emitter, storage },
      { recoveryPhrase: 'word1 word2 word3', password: 'my-password' },
    );

    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].password).toBe('my-password');
    expect(initCalls[0].recoveryPhrase).toBe('word1 word2 word3');
    expect(session.did).toBe('did:dht:testuser123');
  });

  test('creates identity when none exists after import', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const createCalls: any[] = [];
    const newIdentity = createMockIdentity({ metadata: { name: 'Default', tenant: 'did:dht:testagent' } });

    const agent = createMockAgent({
      firstLaunch    : async () => true,
      identityList   : async () => [],
      identityCreate : async (params) => { createCalls.push(params); return newIdentity; },
    });

    await importFromPhrase(
      { userAgent: agent, emitter, storage },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(createCalls).toHaveLength(1);
  });

  test('persists session info to storage', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [createMockIdentity()],
    });

    await importFromPhrase(
      { userAgent: agent, emitter, storage },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBe('did:dht:testuser123');
  });

  test('emits events', async () => {
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

    await importFromPhrase(
      { userAgent: agent, emitter, storage },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(events).toEqual(['vault-unlocked', 'identity-added', 'session-start']);
  });

  test('registers sync when enabled', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch          : async () => true,
      identityList         : async () => [],
      identityCreate       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    await importFromPhrase(
      { userAgent: agent, emitter, storage, defaultSync: '15s' },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].options.protocols).toBe('all');
  });

  test('skips sync when disabled', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch          : async () => false,
      identityList         : async () => [createMockIdentity()],
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
      syncStartSync        : async () => {},
    });

    await importFromPhrase(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(syncCalls).toHaveLength(0);
  });

  test('uses custom DWN endpoints', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const initCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch  : async () => true,
      initialize   : async (params) => { initCalls.push(params); return 'phrase'; },
      identityList : async () => [createMockIdentity()],
    });

    await importFromPhrase(
      { userAgent: agent, emitter, storage },
      { recoveryPhrase: 'phrase', password: 'pass', dwnEndpoints: ['https://custom.example.com'] },
    );

    expect(initCalls[0].dwnEndpoints).toEqual(['https://custom.example.com']);
  });

  test('calls registration when registration options are provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    let registrationSucceeded = false;
    const agent = createMockAgent({
      firstLaunch      : async () => false,
      identityList     : async () => [createMockIdentity()],
      rpcGetServerInfo : async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await importFromPhrase(
      {
        userAgent    : agent,
        emitter,
        storage,
        registration : {
          onSuccess : () => { registrationSucceeded = true; },
          onFailure : () => {},
        },
      },
      { recoveryPhrase: 'phrase', password: 'pass' },
    );

    expect(registrationSucceeded).toBe(true);
  });
});

describe('importFromPortable', () => {
  test('imports identity and creates session', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const importCalls: any[] = [];
    const identity = createMockIdentity();

    const agent = createMockAgent({
      identityImport: async (params) => { importCalls.push(params); return identity; },
    });

    const session = await importFromPortable(
      { userAgent: agent, emitter, storage },
      { portableIdentity: { portableDid: { uri: 'did:dht:imported' } } as any },
    );

    expect(importCalls).toHaveLength(1);
    expect(session.did).toBe('did:dht:testuser123');
  });

  test('handles wallet-connected portable identity', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const identity = createMockIdentity({
      did      : { uri: 'did:dht:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      identityImport: async () => identity,
    });

    const session = await importFromPortable(
      { userAgent: agent, emitter, storage },
      { portableIdentity: {} as any },
    );

    expect(session.did).toBe('did:dht:external');
    expect(session.delegateDid).toBe('did:dht:delegate');
  });

  test('registers and starts sync when enabled', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncRegCalls: any[] = [];
    const syncStartCalls: any[] = [];

    const agent = createMockAgent({
      identityImport       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncRegCalls.push(params); },
      syncStartSync        : async (params) => { syncStartCalls.push(params); },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: {} as any },
    );

    expect(syncRegCalls).toHaveLength(1);
    expect(syncRegCalls[0].options.protocols).toBe('all');
    expect(syncStartCalls).toHaveLength(1);
    expect(syncStartCalls[0].mode).toBe('poll');
  });

  test('skips sync when disabled', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      identityImport       : async () => createMockIdentity(),
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: 'off' },
      { portableIdentity: {} as any },
    );

    expect(syncCalls).toHaveLength(0);
  });

  test('derives scoped sync from grants for delegate portable import', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncRegCalls: any[] = [];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const grantData = JSON.stringify({
      dateExpires : '2040-01-01T00:00:00Z',
      scope       : { interface: 'Messages', method: 'Read', protocol: 'https://proto.example/chat' },
      delegated   : true,
    });
    const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const agent = createMockAgent({
      identityImport       : async () => delegateIdentity,
      syncRegisterIdentity : async (params) => { syncRegCalls.push(params); },
      processDwnRequest    : async (params: any) => {
        const filter = params?.messageParams?.filter;
        if (filter?.protocolPath === 'grant') {
          return { reply: { status  : { code: 200, detail: 'OK' }, entries : [{
            recordId      : 'g1',
            contextId     : 'g1',
            encodedData   : encoded,
            descriptor    : { interface: 'Records', method: 'Write', protocol: 'https://identity.foundation/dwn/permissions', protocolPath: 'grant', recipient: 'did:jwk:delegate', dateCreated: '2025-01-01T00:00:00Z', dataFormat: 'application/json', dataCid: 'bafytest', dataSize: 100 },
            authorization : { signature: { signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner#sig' })) }] } },
          }] } };
        }
        // Revocations: none.
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: {} as any },
    );

    expect(syncRegCalls).toHaveLength(1);
    // Should register with the scoped protocol, NOT 'all'.
    expect(syncRegCalls[0].options.protocols).toEqual(['https://proto.example/chat']);
    expect(syncRegCalls[0].options.delegateDid).toBe('did:jwk:delegate');
  });

  test('persists session info', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const agent = createMockAgent({
      identityImport: async () => createMockIdentity(),
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage },
      { portableIdentity: {} as any },
    );

    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBe('true');
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBe('did:dht:testuser123');
  });

  test('emits identity-added and session-start events', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const events: string[] = [];

    emitter.on('identity-added', () => { events.push('identity-added'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({
      identityImport: async () => createMockIdentity(),
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage },
      { portableIdentity: {} as any },
    );

    expect(events).toEqual(['identity-added', 'session-start']);
  });

  test('calls registration when registration options are provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    let registrationSucceeded = false;
    const agent = createMockAgent({
      identityImport   : async () => createMockIdentity(),
      rpcGetServerInfo : async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await importFromPortable(
      {
        userAgent    : agent,
        emitter,
        storage,
        registration : {
          onSuccess : () => { registrationSucceeded = true; },
          onFailure : () => {},
        },
      },
      { portableIdentity: {} as any },
    );

    expect(registrationSucceeded).toBe(true);
  });
});
