import { describe, expect, test } from 'bun:test';

import { MemoryStorage } from '../src/storage/storage.js';
import { AGENT_DID_SYNC_PROTOCOLS, recoverIdentitiesFromRemote, registerAgentDidForSync } from '../src/connect/recovery.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

describe('AGENT_DID_SYNC_PROTOCOLS', () => {
  test('contains identity store and JWK store protocol URIs', () => {
    expect(AGENT_DID_SYNC_PROTOCOLS).toEqual([
      'https://identity.foundation/protocols/web5/identity-store',
      'https://identity.foundation/protocols/web5/jwk-store',
    ]);
  });
});

describe('registerAgentDidForSync', () => {
  test('registers agent DID with recovery protocols', async () => {
    const syncCalls: any[] = [];
    const agent = createMockAgent({
      syncRegisterIdentity: async (params) => { syncCalls.push(params); },
    });

    await registerAgentDidForSync(agent);

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:testagent');
    expect(syncCalls[0].options.protocols).toEqual(AGENT_DID_SYNC_PROTOCOLS);
  });

  test('silently succeeds when already registered', async () => {
    const agent = createMockAgent({
      syncRegisterIdentity: async () => { throw new Error('already registered'); },
    });

    await expect(registerAgentDidForSync(agent)).resolves.toBeUndefined();
  });
});

describe('recoverIdentitiesFromRemote', () => {
  test('returns recovered identities after explicitly scoped two-phase pull', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      identityList: async () => {
        // Phase 1 pull recovers the identity; phase 2 pull is a no-op.
        return pullCount > 0 ? [identity] : [];
      },
      syncSync             : async () => { pullCount++; },
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    const result = await recoverIdentitiesFromRemote({
      userAgent             : agent,
      dwnEndpoints          : ['https://dwn.example.com'],
      identitySyncProtocols : ['https://proto.example/profile'],
      storage               : new MemoryStorage(),
    });

    expect(result).toHaveLength(1);
    expect(result[0].did.uri).toBe('did:dht:testuser123');
    expect(pullCount).toBe(2);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:testuser123');
    expect(syncCalls[0].options.protocols).toEqual(['https://proto.example/profile']);
  });

  test('without explicit identity scope recovers identity metadata only', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      identityList: async () => {
        return pullCount > 0 ? [identity] : [];
      },
      syncSync             : async () => { pullCount++; },
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    const result = await recoverIdentitiesFromRemote({
      userAgent    : agent,
      dwnEndpoints : ['https://dwn.example.com'],
      storage      : new MemoryStorage(),
    });

    expect(result).toHaveLength(1);
    expect(pullCount).toBe(1);
    expect(syncCalls).toHaveLength(0);
  });

  test('returns empty array when remote has no identities', async () => {
    let pullCount = 0;
    const agent = createMockAgent({
      identityList : async () => [],
      syncSync     : async () => { pullCount++; },
    });

    const result = await recoverIdentitiesFromRemote({
      userAgent    : agent,
      dwnEndpoints : ['https://dwn.example.com'],
      storage      : new MemoryStorage(),
    });

    expect(result).toEqual([]);
    expect(pullCount).toBe(1);
  });

  test('registers recovered identity DIDs as DWN tenants when registration is provided', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;
    let registrationSucceeded = false;

    const agent = createMockAgent({
      identityList     : async () => (pullCount > 0 ? [identity] : []),
      syncSync         : async () => { pullCount++; },
      rpcGetServerInfo : async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await recoverIdentitiesFromRemote({
      userAgent             : agent,
      dwnEndpoints          : ['https://dwn.example.com'],
      identitySyncProtocols : ['https://proto.example/profile'],
      registration          : {
        onSuccess : () => { registrationSucceeded = true; },
        onFailure : () => {},
      },
      storage: new MemoryStorage(),
    });

    expect(registrationSucceeded).toBe(true);
  });

  test('continues recovery when DWN tenant registration fails', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      identityList         : async () => (pullCount > 0 ? [identity] : []),
      syncSync             : async () => { pullCount++; },
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
      rpcGetServerInfo     : async () => { throw new Error('network error'); },
    });

    const result = await recoverIdentitiesFromRemote({
      userAgent             : agent,
      dwnEndpoints          : ['https://dwn.example.com'],
      identitySyncProtocols : ['https://proto.example/profile'],
      registration          : {
        onSuccess : () => {},
        onFailure : () => {},
      },
      storage: new MemoryStorage(),
    });

    expect(result).toHaveLength(1);
    expect(syncCalls).toHaveLength(1);
    expect(pullCount).toBe(2);
  });

  test('uses connectedDid for delegate identities', async () => {
    const delegateIdentity = createMockIdentity({
      metadata: { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });
    let pullCount = 0;
    const syncCalls: any[] = [];

    const agent = createMockAgent({
      identityList         : async () => (pullCount > 0 ? [delegateIdentity] : []),
      syncSync             : async () => { pullCount++; },
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
    });

    await recoverIdentitiesFromRemote({
      userAgent             : agent,
      dwnEndpoints          : ['https://dwn.example.com'],
      identitySyncProtocols : ['https://proto.example/profile'],
      storage               : new MemoryStorage(),
    });

    expect(syncCalls[0].did).toBe('did:dht:external');
  });

  test('tolerates already-registered sync identity', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;

    const agent = createMockAgent({
      identityList         : async () => (pullCount > 0 ? [identity] : []),
      syncSync             : async () => { pullCount++; },
      syncRegisterIdentity : async () => { throw new Error('already registered'); },
    });

    const result = await recoverIdentitiesFromRemote({
      userAgent             : agent,
      dwnEndpoints          : ['https://dwn.example.com'],
      identitySyncProtocols : ['https://proto.example/profile'],
      storage               : new MemoryStorage(),
    });

    expect(result).toHaveLength(1);
    expect(pullCount).toBe(2);
  });
});
