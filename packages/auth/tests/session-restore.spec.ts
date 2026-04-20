import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';
import { restoreSession, retryOrphanedRevocations } from '../src/connect/restore.js';

describe('restoreSession', () => {
  test('returns undefined when no previous session exists', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    const agent = createMockAgent();

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeUndefined();
  });

  test('returns undefined when vault does not exist (stale flag)', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

    const agent = createMockAgent({ firstLaunch: async () => true });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeUndefined();

    // Stale flag should be cleaned up
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
  });

  test('returns undefined when no identity found and not an agent-only session', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityGet               : async () => undefined,
      identityList              : async () => [],
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeUndefined();

    // All session data should be cleaned up
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBeNull();
  });

  test('restores agent-only session when active identity is the agent DID', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:testagent');

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityGet               : async () => undefined,
      identityList              : async () => [],
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.did).toBe('did:dht:testagent');
    expect(session!.identity.name).toBe('Agent');
  });

  test('restores session from connected identity', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

    const identity = createMockIdentity({
      metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => identity,
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.did).toBe('did:dht:external');
    expect(session!.delegateDid).toBe('did:dht:testuser123');
  });

  test('restores session from active identity DID', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:specific');

    const identity = createMockIdentity({
      did: { uri: 'did:dht:specific' },
    });

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityGet               : async (params: any) => {
        if (params.didUri === 'did:dht:specific') { return identity; }
        return undefined;
      },
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.did).toBe('did:dht:specific');
  });

  test('falls back to first identity when active identity not found', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:missing');

    const identity = createMockIdentity();

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityGet               : async () => undefined,
      identityList              : async () => [identity],
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.did).toBe('did:dht:testuser123');
  });

  test('emits vault-unlocked and session-start events', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const events: string[] = [];

    emitter.on('vault-unlocked', () => { events.push('vault-unlocked'); });
    emitter.on('session-start', () => { events.push('session-start'); });

    const agent = createMockAgent({ firstLaunch: async () => false });

    await restoreSession({ userAgent: agent, emitter, storage });

    expect(events).toEqual(['vault-unlocked', 'session-start']);
  });

  test('applies local DWN discovery from stored endpoint', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

    // Pre-populate a stored endpoint (simulating a previous dwn:// redirect).
    await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, 'http://127.0.0.1:55557');

    const setCalls: string[] = [];
    const agent = createMockAgent({
      firstLaunch                  : async () => false,
      dwnSetCachedLocalDwnEndpoint : async (endpoint) => { setCalls.push(endpoint); return true; },
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();

    // The stored endpoint should have been injected into the agent.
    expect(setCalls).toEqual(['http://127.0.0.1:55557']);
  });

  test('uses insecure default password when none provided', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const startCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch : async () => false,
      start       : async (params) => { startCalls.push(params); },
    });

    await restoreSession({ userAgent: agent, emitter, storage });

    expect(startCalls[0].password).toBe('insecure-static-phrase');
  });

  test('uses stored delegate DID for non-connected identities', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:dht:storeddelegate');

    const identity = createMockIdentity();

    const agent = createMockAgent({
      firstLaunch               : async () => false,
      identityConnectedIdentity : async () => undefined,
      identityList              : async () => [identity],
    });

    const session = await restoreSession({ userAgent: agent, emitter, storage });
    expect(session).toBeDefined();
    expect(session!.delegateDid).toBe('did:dht:storeddelegate');
  });

  test('starts sync in poll mode when interval is set', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch   : async () => false,
      syncStartSync : async (params) => { syncCalls.push(params); },
    });

    await restoreSession({ userAgent: agent, emitter, storage, defaultSync: '30s' });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].mode).toBe('poll');
    expect(syncCalls[0].interval).toBe('30s');
  });

  test('skips sync when sync is off', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch   : async () => false,
      syncStartSync : async (params) => { syncCalls.push(params); },
    });

    await restoreSession({ userAgent: agent, emitter, storage, defaultSync: 'off' });

    expect(syncCalls).toHaveLength(0);
  });

  test('skips startSync when sync is already running', async () => {
    const emitter = new AuthEventEmitter();
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      firstLaunch                : async () => false,
      syncStartSync              : async (params) => { syncCalls.push(params); },
      syncHasActiveSubscriptions : true,
    });

    await restoreSession({ userAgent: agent, emitter, storage });

    // startSync should not be called because sync is already running.
    expect(syncCalls).toHaveLength(0);
  });

  describe('onPasswordRequired callback', () => {
    test('calls onPasswordRequired when no password is provided', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      const startCalls: any[] = [];

      const agent = createMockAgent({
        firstLaunch : async () => false,
        start       : async (params) => { startCalls.push(params); },
      });

      await restoreSession(
        { userAgent: agent, emitter, storage },
        { onPasswordRequired: async () => 'callback-password' },
      );

      expect(startCalls[0].password).toBe('callback-password');
    });

    test('prefers explicit password over onPasswordRequired', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      const startCalls: any[] = [];
      let callbackCalled = false;

      const agent = createMockAgent({
        firstLaunch : async () => false,
        start       : async (params) => { startCalls.push(params); },
      });

      await restoreSession(
        { userAgent: agent, emitter, storage },
        {
          password           : 'explicit-password',
          onPasswordRequired : async () => { callbackCalled = true; return 'callback-password'; },
        },
      );

      expect(startCalls[0].password).toBe('explicit-password');
      expect(callbackCalled).toBe(false);
    });

    test('prefers manager default password over onPasswordRequired', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      const startCalls: any[] = [];
      let callbackCalled = false;

      const agent = createMockAgent({
        firstLaunch : async () => false,
        start       : async (params) => { startCalls.push(params); },
      });

      await restoreSession(
        { userAgent: agent, emitter, storage, defaultPassword: 'manager-default' },
        { onPasswordRequired: async () => { callbackCalled = true; return 'callback-password'; } },
      );

      expect(startCalls[0].password).toBe('manager-default');
      expect(callbackCalled).toBe(false);
    });

    test('falls back to insecure default when callback not provided', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      const startCalls: any[] = [];

      const agent = createMockAgent({
        firstLaunch : async () => false,
        start       : async (params) => { startCalls.push(params); },
      });

      await restoreSession(
        { userAgent: agent, emitter, storage },
        {},
      );

      expect(startCalls[0].password).toBe('insecure-static-phrase');
    });
  });

  describe('refreshSyncRegistration', () => {
    test('falls back to updateIdentityOptions when registerIdentity throws already registered', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const updateCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async () => { throw new Error('already registered'); },
        syncUpdateIdentityOptions : async (params) => { updateCalls.push(params); },
        // Return a mock grant so deriveProtocolsFromGrants produces a non-empty
        // protocol list and the sync registration path is actually exercised.
        processDwnRequest         : async (params: any) => {
          if (params?.messageType === 'RecordsQuery') {
            return {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [buildMockGrantEntry('https://proto.example.com/notes')],
              },
            };
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].did).toBe('did:dht:external');
    });

    test('registers sync successfully when delegate has grants', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const registerCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async (params) => { registerCalls.push(params); },
        processDwnRequest         : async (params: any) => {
          if (params?.messageType === 'RecordsQuery') {
            return {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [buildMockGrantEntry('https://proto.example.com/notes')],
              },
            };
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].options.protocols).toContain('https://proto.example.com/notes');
    });

    test('does not start sync when registerIdentity fails with non-registration error', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const syncStartCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async () => { throw new Error('database unavailable'); },
        syncStartSync             : async (params) => { syncStartCalls.push(params); },
        processDwnRequest         : async (params: any) => {
          if (params?.messageType === 'RecordsQuery') {
            return {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [buildMockGrantEntry('https://proto.example.com/notes')],
              },
            };
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });

      // Restore succeeds but sync should NOT start — repair failed.
      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(syncStartCalls).toHaveLength(0);
    });

    test('unregisters sync when delegate has zero grants', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const registerCalls: any[] = [];
      const unregisterCalls: string[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async (params) => { registerCalls.push(params); },
        syncUnregisterIdentity    : async (did) => { unregisterCalls.push(did); },
        // Default processDwnRequest returns empty entries for RecordsQuery,
        // so deriveProtocolsFromGrants returns [] → unregister stale registration.
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(registerCalls).toHaveLength(0);
      expect(unregisterCalls).toHaveLength(1);
      expect(unregisterCalls[0]).toBe('did:dht:external');
    });

    test('tolerates unregister failure when identity was never registered', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncUnregisterIdentity    : async () => { throw new Error('is not registered'); },
      });

      // Should not throw — unregister failure is silently ignored in restore.
      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
    });
  });

  describe('stale state isolation', () => {
    test('does not rehydrate cleared delegate keys after a write-only reconnect', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const importedDecryptionKeys: any[] = [];
      const agent = createMockAgent({
        firstLaunch                     : async () => false,
        identityConnectedIdentity       : async () => identity,
        dwnImportDelegateDecryptionKeys : (did: string, keys: any[]) => { importedDecryptionKeys.push(...keys); },
      });

      // SecretStore and legacy storage are both empty (cleared by prior reconnect).
      // Restore should NOT import any decryption keys.
      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(importedDecryptionKeys).toHaveLength(0);
    });
  });

  describe('deriveProtocolsFromGrants', () => {
    test('filters out PermissionsProtocol.uri from derived protocols', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      // Build grant entries that include one with PermissionsProtocol.uri scope
      // and one with a normal protocol.
      const permissionsProtoUri = 'https://identity.foundation/dwn/permissions';
      const customProtoUri = 'https://myapp.example/proto';

      const registerCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async (params) => { registerCalls.push(params); },
        processDwnRequest         : async (params: any) => {
          if (params?.messageType === 'RecordsQuery') {
            return {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [
                  buildMockGrantEntry(customProtoUri),
                  buildMockGrantEntry(permissionsProtoUri),
                ],
              },
            };
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(registerCalls).toHaveLength(1);
      // Only the custom protocol should appear, not the permissions protocol.
      expect(registerCalls[0].options.protocols).toContain(customProtoUri);
      expect(registerCalls[0].options.protocols).not.toContain(permissionsProtoUri);
    });

    test('excludes revoked grants from sync scope', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const registerCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async (params) => { registerCalls.push(params); },
        processDwnRequest         : async (params: any) => {
          if (params?.messageType === 'RecordsQuery') {
            const filter = params.messageParams?.filter;
            if (filter?.protocolPath === 'grant') {
              // Return two grants: one valid, one that will be revoked.
              return {
                reply: {
                  status  : { code: 200, detail: 'OK' },
                  entries : [
                    buildMockGrantEntry('https://proto.example/valid'),
                    buildMockGrantEntry('https://proto.example/revoked'),
                  ],
                },
              };
            }
            if (filter?.protocolPath === 'grant/revocation') {
              // Return a revocation for the second grant.
              return {
                reply: {
                  status  : { code: 200, detail: 'OK' },
                  entries : [{ descriptor: { parentId: 'grant-https://proto.example/revoked' } }],
                },
              };
            }
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].options.protocols).toContain('https://proto.example/valid');
      expect(registerCalls[0].options.protocols).not.toContain('https://proto.example/revoked');
    });

    test('returns all for an unscoped grant (no protocol in scope)', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const registerCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async (params) => { registerCalls.push(params); },
        processDwnRequest         : async (params: any) => {
          if (params?.messageType === 'RecordsQuery') {
            return {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [buildUnscopedMockGrantEntry('grant-unrestricted')],
              },
            };
          }
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        },
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].options.protocols).toBe('all');
    });

    test('does not start sync when repair fails with I/O error', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const syncStartCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncUnregisterIdentity    : async () => { throw new Error('LEVEL_IO_ERROR'); },
        syncStartSync             : async (params) => { syncStartCalls.push(params); },
      });

      // Restore succeeds but sync should NOT start — repair failed.
      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(syncStartCalls).toHaveLength(0);
    });

    test('removes stale registration when repair fails so later sync cannot use it', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const unregisterCalls: string[] = [];
      const syncStartCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncStartSync             : async (params) => { syncStartCalls.push(params); },
        syncUnregisterIdentity    : async (did) => { unregisterCalls.push(did); },
        // Make grant derivation fail to trigger the repair-failure path.
        processDwnRequest         : async () => { throw new Error('store unavailable'); },
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      // Repair failed → sync should not start.
      expect(syncStartCalls).toHaveLength(0);
      // Stale registration should be best-effort removed so a later
      // manual startSync() cannot use stale scope.
      expect(unregisterCalls).toHaveLength(1);
      expect(unregisterCalls[0]).toBe('did:dht:external');
    });

    test('sets syncRepairFailed when registerIdentity throws non-registration error', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

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

      const syncStartCalls: any[] = [];
      const unregisterCalls: string[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncRegisterIdentity      : async () => { throw new Error('database write error'); },
        syncUnregisterIdentity    : async (did) => { unregisterCalls.push(did); },
        syncStartSync             : async (params) => { syncStartCalls.push(params); },
        processDwnRequest         : async () => ({
          reply: { status: { code: 200 }, entries: [grantEntry] },
        }),
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(syncStartCalls).toHaveLength(0);
      expect(unregisterCalls).toHaveLength(1);
    });

    test('sets syncRepairFailed when zero-grant unregister throws I/O error', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const syncStartCalls: any[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncUnregisterIdentity    : async () => { throw new Error('LEVEL_IO_ERROR'); },
        syncStartSync             : async (params) => { syncStartCalls.push(params); },
        processDwnRequest         : async () => ({
          reply: { status: { code: 200 }, entries: [] },
        }),
      });

      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: '15s' },
      );

      expect(session).toBeDefined();
      expect(syncStartCalls).toHaveLength(0);
    });

    test('repairs delegate registration even when sync is off', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');

      const identity = createMockIdentity({
        metadata: { name: 'Wallet', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
      });

      const unregisterCalls: string[] = [];
      const agent = createMockAgent({
        firstLaunch               : async () => false,
        identityConnectedIdentity : async () => identity,
        syncUnregisterIdentity    : async (did) => { unregisterCalls.push(did); },
      });

      // Sync is off — repair should still run to clean up stale registrations.
      const session = await restoreSession(
        { userAgent: agent, emitter, storage, defaultSync: 'off' },
      );

      expect(session).toBeDefined();
      // Zero grants (default mock) → unregister called.
      expect(unregisterCalls).toHaveLength(1);
      expect(unregisterCalls[0]).toBe('did:dht:external');
    });
  });

  describe('loadRetryEntries', () => {
    test('clears storage and returns empty when data is truly malformed', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      // Malformed: a plain string (not an array and not a valid legacy object).
      await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify('garbage'));

      const agent = createMockAgent({ firstLaunch: async () => false });

      // restoreSession triggers retryOrphanedRevocations which calls loadRetryEntries.
      const session = await restoreSession({ userAgent: agent, emitter, storage });
      expect(session).toBeDefined();

      // Malformed retry context should be cleared.
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    });

    test('clears storage and returns empty on JSON parse error', async () => {
      const emitter = new AuthEventEmitter();
      const storage = new MemoryStorage();
      await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
      // Invalid JSON.
      await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, '{not valid json!!!');

      const agent = createMockAgent({ firstLaunch: async () => false });

      const session = await restoreSession({ userAgent: agent, emitter, storage });
      expect(session).toBeDefined();

      // Parse-error retry context should be cleared.
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    });
  });

  describe('retryOrphanedRevocations', () => {
    test('clears retry state when entries are empty after load', async () => {
      const storage = new MemoryStorage();
      // An empty array is valid JSON but results in zero entries.
      await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, '[]');

      const agent = createMockAgent();

      await retryOrphanedRevocations(agent, storage);

      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    });

    test('sends revocation grant to remote endpoints during retry', async () => {
      const storage = new MemoryStorage();
      const rpcCalls: any[] = [];

      // Seed a retry entry with one grant to revoke.
      await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
        delegateDid  : 'did:jwk:delegate1',
        connectedDid : 'did:dht:owner1',
        revocations  : [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
      }]));

      const grantRecord = buildMockGrantRecord('grant-1');

      const agent = createMockAgent();
      // Override dwn.processRequest to return grant data for RecordsRead.
      (agent.dwn as any).processRequest = async (req: any): Promise<any> => {
        if (req.messageParams?.filter?.recordId) {
          const recordId = req.messageParams.filter.recordId;
          if (recordId === 'grant-1' || recordId === 'rev-grant-1') {
            const record = grantRecord;
            const encodedData = record.encodedData;
            const dataBytes = encodedData
              ? Uint8Array.from(atob(encodedData), (c: string): number => c.charCodeAt(0))
              : new Uint8Array(0);
            return {
              reply: {
                status : { code: 200 },
                entry  : {
                  recordsWrite : record,
                  data         : new ReadableStream({
                    start(controller: ReadableStreamDefaultController): void {
                      controller.enqueue(dataBytes);
                      controller.close();
                    },
                  }),
                },
              },
            };
          }
        }
        return { reply: { status: { code: 404 } } };
      };

      // Mock remote endpoint resolution.
      (agent.dwn as any).getRemoteDwnEndpointUrls = async (): Promise<string[]> =>
        ['https://dwn.example.com'];

      // Mock permissions.createRevocation.
      (agent as any).permissions = {
        createRevocation: async (params: any): Promise<any> => ({
          message: {
            recordId    : `rev-${params.grant.id}`,
            encodedData : btoa('{}'),
            descriptor  : {},
          },
        }),
      };

      // Mock rpc.sendDwnRequest to confirm delivery.
      (agent.rpc as any).sendDwnRequest = async (params: any): Promise<any> => {
        rpcCalls.push(params);
        return { status: { code: 202 } };
      };

      await retryOrphanedRevocations(agent, storage);

      // Revocation should have been sent to the remote endpoint.
      expect(rpcCalls.length).toBeGreaterThanOrEqual(1);
      expect(rpcCalls[0].dwnUrl).toBe('https://dwn.example.com');

      // Retry context should be cleared after success.
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Build a mock grant entry as returned by RecordsQuery (DwnDataEncodedRecordsWriteMessage).
 * Used by deriveProtocolsFromGrants tests.
 */
function buildMockGrantEntry(protocol: string): any {
  const grantData = JSON.stringify({
    dateExpires : '2040-06-25T16:09:16.693356Z',
    scope       : { interface: 'Messages', method: 'Read', protocol },
    delegated   : true,
  });
  const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    recordId    : `grant-${protocol}`,
    contextId   : `grant-${protocol}`,
    encodedData : encoded,
    descriptor  : {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : 'did:dht:testuser123',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:testagent#sig' })) }],
      },
    },
  };
}

/** Build an unscoped grant entry — no protocol in scope (unrestricted). */
function buildUnscopedMockGrantEntry(grantId: string): any {
  const grantData = JSON.stringify({
    dateExpires : '2040-06-25T16:09:16.693356Z',
    scope       : { interface: 'Messages', method: 'Read' },
    delegated   : true,
  });
  const encoded = btoa(grantData).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : encoded,
    descriptor  : {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : 'did:dht:testuser123',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:testagent#sig' })) }],
      },
    },
  };
}

/**
 * Build a mock grant record for RecordsRead (used by retryOrphanedRevocations).
 */
function buildMockGrantRecord(grantId: string): any {
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : btoa(JSON.stringify({
      dateExpires : '2040-06-25T16:09:16.693356Z',
      scope       : { interface: 'Messages', method: 'Read', protocol: 'https://test.xyz' },
      delegated   : true,
    })),
    descriptor: {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : 'did:jwk:delegate1',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner1#sig' })) }],
      },
    },
  };
}
