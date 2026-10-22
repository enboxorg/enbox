/**
 * e2e: delegated grant revocation on disconnect
 *
 * Tests for https://github.com/enboxorg/enbox/issues/828
 *
 * Verifies that when a delegate session is disconnected:
 * 1. All delegated grants for the session are revoked
 * 2. Revocations are sent to remote DWN endpoints
 * 3. The session record clears only after durable revocation evidence exists
 * 4. Partial failure persists a self-contained REVOCATION_RETRY_CONTEXT
 * 5. Retry maintenance runs independently from session restore
 * 6. A new connect does NOT erase old retry context
 */

import { describe, expect, spyOn, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { AuthManager } from '../src/auth-manager.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { persistSessionBinding } from '../src/connect/session-state.js';
import { retryOrphanedRevocations } from '../src/index.js';
import { runAuthSessionLifecycle } from '../src/connect/lifecycle.js';
import { setStoredSession } from './helpers/session.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

function createTestManager(
  agent: any,
  opts: { storage?: MemoryStorage } = {},
): AuthManager {
  const storage = opts.storage ?? new MemoryStorage();
  const manager = Object.create(AuthManager.prototype) as any;
  manager._userAgent = agent;
  manager._emitter = new AuthEventEmitter();
  manager._storage = storage;
  manager._session = undefined;
  manager._state = 'unlocked';
  manager._isConnecting = false;
  manager._isShutDown = false;
  manager._isShuttingDown = false;
  manager._lifecycleController = new AbortController();
  manager._lifecycleCommitTail = Promise.resolve();
  manager._shutdownPromise = undefined;
  return manager as AuthManager;
}

/** Build a mock agent that supports the revocation disconnect flow. */
function buildRevocationAgent(opts: {
  grantRecords?: Record<string, any>;
  revocationCalls?: any[];
  rpcCalls?: any[];
  rpcError?: boolean;
  revocationError?: boolean;
}): any {
  const delegateIdentity = createMockIdentity({
    did      : { uri: 'did:jwk:delegate123' },
    metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
  });

  const agent = createMockAgent({
    firstLaunch  : async () => false,
    identityList : async () => [delegateIdentity],
  });

  // Mock dwn.processRequest to return specific grants by recordId
  (agent.dwn as any).processRequest = async (req: any): Promise<any> => {
    if (req.messageParams?.filter?.recordId && opts.grantRecords) {
      const recordId = req.messageParams.filter.recordId;
      const record = opts.grantRecords[recordId];
      if (record) {
        // Include data stream matching the grant's encodedData
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

  // Mock hosted DWN endpoint resolution.
  (agent.dwn as any).getRemoteDwnEndpointUrls = async (): Promise<string[]> =>
    ['https://dwn.example.com'];

  // Mock permissions.createRevocation
  (agent as any).permissions = {
    fetchGrants      : async (): Promise<any[]> => [],
    createRevocation : async (params: any): Promise<any> => {
      if (opts.revocationError) { throw new Error('revocation failed'); }
      opts.revocationCalls?.push(params);
      return {
        message: {
          recordId    : `rev-${params.grant.id}`,
          encodedData : btoa('{}'),
          descriptor  : {},
        },
      };
    },
  };

  // Mock rpc.sendDwnRequest
  (agent as any).rpc = {
    sendDwnRequest: async (params: any): Promise<any> => {
      if (opts.rpcError) { throw new Error('rpc failed'); }
      opts.rpcCalls?.push(params);
      return { status: { code: 202 } };
    },
  };

  return agent;
}

async function seedDelegatedSession(
  storage: MemoryStorage,
  revocations = [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
): Promise<void> {
  await setStoredSession(storage, 'did:dht:owner456', 'did:jwk:delegate123', revocations);
}

async function seedInterruptedDisconnect(
  storage: MemoryStorage,
  revocations = [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
): Promise<void> {
  await seedDelegatedSession(storage, revocations);
  await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
    delegateDid  : 'did:jwk:delegate123',
    connectedDid : 'did:dht:owner456',
    revocations,
  }]));
}

/** Build a mock grant record (as returned by RecordsRead). */
function mockGrantRecord(grantId: string): any {
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : btoa(JSON.stringify({
      dateExpires : '2040-06-25T16:09:16.693356Z',
      scope       : { interface: 'Records', method: 'Read', protocol: 'https://test.xyz' },
      delegated   : true,
    })),
    descriptor: {
      interface    : 'Records',
      method       : 'Write',
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : 'did:jwk:delegate123',
      dateCreated  : '2025-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{ protected: btoa(JSON.stringify({ kid: 'did:dht:owner456#sig' })) }],
      },
    },
  };
}

describe('grant revocation on disconnect', () => {
  test('explicit deletion retains active delegate keys when disconnect leaves pending revocations', async () => {
    const storage = new MemoryStorage();
    const agent = buildRevocationAgent({
      grantRecords : { 'grant-1': mockGrantRecord('grant-1') },
      rpcError     : true,
    });
    const keyDeletion = spyOn(agent.did, 'delete');
    const metadataDeletion = spyOn(agent.identity, 'delete');
    const manager = createTestManager(agent, { storage });
    await manager.switchIdentity('did:jwk:delegate123');
    await seedDelegatedSession(storage);

    await expect(manager.deleteIdentity('did:jwk:delegate123')).rejects.toThrow('pending grant revocations');

    expect(manager.session).toBeUndefined();
    expect(keyDeletion).not.toHaveBeenCalled();
    expect(metadataDeletion).not.toHaveBeenCalled();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).not.toBeNull();
    keyDeletion.mockRestore();
    metadataDeletion.mockRestore();
  });


  // 1. Partial disconnect clears the complete session record and persists retry context
  test('partial disconnect clears the session record and persists retry context', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);

    const agent = buildRevocationAgent({
      grantRecords : { 'grant-1': mockGrantRecord('grant-1') },
      rpcError     : true,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // The complete session record is cleared
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();

    // Self-contained retry context persisted with delegateDid + connectedDid + failed entries
    const retryCtxJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    expect(retryCtxJson).not.toBeNull();
    const entries = JSON.parse(retryCtxJson!);
    expect(entries).toHaveLength(1);
    expect(entries[0].delegateDid).toBe('did:jwk:delegate123');
    expect(entries[0].connectedDid).toBe('did:dht:owner456');
    expect(entries[0].revocations).toHaveLength(1);
    expect(entries[0].revocations[0].grantId).toBe('grant-1');
  });

  // 2. Successful disconnect creates per-grant revocations and sends to remote DWN
  test('disconnect creates per-grant revocations and sends to remote DWN', async () => {
    const storage = new MemoryStorage();
    await setStoredSession(storage, 'did:dht:owner456', 'did:jwk:delegate123', [
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
      { grantId: 'grant-2', revocationGrantId: 'rev-grant-2' },
    ]);

    const revocationCalls: any[] = [];
    const rpcCalls: any[] = [];
    const agent = buildRevocationAgent({
      grantRecords: {
        'grant-1' : mockGrantRecord('grant-1'),
        'grant-2' : mockGrantRecord('grant-2'),
      },
      revocationCalls,
      rpcCalls,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // Per-grant revocations created with correct mapping
    expect(revocationCalls).toHaveLength(2);
    expect(revocationCalls[0].permissionGrantId).toBe('rev-grant-1');
    expect(revocationCalls[0].granteeDid).toBe('did:jwk:delegate123');
    expect(revocationCalls[1].permissionGrantId).toBe('rev-grant-2');

    // Revocations sent to remote DWN
    expect(rpcCalls.length).toBeGreaterThanOrEqual(2);

    // The session record is cleared
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();

    // No retry context needed — all succeeded
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
  });

  // 3. Partial failure preserves unrevoked grants in retry context
  test('partial failure preserves unrevoked grants for retry', async () => {
    const storage = new MemoryStorage();
    await setStoredSession(storage, 'did:dht:owner456', 'did:jwk:delegate123', [
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
      { grantId: 'grant-missing', revocationGrantId: 'rev-grant-missing' },
    ]);

    const revocationCalls: any[] = [];
    const agent = buildRevocationAgent({
      grantRecords: {
        'grant-1': mockGrantRecord('grant-1'),
        // grant-missing is NOT in records — simulates a grant not found locally
      },
      revocationCalls,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // Only grant-1 was revoked
    expect(revocationCalls).toHaveLength(1);

    // The session record is cleared
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();

    // Retry context contains only the missing grant
    const retryCtxJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    expect(retryCtxJson).not.toBeNull();
    const entries = JSON.parse(retryCtxJson!);
    expect(entries).toHaveLength(1);
    expect(entries[0].revocations).toHaveLength(1);
    expect(entries[0].revocations[0].grantId).toBe('grant-missing');
    expect(entries[0].delegateDid).toBe('did:jwk:delegate123');
    expect(entries[0].connectedDid).toBe('did:dht:owner456');
  });

  // 4. Disconnect without session revocations clears all the session record
  test('disconnect without session revocations still clears local state', async () => {
    const storage = new MemoryStorage();
    await setStoredSession(storage, 'did:dht:owner', 'did:jwk:delegate');

    const agent = buildRevocationAgent({});
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
  });

  // 5. Revocation failure clears the session record, persists retry context
  test('revocation failure clears the session record but persists retry context', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);

    const agent = buildRevocationAgent({
      grantRecords    : { 'grant-1': mockGrantRecord('grant-1') },
      revocationError : true,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // The session record is cleared.
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();

    // Self-contained retry context persisted
    const retryCtxJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    expect(retryCtxJson).not.toBeNull();
    const entries = JSON.parse(retryCtxJson!);
    expect(entries).toHaveLength(1);
    expect(entries[0].delegateDid).toBe('did:jwk:delegate123');
    expect(entries[0].connectedDid).toBe('did:dht:owner456');
    expect(entries[0].revocations).toHaveLength(1);
  });

  // 6. Second disconnect is idempotent
  test('second disconnect is idempotent', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);

    let revocationCount = 0;
    const agent = buildRevocationAgent({
      grantRecords    : { 'grant-1': mockGrantRecord('grant-1') },
      revocationCalls : { push: (): number => ++revocationCount } as any,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    await manager.disconnect();
    expect(revocationCount).toBe(1);

    // Second disconnect — session already cleared, no revocations
    await manager.disconnect();
    expect(revocationCount).toBe(1);
  });

  test('invalid session data fails before journal or session mutation', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);
    const rpcCalls: any[] = [];
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
      rpcCalls,
    });
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    await storage.set(STORAGE_KEYS.SESSION, '{invalid json');
    await expect(manager.disconnect()).rejects.toThrow('AuthManager: Persisted session is invalid.');
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBe('{invalid json');
    expect(manager.session?.delegateDid).toBe('did:jwk:delegate123');
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(rpcCalls).toHaveLength(0);
    expect((manager as any)._session).toBeDefined();
  });

  test('a pre-journal write failure leaves the session record and delegate keys intact', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);
    const revocationCalls: any[] = [];
    let identityDeletes = 0;
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
      revocationCalls,
    });
    const originalIdentityGet = agent.identity.get.bind(agent.identity);
    let identityPresent = true;
    (agent.identity as any).get = async (params: any): Promise<any> =>
      identityPresent ? originalIdentityGet(params) : undefined;
    (agent.identity as any).delete = async (): Promise<void> => {
      identityDeletes++;
      identityPresent = false;
    };
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    const originalSet = storage.set.bind(storage);
    const set = spyOn(storage, 'set').mockImplementation((key, value): Promise<void> => {
      if (key === STORAGE_KEYS.REVOCATION_RETRY_CONTEXT) {
        return Promise.reject(new Error('injected pre-journal failure'));
      }
      return originalSet(key, value);
    });

    await expect(manager.disconnect()).rejects.toThrow('injected pre-journal failure');
    expect(await storage.get(STORAGE_KEYS.SESSION)).not.toBeNull();
    expect(JSON.parse((await storage.get(STORAGE_KEYS.SESSION))!).delegateDid).toBe('did:jwk:delegate123');
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(revocationCalls).toHaveLength(0);
    expect(identityDeletes).toBe(0);

    set.mockRestore();
    await manager.disconnect();
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect(identityDeletes).toBe(1);
  });

  test('a failed narrowed-journal write preserves every grant for restart retry', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage, [
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
      { grantId: 'grant-2', revocationGrantId: 'rev-grant-2' },
    ]);
    const agent = buildRevocationAgent({
      grantRecords: {
        'grant-1' : mockGrantRecord('grant-1'),
        'grant-2' : mockGrantRecord('grant-2'),
      },
    });
    let sendCount = 0;
    (agent.rpc as any).sendDwnRequest = async (): Promise<any> => {
      sendCount++;
      if (sendCount === 2) {
        throw new Error('first attempt leaves grant-2 pending');
      }
      return { status: { code: sendCount === 3 ? 409 : 202 } };
    };
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    const originalSet = storage.set.bind(storage);
    let retryWrites = 0;
    const set = spyOn(storage, 'set').mockImplementation((key, value): Promise<void> => {
      if (key === STORAGE_KEYS.REVOCATION_RETRY_CONTEXT && ++retryWrites === 2) {
        return Promise.reject(new Error('injected narrowed-journal failure'));
      }
      return originalSet(key, value);
    });

    await manager.disconnect();
    const journalAfterFailure = JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!);
    expect(journalAfterFailure[0].revocations).toHaveLength(2);
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();

    set.mockRestore();
    expect(await createTestManager(agent, { storage }).restoreSession()).toBeUndefined();
    expect(sendCount).toBe(4);
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
  });

  test('a restart settles durable retry work before retiring the delegate identity', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);
    let remoteAvailable = false;
    const identityDeleteStates: { retry: string | null; session: string | null }[] = [];
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
    });
    (agent.rpc as any).sendDwnRequest = async (): Promise<any> => {
      if (!remoteAvailable) {
        throw new Error('remote unavailable');
      }
      return { status: { code: 409 } };
    };
    (agent.identity as any).delete = async (): Promise<void> => {
      identityDeleteStates.push({
        retry   : await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT),
        session : await storage.get(STORAGE_KEYS.SESSION),
      });
    };
    const firstManager = createTestManager(agent, { storage });
    await firstManager.connect({ password: 'test' });
    await firstManager.disconnect();

    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).not.toBeNull();
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect(identityDeleteStates).toHaveLength(0);

    remoteAvailable = true;
    const reopenedManager = createTestManager(agent, { storage });
    expect(await reopenedManager.restoreSession()).toBeUndefined();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(identityDeleteStates).toEqual([{ retry: null, session: null }]);
  });

  test('restart completes a journaled disconnect instead of restoring the revoked delegate', async () => {
    const storage = new MemoryStorage();
    await seedInterruptedDisconnect(storage);
    const identityDeleteStates: { previous: string | null; retry: string | null }[] = [];
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
    });
    const originalIdentityGet = agent.identity.get.bind(agent.identity);
    let identityPresent = true;
    (agent.identity as any).get = async (params: any): Promise<any> =>
      identityPresent ? originalIdentityGet(params) : undefined;
    (agent.identity as any).delete = async (): Promise<void> => {
      identityDeleteStates.push({
        previous : await storage.get(STORAGE_KEYS.SESSION),
        retry    : await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT),
      });
      identityPresent = false;
    };
    const manager = createTestManager(agent, { storage });

    expect(await manager.restoreSession()).toBeUndefined();
    expect((manager as any)._session).toBeUndefined();
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(identityDeleteStates).toEqual([{ previous: null, retry: null }]);

    // Reopening after every cleanup step is complete remains a no-op.
    expect(await createTestManager(agent, { storage }).restoreSession()).toBeUndefined();
    expect(identityDeleteStates).toHaveLength(1);
  });

  test('public retry completes a journaled disconnect before consuming its durable intent', async () => {
    const storage = new MemoryStorage();
    await seedInterruptedDisconnect(storage);
    const revocationCalls: any[] = [];
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
      revocationCalls,
    });
    const clearKeys = spyOn(agent.dwn, 'clearDelegateDecryptionKeys');

    await retryOrphanedRevocations(agent, storage);

    expect(revocationCalls).toHaveLength(1);
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(clearKeys).toHaveBeenCalledWith('did:jwk:delegate123');
    expect(await createTestManager(agent, { storage }).restoreSession()).toBeUndefined();
    clearKeys.mockRestore();
  });

  test('a fresh manager disconnect completes journaled teardown before consuming its durable intent', async () => {
    const storage = new MemoryStorage();
    await seedInterruptedDisconnect(storage);
    const rpcCalls: any[] = [];
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
      rpcCalls,
    });
    const sessionsAtSend: Array<string | null> = [];
    const send = agent.rpc.sendDwnRequest.bind(agent.rpc);
    agent.rpc.sendDwnRequest = async (params: any): Promise<any> => {
      sessionsAtSend.push(await storage.get(STORAGE_KEYS.SESSION));
      return send(params);
    };
    const clearKeys = spyOn(agent.dwn, 'clearDelegateDecryptionKeys');
    const manager = await AuthManager.create({ agent, storage, password: 'test', sync: 'off' });
    try {
      expect(manager.session).toBeUndefined();

      await manager.disconnect();

      expect(rpcCalls).toHaveLength(1);
      expect(sessionsAtSend).toEqual([null]);
      expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
      expect(clearKeys).toHaveBeenCalledWith('did:jwk:delegate123');
      expect(await manager.restoreSession()).toBeUndefined();
      expect(manager.session).toBeUndefined();
    } finally {
      await manager.shutdown();
      clearKeys.mockRestore();
    }
  });

  test('restore cannot publish a session while another context disconnects', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);

    const disconnectAgent = buildRevocationAgent({
      grantRecords : { 'grant-1': mockGrantRecord('grant-1') },
      rpcError     : true,
    });
    const disconnectManager = createTestManager(disconnectAgent, { storage });
    await disconnectManager.connect({ password: 'test' });

    const restoreAgent = buildRevocationAgent({});
    const originalIdentityGet = restoreAgent.identity.get.bind(restoreAgent.identity);
    let reachedIdentityLookup!: () => void;
    const identityLookupReached = new Promise<void>((resolve) => { reachedIdentityLookup = resolve; });
    let releaseIdentityLookup!: () => void;
    const identityLookupGate = new Promise<void>((resolve) => { releaseIdentityLookup = resolve; });
    let pauseIdentityLookup = true;
    (restoreAgent.identity as any).get = async (params: any): Promise<any> => {
      if (pauseIdentityLookup) {
        pauseIdentityLookup = false;
        reachedIdentityLookup();
        await identityLookupGate;
      }
      return originalIdentityGet(params);
    };

    const restoreManager = createTestManager(restoreAgent, { storage });
    const restorePromise = restoreManager.restoreSession();
    await identityLookupReached;
    await disconnectManager.disconnect();
    releaseIdentityLookup();

    expect(await restorePromise).toBeUndefined();
    expect((restoreManager as any)._session).toBeUndefined();
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).not.toBeNull();
  });

  test('a stale manager retires only its old delegate after a replacement session commits', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);
    const revocationCalls: any[] = [];
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
      revocationCalls,
    });
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    const replacementRevocations = [{ grantId: 'replacement-grant', revocationGrantId: 'replacement-revoker' }];
    const removeIdentity = spyOn(agent.sync, 'removeIdentity');
    const clearKeys = spyOn(agent.dwn, 'clearDelegateDecryptionKeys');
    const deleteIdentity = spyOn(agent.identity, 'delete');
    try {
      await runAuthSessionLifecycle(() => persistSessionBinding({
        userAgent          : agent,
        storage,
        connectedDid       : 'did:dht:owner456',
        delegateDid        : 'did:jwk:replacement',
        sessionRevocations : replacementRevocations,
      }));
      const replacement = await storage.get(STORAGE_KEYS.SESSION);
      removeIdentity.mockClear();

      await manager.disconnect();

      expect(await storage.get(STORAGE_KEYS.SESSION)).toBe(replacement);
      expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
      expect(revocationCalls.map(call => call.grant.id)).toEqual(['grant-1']);
      expect(removeIdentity).toHaveBeenCalledWith('did:dht:owner456', {
        expectedDelegateDid : 'did:jwk:delegate123',
        timeout             : 0,
      });
      expect(clearKeys).toHaveBeenCalledWith('did:jwk:delegate123');
      expect(clearKeys).not.toHaveBeenCalledWith('did:jwk:replacement');
      expect(deleteIdentity).toHaveBeenCalledWith({ didUri: 'did:jwk:delegate123' });
      expect(deleteIdentity).not.toHaveBeenCalledWith({ didUri: 'did:jwk:replacement' });
    } finally {
      removeIdentity.mockRestore();
      clearKeys.mockRestore();
      deleteIdentity.mockRestore();
    }
  });

  test('retry work for another delegate does not clear or suppress the active session', async () => {
    const storage = new MemoryStorage();
    const activeDelegateDid = 'did:jwk:active-delegate';
    const activeConnectedDid = 'did:dht:owner456';
    await setStoredSession(storage, activeConnectedDid, activeDelegateDid);
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:delegate123',
      connectedDid : 'did:dht:owner456',
      revocations  : [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
    }]));

    const retryIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate123' },
      metadata : { name: 'Old', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
    });
    const activeIdentity = createMockIdentity({
      did      : { uri: activeDelegateDid },
      metadata : { name: 'Active', tenant: 'did:dht:testagent', connectedDid: activeConnectedDid },
    });
    const deletedIdentities: string[] = [];
    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
    });
    (agent.identity as any).list = async (): Promise<any[]> => [retryIdentity, activeIdentity];
    (agent.identity as any).get = async ({ didUri }: any): Promise<any> =>
      [retryIdentity, activeIdentity].find(identity => identity.did.uri === didUri);
    (agent.identity as any).connectedIdentity = async (): Promise<any> => activeIdentity;
    (agent.identity as any).delete = async ({ didUri }: any): Promise<void> => {
      deletedIdentities.push(didUri);
    };
    const removeSyncIdentity = spyOn(agent.sync, 'removeIdentity');

    const session = await createTestManager(agent, { storage }).restoreSession();

    expect(session?.delegateDid).toBe(activeDelegateDid);
    expect(session?.did).toBe(activeConnectedDid);
    expect(JSON.parse((await storage.get(STORAGE_KEYS.SESSION))!)).toEqual({
      connectedDid : activeConnectedDid,
      delegateDid  : activeDelegateDid,
      revocations  : [],
    });
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(removeSyncIdentity).toHaveBeenCalledWith('did:dht:owner456', {
      expectedDelegateDid : 'did:jwk:delegate123',
      timeout             : 0,
    });
    expect(deletedIdentities).toEqual(['did:jwk:delegate123']);
  });

  // 7. Retry-only restore returns undefined and stops sync
  test('retry-only restore runs maintenance and returns undefined', async () => {
    const storage = new MemoryStorage();
    // Simulate state left by a partial disconnect:
    // - SESSION is absent (user disconnected)
    // - REVOCATION_RETRY_CONTEXT is set (self-contained blob)
    const pendingJournal = JSON.stringify([{
      delegateDid  : 'did:jwk:delegate123',
      connectedDid : 'did:dht:owner456',
      revocations  : [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
    }]);
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, pendingJournal);

    let syncStopped = false;
    const agent = buildRevocationAgent({
      grantRecords : { 'grant-1': mockGrantRecord('grant-1') },
      rpcError     : true, // remote send fails — retry won't fully succeed
    });
    const sendRequest = spyOn(agent.rpc, 'sendDwnRequest');
    // Track sync lifecycle
    (agent.sync as any).stopSync = async (): Promise<void> => { syncStopped = true; };

    const manager = createTestManager(agent, { storage });

    // restoreSession should enter retry-only path
    const session = await manager.restoreSession();

    // No session restored — user disconnected
    expect(session).toBeUndefined();

    // Sync was stopped after retry (not left running)
    expect(syncStopped).toBe(true);

    // Manager has no active session
    expect(manager.session).toBeUndefined();

    // Retry context still present (RPC failed so retry didn't succeed)
    expect(sendRequest).toHaveBeenCalled();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBe(pendingJournal);
  });

  // 8. Retry maintenance and session restore coexist
  test('retry maintenance and session restore coexist', async () => {
    const storage = new MemoryStorage();
    // Both the retry journal and a restorable session exist.
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:old-delegate',
      connectedDid : 'did:dht:old-owner',
      revocations  : [{ grantId: 'grant-old', revocationGrantId: 'rev-grant-old' }],
    }]));
    await setStoredSession(storage, 'did:dht:testuser123');

    let syncStartCount = 0;
    let syncStopCount = 0;

    const agent = buildRevocationAgent({
      grantRecords: { 'grant-old': mockGrantRecord('grant-old') },
    });
    (agent.identity as any).get = async ({ didUri }: any): Promise<any> =>
      didUri === 'did:dht:testuser123' ? createMockIdentity() : undefined;
    (agent.sync as any).startSync = async (): Promise<void> => { syncStartCount++; };
    (agent.sync as any).stopSync = async (): Promise<void> => { syncStopCount++; };

    const manager = createTestManager(agent, { storage });
    const session = await manager.restoreSession();

    // The persisted session was restored.
    expect(session).toBeDefined();

    // Sync was started twice (once for retry, once for restored session)
    // and stopped once (after retry completed)
    expect(syncStartCount).toBe(2);
    expect(syncStopCount).toBe(1);
  });

  // 9. Successful retry clears context
  test('successful retry clears context without affecting session', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:delegate123',
      connectedDid : 'did:dht:owner456',
      revocations  : [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
    }]));
    // No persisted session — retry only

    const agent = buildRevocationAgent({
      grantRecords: { 'grant-1': mockGrantRecord('grant-1') },
      // rpcError NOT set — RPC succeeds
    });

    const manager = createTestManager(agent, { storage });
    const session = await manager.restoreSession();

    // No session restored
    expect(session).toBeUndefined();

    // Retry context cleared after successful retry
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
  });

  // 10. Partial retry rewrites context with remaining entries
  test('partial retry rewrites context with remaining entries', async () => {
    const rpcCalls: any[] = [];
    let callCount = 0;
    const agent = buildRevocationAgent({
      grantRecords: {
        'grant-1' : mockGrantRecord('grant-1'),
        'grant-2' : mockGrantRecord('grant-2'),
      },
    });
    // First RPC call succeeds, second fails
    (agent as any).rpc = {
      sendDwnRequest: async (params: any): Promise<any> => {
        rpcCalls.push(params);
        callCount++;
        if (callCount <= 1) {
          return { status: { code: 202 } };
        }
        throw new Error('rpc failed');
      },
    };

    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:delegate123',
      connectedDid : 'did:dht:owner456',
      revocations  : [
        { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
        { grantId: 'grant-2', revocationGrantId: 'rev-grant-2' },
      ],
    }]));

    const manager = createTestManager(agent, { storage });
    await manager.restoreSession();

    // Retry context rewritten with only the failed entry
    const retryCtxJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    expect(retryCtxJson).not.toBeNull();
    const entries = JSON.parse(retryCtxJson!);
    expect(entries).toHaveLength(1);
    expect(entries[0].revocations).toHaveLength(1);
    expect(entries[0].revocations[0].grantId).toBe('grant-2');
    expect(entries[0].delegateDid).toBe('did:jwk:delegate123');
    expect(entries[0].connectedDid).toBe('did:dht:owner456');
  });

  // 11. Old retry context survives new connect
  test('old retry context survives new connect', async () => {
    const storage = new MemoryStorage();
    // Old retry context from a previous failed disconnect
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:old-delegate',
      connectedDid : 'did:dht:old-owner',
      revocations  : [{ grantId: 'grant-old', revocationGrantId: 'rev-grant-old' }],
    }]));

    const agent = buildRevocationAgent({});
    const manager = createTestManager(agent, { storage });

    // New connect
    await manager.connect({ password: 'test' });

    // Old retry context still exists — connect does NOT erase it
    const retryCtxJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    expect(retryCtxJson).not.toBeNull();
    const entries = JSON.parse(retryCtxJson!);
    expect(entries).toHaveLength(1);
    expect(entries[0].delegateDid).toBe('did:jwk:old-delegate');
  });

  test('concurrent retry cannot overwrite a newly staged disconnect', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:old-delegate-A',
      connectedDid : 'did:dht:owner-A',
      revocations  : [{ grantId: 'grant-A1', revocationGrantId: 'rev-A1' }],
    }]));
    await seedDelegatedSession(storage, [{ grantId: 'grant-B1', revocationGrantId: 'rev-B1' }]);

    const disconnectAgent = buildRevocationAgent({
      grantRecords : { 'grant-B1': mockGrantRecord('grant-B1') },
      rpcError     : true,
    });
    const manager = createTestManager(disconnectAgent, { storage });
    await manager.connect({ password: 'test' });

    const retryIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:old-delegate-A' },
      metadata : { name: 'Old', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner-A' },
    });
    const retryAgent = buildRevocationAgent({
      grantRecords: { 'grant-A1': mockGrantRecord('grant-A1') },
    });
    (retryAgent.identity as any).get = async ({ didUri }: any): Promise<any> =>
      didUri === retryIdentity.did.uri ? retryIdentity : undefined;
    let retryAttempted = false;
    const resolveEndpoints = retryAgent.dwn.getRemoteDwnEndpointUrls.bind(retryAgent.dwn);
    (retryAgent.dwn as any).getRemoteDwnEndpointUrls = async (didUri: string): Promise<string[]> => {
      retryAttempted = true;
      return resolveEndpoints(didUri);
    };

    const originalSet = storage.set.bind(storage);
    let stageWriteReached!: () => void;
    const stageWriteStarted = new Promise<void>((resolve) => { stageWriteReached = resolve; });
    let releaseStageWrite!: () => void;
    const stageWriteGate = new Promise<void>((resolve) => { releaseStageWrite = resolve; });
    let blockStageWrite = true;
    const set = spyOn(storage, 'set').mockImplementation(async (key, value): Promise<void> => {
      if (key === STORAGE_KEYS.REVOCATION_RETRY_CONTEXT && blockStageWrite) {
        blockStageWrite = false;
        stageWriteReached();
        await stageWriteGate;
      }
      await originalSet(key, value);
    });

    const disconnectPromise = manager.disconnect();
    await stageWriteStarted;
    const retryPromise = retryOrphanedRevocations(retryAgent, storage);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(retryAttempted).toBe(false);

    releaseStageWrite();
    await disconnectPromise;
    await retryPromise;
    set.mockRestore();

    const entries = JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!);
    expect(entries.map((entry: any) => entry.delegateDid)).toEqual(['did:jwk:delegate123']);
  });

  test('clearStorage disconnect does not repersist retry context after wipe', async () => {
    const storage = new MemoryStorage();
    await setStoredSession(storage, 'did:dht:owner', 'did:jwk:delegate', [
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
    ]);

    // Revocations will fail (RPC error) — but clearStorage should prevent retry context
    const agent = buildRevocationAgent({
      grantRecords : { 'grant-1': mockGrantRecord('grant-1') },
      rpcError     : true,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    // Nuclear wipe disconnect
    await manager.disconnect({ clearStorage: true });

    // Storage should be completely empty — no retry context repersisted
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
  });

  test('clearStorage wipes malformed revocation state', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);
    const manager = createTestManager(buildRevocationAgent({}), { storage });
    await manager.connect({ password: 'test' });
    await storage.set(STORAGE_KEYS.SESSION, '{invalid json');

    await manager.disconnect({ clearStorage: true });

    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect((manager as any)._session).toBeUndefined();
  });

  test('clearStorage wipes when the retry journal cannot be staged', async () => {
    const storage = new MemoryStorage();
    await seedDelegatedSession(storage);
    const manager = createTestManager(buildRevocationAgent({}), { storage });
    await manager.connect({ password: 'test' });
    const originalSet = storage.set.bind(storage);
    const set = spyOn(storage, 'set').mockImplementation((key, value): Promise<void> => {
      if (key === STORAGE_KEYS.REVOCATION_RETRY_CONTEXT) {
        return Promise.reject(new Error('storage full'));
      }
      return originalSet(key, value);
    });

    await manager.disconnect({ clearStorage: true });

    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
    expect((manager as any)._session).toBeUndefined();
    set.mockRestore();
  });

  test('successful disconnect prunes stale retry entry for same delegate', async () => {
    const storage = new MemoryStorage();

    // Pre-existing retry context from a previous partial disconnect
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([
      { delegateDid  : 'did:jwk:delegate123', connectedDid : 'did:dht:owner456', revocations  : [
        { grantId: 'old-grant', revocationGrantId: 'old-rev' },
      ] },
      { delegateDid  : 'did:jwk:other-delegate', connectedDid : 'did:dht:other-owner', revocations  : [
        { grantId: 'other-grant', revocationGrantId: 'other-rev' },
      ] },
    ]));

    // Session with same delegateDid that will disconnect cleanly
    await setStoredSession(storage, 'did:dht:owner456', 'did:jwk:delegate123');
    // The active session has no grants; its journaled grants still need retry.

    const agent = buildRevocationAgent({
      grantRecords: { 'old-grant': mockGrantRecord('old-grant') },
    });
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // The stale entry for did:jwk:delegate123 should be pruned
    const ctxJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    expect(ctxJson).not.toBeNull();
    const remaining = JSON.parse(ctxJson!);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].delegateDid).toBe('did:jwk:other-delegate');
  });

  test('successful disconnect clears retry context entirely when last entry pruned', async () => {
    const storage = new MemoryStorage();

    // Only entry is for the same delegate that's disconnecting
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([
      { delegateDid  : 'did:jwk:delegate123', connectedDid : 'did:dht:owner456', revocations  : [
        { grantId: 'old-grant', revocationGrantId: 'old-rev' },
      ] },
    ]));

    await setStoredSession(storage, 'did:dht:owner456', 'did:jwk:delegate123');

    const agent = buildRevocationAgent({
      grantRecords: { 'old-grant': mockGrantRecord('old-grant') },
    });
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // Entire retry context should be removed
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
  });
});
