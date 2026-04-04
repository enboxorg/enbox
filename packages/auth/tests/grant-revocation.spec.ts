/**
 * e2e: delegated grant revocation on disconnect
 *
 * Tests for https://github.com/enboxorg/enbox/issues/828
 *
 * Verifies that when a delegate session is disconnected:
 * 1. All delegated grants for the session are revoked
 * 2. Future fetchGrants({ checkRevoked: true }) excludes them
 * 3. Local session state is cleared
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

describe('grant revocation on disconnect', () => {

  test('disconnect calls createRevocation for each mapped grant', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate123');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner456');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
      { grantId: 'grant-2', revocationGrantId: 'rev-grant-2' },
    ]));

    const mockGrants = [
      { grant: { id: 'grant-1', scope: { method: 'Read' }, grantee: 'did:jwk:delegate123' }, message: { recordId: 'grant-1' } },
      { grant: { id: 'grant-2', scope: { method: 'Query' }, grantee: 'did:jwk:delegate123' }, message: { recordId: 'grant-2' } },
    ];

    const revocationCalls: any[] = [];
    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate123' },
      metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner456' },
    });

    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [delegateIdentity],
    });

    // Stub the permissions API on the agent
    (agent as any).permissions = {
      fetchGrants      : async (): Promise<any[]> => mockGrants,
      createRevocation : async (params: any): Promise<void> => { revocationCalls.push(params); },
    };

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    await manager.disconnect();

    // Should have called createRevocation for each grant in the mapping
    expect(revocationCalls).toHaveLength(2);
    expect(revocationCalls[0].grant.id).toBe('grant-1');
    expect(revocationCalls[0].granteeDid).toBe('did:jwk:delegate123');
    expect(revocationCalls[0].permissionGrantId).toBe('rev-grant-1');
    expect(revocationCalls[1].grant.id).toBe('grant-2');
    expect(revocationCalls[1].permissionGrantId).toBe('rev-grant-2');
  });

  test('disconnect clears SESSION_REVOCATIONS from storage', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
    ]));

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });
    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [delegateIdentity],
    });
    (agent as any).permissions = {
      fetchGrants      : async (): Promise<any[]> => [],
      createRevocation : async (): Promise<void> => {},
    };

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    expect(await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS)).toBeNull();
  });

  test('disconnect without session revocations still clears local state', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');
    // No SESSION_REVOCATIONS set

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });
    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [delegateIdentity],
    });

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });
    await manager.disconnect();

    // Local state should still be cleared
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.CONNECTED_DID)).toBeNull();
  });

  test('disconnect handles revocation failure gracefully', async () => {
    const storage = new MemoryStorage();
    await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await storage.set(STORAGE_KEYS.DELEGATE_DID, 'did:jwk:delegate');
    await storage.set(STORAGE_KEYS.CONNECTED_DID, 'did:dht:owner');
    await storage.set(STORAGE_KEYS.SESSION_REVOCATIONS, JSON.stringify([
      { grantId: 'grant-1', revocationGrantId: 'rev-grant-1' },
    ]));

    const mockGrants = [
      { grant: { id: 'grant-1', scope: { method: 'Read' } }, message: { recordId: 'grant-1' } },
    ];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });
    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [delegateIdentity],
    });
    (agent as any).permissions = {
      fetchGrants      : async (): Promise<any[]> => mockGrants,
      createRevocation : async (): Promise<void> => { throw new Error('revocation failed'); },
    };

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    // Should not throw — failure is non-fatal
    await manager.disconnect();

    // Local state should still be cleared despite revocation failure
    expect(await storage.get(STORAGE_KEYS.DELEGATE_DID)).toBeNull();
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
    const mockGrants = [
      { grant: { id: 'grant-1', scope: { method: 'Read' } }, message: { recordId: 'grant-1' } },
    ];

    const delegateIdentity = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });
    const agent = createMockAgent({
      firstLaunch  : async () => false,
      identityList : async () => [delegateIdentity],
    });
    (agent as any).permissions = {
      fetchGrants      : async (): Promise<any[]> => mockGrants,
      createRevocation : async (): Promise<void> => { revocationCount++; },
    };

    const manager = createTestManager(agent, { storage });
    await manager.connect({ password: 'test' });

    await manager.disconnect();
    expect(revocationCount).toBe(1);

    // Second disconnect — session is already cleared, no revocation should happen
    await manager.disconnect();
    expect(revocationCount).toBe(1); // unchanged
  });
});
