/**
 * e2e: delegated grant revocation on disconnect
 *
 * Tests for https://github.com/enboxorg/enbox/issues/828
 *
 * Verifies that when a delegate session is disconnected:
 * 1. All delegated grants for the session are revoked
 * 2. Revocations are sent to remote DWN endpoints
 * 3. Session markers are ALWAYS cleared unconditionally
 * 4. Partial failure persists a self-contained REVOCATION_RETRY_CONTEXT
 * 5. Retry maintenance runs independently from session restore
 * 6. A new connect does NOT erase old retry context
 */

import { describe, expect, test } from 'bun:test';

import { AuthEventEmitter } from '../src/events.js';
import { AuthManager } from '../src/auth-manager.js';
import { MemoryStorage } from '../src/storage/storage.js';
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

  // Mock dwn endpoint resolution (both local+remote and remote-only)
  (agent.dwn as any).getDwnEndpointUrlsForTarget = async (): Promise<string[]> =>
    ['https://dwn.example.com'];
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

  // 1. Partial disconnect clears ALL session markers and persists retry context
  test('partial disconnect clears session markers and persists retry context', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
    ]));

    const agent = buildRevocationAgent({
      grantRecords : { 'grant-1': mockGrantRecord('grant-1') },
      rpcError     : true,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // ALL session markers are cleared unconditionally
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).toBeNull();

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
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate123');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner456');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
      { grantId: 'grant-2', revocationGrantId: 'rev-grant-2' },
    ]));

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

    // All session markers cleared
    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();

    // No retry context needed — all succeeded
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
  });

  // 3. Partial failure preserves unrevoked grants in retry context
  test('partial failure preserves unrevoked grants for retry', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate123');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner456');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
      { grantId: 'grant-missing', revocationGrantId: 'rev-grant-missing' },
    ]));

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

    // All session markers cleared unconditionally
    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBeNull();

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

  // 4. Disconnect without session revocations clears all session markers
  test('disconnect without session revocations still clears local state', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');

    const agent = buildRevocationAgent({});
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
  });

  // 5. Revocation failure clears session markers, persists retry context
  test('revocation failure clears session markers but persists retry context', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
    ]));

    const agent = buildRevocationAgent({
      grantRecords    : { 'grant-1': mockGrantRecord('grant-1') },
      revocationError : true,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // All session markers cleared unconditionally.
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();

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
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
    ]));

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

  // 7. Retry-only restore returns undefined and stops sync
  test('retry-only restore runs maintenance and returns undefined', async () => {
    const storage = new MemoryStorage();
    // Simulate state left by a partial disconnect:
    // - PREVIOUSLY_CONNECTED is NOT set (user disconnected)
    // - REVOCATION_RETRY_CONTEXT is set (self-contained blob)
    // - No session markers remain
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:delegate',
      connectedDid : 'did:dht:owner',
      revocations  : [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
    }]));

    let syncStopped = false;
    const agent = buildRevocationAgent({
      grantRecords : { 'grant-1': mockGrantRecord('grant-1') },
      rpcError     : true, // remote send fails — retry won't fully succeed
    });
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
    expect((manager as any)._session).toBeUndefined();

    // Retry context still present (RPC failed so retry didn't succeed)
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).not.toBeNull();
  });

  // 8. Retry maintenance and session restore coexist
  test('retry maintenance and session restore coexist', async () => {
    const storage = new MemoryStorage();
    // Both retry context AND session restore markers exist
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:old-delegate',
      connectedDid : 'did:dht:old-owner',
      revocations  : [{ grantId: 'grant-old', revocationGrantId: 'rev-grant-old' }],
    }]));
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, 'did:dht:testuser123');

    let syncStartCount = 0;
    let syncStopCount = 0;

    const agent = buildRevocationAgent({
      grantRecords: { 'grant-old': mockGrantRecord('grant-old') },
    });
    (agent.sync as any).startSync = async (): Promise<void> => { syncStartCount++; };
    (agent.sync as any).stopSync = async (): Promise<void> => { syncStopCount++; };

    const manager = createTestManager(agent, { storage });
    const session = await manager.restoreSession();

    // Session was restored (PREVIOUSLY_CONNECTED was set)
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
      delegateDid  : 'did:jwk:delegate',
      connectedDid : 'did:dht:owner',
      revocations  : [{ grantId: 'grant-1', revocationGrantId: 'rev-grant-1' }],
    }]));
    // No PREVIOUSLY_CONNECTED — retry only

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
      delegateDid  : 'did:jwk:delegate',
      connectedDid : 'did:dht:owner',
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
    expect(entries[0].delegateDid).toBe('did:jwk:delegate');
    expect(entries[0].connectedDid).toBe('did:dht:owner');
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

  test('overlapping partial disconnects preserve both retry entries', async () => {
    const storage = new MemoryStorage();

    // Pre-existing retry context from old session A
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify([{
      delegateDid  : 'did:jwk:old-delegate-A',
      connectedDid : 'did:dht:owner-A',
      revocations  : [{ grantId: 'grant-A1', revocationGrantId: 'rev-A1' }],
    }]));

    // Now disconnect session B with failures
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate-B');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner-B');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-B1', revocationGrantId: 'rev-B1' },
    ]));

    const agent = buildRevocationAgent({
      grantRecords : { 'grant-B1': mockGrantRecord('grant-B1') },
      rpcError     : true,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // Both entries should be in the collection
    const entries = JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!);
    expect(entries).toHaveLength(2);
    expect(entries.find((e: any) => e.delegateDid === 'did:jwk:old-delegate-A')).toBeDefined();
    expect(entries.find((e: any) => e.delegateDid === 'did:jwk:delegate123')).toBeDefined();
  });

  test('clearStorage disconnect does not repersist retry context after wipe', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
    ]));

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
    expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).toBeNull();
  });

  test('legacy single-object retry context is migrated to array on load', async () => {
    const storage = new MemoryStorage();
    // Simulate a legacy single-object format
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify({
      delegateDid  : 'did:jwk:legacy-delegate',
      connectedDid : 'did:dht:legacy-owner',
      revocations  : [{ grantId: 'g1', revocationGrantId: 'rg1' }],
    }));

    // Now a new disconnect with failures should MERGE, not overwrite
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:new-delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:new-owner');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'g2', revocationGrantId: 'rg2' },
    ]));

    const agent = buildRevocationAgent({
      grantRecords : { 'g2': mockGrantRecord('g2') },
      rpcError     : true,
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // Both entries should be preserved: legacy (migrated) + new
    const entries = JSON.parse((await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT))!);
    expect(entries).toHaveLength(2);
    expect(entries.find((e: any) => e.delegateDid === 'did:jwk:legacy-delegate')).toBeDefined();
    // The new entry uses the session's delegateDid (from mock identity), not storage
    expect(entries.find((e: any) => e.delegateDid === 'did:jwk:delegate123')).toBeDefined();
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
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate123');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner456');
    // No SESSION_REVOCATIONS — nothing to revoke, so disconnect succeeds fully

    const agent = buildRevocationAgent({});
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

    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate123');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner456');

    const agent = buildRevocationAgent({});
    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // Entire retry context should be removed
    expect(await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT)).toBeNull();
  });
});
