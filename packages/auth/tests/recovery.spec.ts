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

  test('repairs stale options when already registered', async () => {
    const updateCalls: any[] = [];
    const agent = createMockAgent({
      syncRegisterIdentity      : async () => { throw new Error('already registered'); },
      syncUpdateIdentityOptions : async (params) => { updateCalls.push(params); },
    });

    await expect(registerAgentDidForSync(agent)).resolves.toBeUndefined();
    expect(updateCalls).toEqual([{
      did     : 'did:dht:testagent',
      options : { protocols: AGENT_DID_SYNC_PROTOCOLS },
    }]);
  });

  test('throws when sync registration fails for another reason', async () => {
    const agent = createMockAgent({
      syncRegisterIdentity: async () => { throw new Error('storage unavailable'); },
    });

    await expect(registerAgentDidForSync(agent)).rejects.toThrow('storage unavailable');
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

  test('aborts before updating recovered identities when DID resolution fails', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;
    const endpointUpdates: any[] = [];
    const agent = createMockAgent({
      identityList                 : async () => (pullCount > 0 ? [identity] : []),
      identityGetDwnEndpointStatus : async ({ didUri }) => ({
        status: 'resolution-failed', didUri, message: 'resolver offline', resolutionError: 'internalError',
      }),
      identitySetDwnEndpoints : async (params) => { endpointUpdates.push(params); },
      syncSync                : async () => { pullCount++; },
    });

    await expect(recoverIdentitiesFromRemote({
      userAgent    : agent,
      dwnEndpoints : ['https://default.example'],
      storage      : new MemoryStorage(),
    })).rejects.toThrow('resolver offline');
    expect(endpointUpdates).toHaveLength(0);
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

  test('registers each recovered DID at its own resolved endpoint', async () => {
    const identities = [
      createMockIdentity({ did: { uri: 'did:dht:alice' }, metadata: { name: 'Alice', tenant: 'did:dht:testagent' } }),
      createMockIdentity({ did: { uri: 'did:dht:bob' }, metadata: { name: 'Bob', tenant: 'did:dht:testagent' } }),
    ];
    const endpoints = new Map([
      ['did:dht:alice', 'https://alice-dwn.example'],
      ['did:dht:bob', 'https://bob-dwn.example'],
    ]);
    const serverInfoCalls: string[] = [];
    let pullCount = 0;
    const agent = createMockAgent({
      identityList                 : async () => (pullCount > 0 ? identities : []),
      identityGetDwnEndpointStatus : async ({ didUri }) => ({
        status: 'ready', didUri, endpoints: [endpoints.get(didUri)],
      }),
      syncSync         : async () => { pullCount++; },
      rpcGetServerInfo : async (endpoint) => {
        serverInfoCalls.push(endpoint);
        return { registrationRequirements: [], maxFileSize: 10_000_000 };
      },
    });

    await recoverIdentitiesFromRemote({
      userAgent    : agent,
      dwnEndpoints : ['https://default.example'],
      registration : { onSuccess: () => {}, onFailure: () => {} },
      storage      : new MemoryStorage(),
    });

    expect(serverInfoCalls).toEqual([
      'https://alice-dwn.example',
      'https://bob-dwn.example',
    ]);
  });

  test('does not replace an externally owned connected DID', async () => {
    const identity = createMockIdentity({
      metadata: { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });
    const endpointUpdates: any[] = [];
    let pullCount = 0;
    const agent = createMockAgent({
      identityList                 : async () => (pullCount > 0 ? [identity] : []),
      identityGetDwnEndpointStatus : async ({ didUri }) => ({
        status: 'ready', didUri, endpoints: ['https://owner-dwn.example'],
      }),
      identitySetDwnEndpoints : async params => { endpointUpdates.push(params); },
      syncSync                : async () => { pullCount++; },
    });

    await recoverIdentitiesFromRemote({
      userAgent           : agent,
      dwnEndpoints        : ['https://replacement.example'],
      replaceDwnEndpoints : true,
      storage             : new MemoryStorage(),
    });

    expect(endpointUpdates).toHaveLength(0);
  });

  test('keeps registration callbacks outside the lifecycle mutation runner', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;
    let mutationDepth = 0;
    let registrationMutationDepth: number | undefined;

    const agent = createMockAgent({
      identityList     : async () => (pullCount > 0 ? [identity] : []),
      syncSync         : async () => { pullCount++; },
      rpcGetServerInfo : async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await recoverIdentitiesFromRemote({
      userAgent    : agent,
      dwnEndpoints : ['https://dwn.example.com'],
      registration : {
        onSuccess : () => { registrationMutationDepth = mutationDepth; },
        onFailure : () => {},
      },
      storage     : new MemoryStorage(),
      runMutation : async <T>(operation: () => Promise<T>): Promise<T> => {
        mutationDepth++;
        try {
          return await operation();
        } finally {
          mutationDepth--;
        }
      },
    });

    expect(registrationMutationDepth).toBe(0);
    expect(mutationDepth).toBe(0);
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

  test('throws when recovered identity sync registration fails for another reason', async () => {
    const identity = createMockIdentity();
    let pullCount = 0;

    const agent = createMockAgent({
      identityList         : async () => (pullCount > 0 ? [identity] : []),
      syncSync             : async () => { pullCount++; },
      syncRegisterIdentity : async () => { throw new Error('sync store unavailable'); },
    });

    await expect(
      recoverIdentitiesFromRemote({
        userAgent             : agent,
        dwnEndpoints          : ['https://dwn.example.com'],
        identitySyncProtocols : ['https://proto.example/profile'],
        storage               : new MemoryStorage(),
      })
    ).rejects.toThrow('sync store unavailable');

    expect(pullCount).toBe(1);
  });
});
