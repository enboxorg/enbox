import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { importFromPortable } from '../src/connect/import.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

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

  test('registers explicit local identity sync scope and starts sync when enabled', async () => {
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
      {
        userAgent                    : agent,
        emitter,
        storage,
        defaultSync                  : '30s',
        defaultIdentitySyncProtocols : ['https://proto.example/profile'],
      },
      { portableIdentity: {} as any },
    );

    expect(syncRegCalls).toHaveLength(1);
    expect(syncRegCalls[0].options.protocols).toEqual(['https://proto.example/profile']);
    expect(syncStartCalls).toHaveLength(1);
    expect(syncStartCalls[0].mode).toBe('poll');
  });

  test('leaves local sync registration to the application when no identity scope is provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const unregisterCalls: string[] = [];
    const syncStartCalls: any[] = [];

    const agent = createMockAgent({
      identityImport         : async () => createMockIdentity(),
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
      syncStartSync          : async (params) => { syncStartCalls.push(params); },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: {} as any },
    );

    expect(unregisterCalls).toHaveLength(0);
    expect(syncStartCalls).toHaveLength(1);
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

  test('registers sync with protocols: all for delegate with unscoped Messages.Read grant', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const syncRegCalls: any[] = [];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const grantData = JSON.stringify({
      dateExpires : '2040-01-01T00:00:00Z',
      scope       : { interface: 'Messages', method: 'Read' },
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
            recordId      : 'g-unscoped',
            contextId     : 'g-unscoped',
            encodedData   : encoded,
            descriptor    : { interface: 'Records', method: 'Write', protocol: 'https://identity.foundation/dwn/permissions', protocolPath: 'grant', recipient: 'did:jwk:delegate', dateCreated: '2025-01-01T00:00:00Z', dataFormat: 'application/json', dataCid: 'bafytest', dataSize: 100 },
            authorization : { signature: { signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner#sig' })) }] } },
          }] } };
        }
        return { reply: { status: { code: 200, detail: 'OK' }, entries: [] } };
      },
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: {} as any },
    );

    expect(syncRegCalls).toHaveLength(1);
    expect(syncRegCalls[0].options.protocols).toBe('all');
    expect(syncRegCalls[0].options.delegateDid).toBe('did:jwk:delegate');
  });

  test('unregisters identity for delegate with zero grants (clears stale registration)', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const unregisterCalls: string[] = [];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const agent = createMockAgent({
      identityImport         : async () => delegateIdentity,
      syncUnregisterIdentity : async (did) => { unregisterCalls.push(did); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200, detail: 'OK' }, entries: [] },
      }),
    });

    await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: {} as any },
    );

    expect(unregisterCalls).toHaveLength(1);
    expect(unregisterCalls[0]).toBe('did:dht:owner');
  });

  test('tolerates "is not registered" error when unregistering zero-grant delegate', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const agent = createMockAgent({
      identityImport         : async () => delegateIdentity,
      syncUnregisterIdentity : async () => { throw new Error('is not registered'); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200, detail: 'OK' }, entries: [] },
      }),
    });

    const session = await importFromPortable(
      { userAgent: agent, emitter, storage, defaultSync: '30s' },
      { portableIdentity: {} as any },
    );

    expect(session).toBeDefined();
  });

  test('rethrows I/O errors from unregisterIdentity on zero-grant delegate path', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });

    const agent = createMockAgent({
      identityImport         : async () => delegateIdentity,
      syncUnregisterIdentity : async () => { throw new Error('LEVEL_IO_ERROR'); },
      processDwnRequest      : async () => ({
        reply: { status: { code: 200, detail: 'OK' }, entries: [] },
      }),
    });

    await expect(
      importFromPortable(
        { userAgent: agent, emitter, storage, defaultSync: '30s' },
        { portableIdentity: {} as any },
      )
    ).rejects.toThrow('LEVEL_IO_ERROR');
  });
});
