/**
 * e2e: delegated grant revocation on disconnect
 *
 * Tests for https://github.com/enboxorg/enbox/issues/828
 *
 * Verifies that when a delegate session is disconnected:
 * 1. All delegated grants for the session are revoked
 * 2. Revocations are sent to remote DWN endpoints
 * 3. Local session state is cleared
 * 4. Partial failure preserves retry material
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
        return {
          reply: {
            status : { code: 200 },
            entry  : { recordsWrite: record },
          },
        };
      }
    }
    return { reply: { status: { code: 404 } } };
  };

  // Mock dwn.getDwnEndpointUrlsForTarget
  (agent.dwn as any).getDwnEndpointUrlsForTarget = async (): Promise<string[]> =>
    ['https://dwn.example.com'];

  // Mock permissions.createRevocation
  (agent as any).permissions = {
    createRevocation: async (params: any): Promise<any> => {
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

    // SESSION_REVOCATIONS cleared after success
    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).toBeNull();
  });

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

    // The missing grant is preserved in storage for retry
    const remaining = JSON.parse((await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS))!);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].grantId).toBe('grant-missing');
  });

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
  });

  test('revocation failure does not prevent local cleanup', async () => {
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

    // Local state cleared despite revocation failure
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    // But SESSION_REVOCATIONS preserved for retry
    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).not.toBeNull();
  });

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
});
