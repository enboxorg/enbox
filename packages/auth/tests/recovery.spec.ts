import type { EnboxUserAgent } from '@enbox/agent';

import type { MockAgentOverrides, MockIdentity } from './helpers/mock-agent.js';

import { describe, expect, test } from 'bun:test';

import { DidErrorCode } from '@enbox/dids';

import { MemoryStorage } from '../src/storage/storage.js';
import { AGENT_DID_SYNC_PROTOCOLS, recoverIdentitiesFromRemote, registerAgentDidForSync } from '../src/connect/recovery.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

type RecoveryOptions = Omit<Parameters<typeof recoverIdentitiesFromRemote>[0], 'userAgent' | 'storage'>;

function recover(
  agent: EnboxUserAgent,
  options: RecoveryOptions = {},
): ReturnType<typeof recoverIdentitiesFromRemote> {
  return recoverIdentitiesFromRemote({ userAgent: agent, storage: new MemoryStorage(), ...options });
}

function recoveredAgent(
  identities: MockIdentity | MockIdentity[],
  overrides: MockAgentOverrides = {},
): { agent: EnboxUserAgent; pulls: () => number } {
  const recovered = Array.isArray(identities) ? identities : [identities];
  let pullCount = 0;
  return {
    agent: createMockAgent({
      ...overrides,
      identityList : async () => (pullCount > 0 ? recovered : []),
      syncSync     : async () => { pullCount++; },
    }),
    pulls: (): number => pullCount,
  };
}

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
    const syncCalls: any[] = [];
    const { agent, pulls } = recoveredAgent(identity, {
      syncRegisterIdentity: async (params) => { syncCalls.push(params); },
    });

    const result = await recover(agent, {
      identitySyncProtocols: ['https://proto.example/profile'],
    });

    expect(result).toHaveLength(1);
    expect(result[0].did.uri).toBe('did:dht:testuser123');
    expect(pulls()).toBe(2);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:testuser123');
    expect(syncCalls[0].options.protocols).toEqual(['https://proto.example/profile']);
  });

  test('without explicit identity scope recovers identity metadata only', async () => {
    const identity = createMockIdentity();
    const syncCalls: any[] = [];
    const { agent, pulls } = recoveredAgent(identity, {
      syncRegisterIdentity: async (params) => { syncCalls.push(params); },
    });

    const result = await recover(agent);

    expect(result).toHaveLength(1);
    expect(pulls()).toBe(1);
    expect(syncCalls).toHaveLength(0);
  });

  test('returns empty array when remote has no identities', async () => {
    const { agent, pulls } = recoveredAgent([]);

    const result = await recover(agent);

    expect(result).toEqual([]);
    expect(pulls()).toBe(1);
  });

  test('aborts before updating recovered identities when DID resolution fails', async () => {
    const identity = createMockIdentity();
    const endpointUpdates: any[] = [];
    const { agent } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'resolution-failed', didUri, message: 'resolver offline', resolutionError: 'internalError',
      }),
      identitySetDwnEndpoints: async (params) => { endpointUpdates.push(params); },
    });

    await expect(recover(agent)).rejects.toThrow('resolver offline');
    expect(endpointUpdates).toHaveLength(0);
  });

  test('bootstraps a not-found owned DID with its recovered endpoints instead of manager defaults', async () => {
    const identity = createMockIdentity() as any;
    identity.did.document = {
      id      : identity.did.uri,
      service : [{
        id              : `${identity.did.uri}#dwn`,
        type            : 'DecentralizedWebNode',
        serviceEndpoint : ['https://recovered.example'],
      }],
    };
    const endpointUpdates: any[] = [];
    const { agent } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri, refresh }) => refresh
        ? {
          status: 'resolution-failed', didUri, message: 'DID not found', resolutionError: DidErrorCode.NotFound,
        }
        : { status: 'ready', didUri, endpoints: ['https://recovered.example'] },
      identitySetDwnEndpoints: async (params) => { endpointUpdates.push(params); },
    });

    await recover(agent);

    expect(endpointUpdates).toEqual([{
      didUri    : identity.did.uri,
      endpoints : ['https://recovered.example'],
    }]);
  });

  test('does not synthesize defaults when a not-found recovered DID has no valid stored endpoints', async () => {
    const identity = createMockIdentity() as any;
    identity.did.document = { id: identity.did.uri };
    const endpointUpdates: any[] = [];
    const { agent } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'resolution-failed', didUri, message: 'DID not found', resolutionError: DidErrorCode.NotFound,
      }),
      identitySetDwnEndpoints: async (params) => { endpointUpdates.push(params); },
    });

    await expect(recover(agent)).rejects.toThrow('does not advertise a #dwn service');
    expect(endpointUpdates).toHaveLength(0);
  });

  test('fails closed when a not-found routing DID is externally owned', async () => {
    const identity = createMockIdentity({
      metadata: { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:owner' },
    });
    const endpointUpdates: any[] = [];
    const { agent } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'resolution-failed', didUri, message: 'Owner DID not found', resolutionError: DidErrorCode.NotFound,
      }),
      identitySetDwnEndpoints: async (params) => { endpointUpdates.push(params); },
    });

    await expect(recover(agent, {
      replacementDwnEndpoints: ['https://explicit.example'],
    })).rejects.toThrow('Owner DID not found');
    expect(endpointUpdates).toHaveLength(0);
  });

  test('registers recovered identity DIDs as DWN tenants when registration is provided', async () => {
    const identity = createMockIdentity();
    let registrationSucceeded = false;
    const { agent } = recoveredAgent(identity, {
      rpcGetServerInfo: async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await recover(agent, {
      identitySyncProtocols : ['https://proto.example/profile'],
      registration          : {
        onSuccess : () => { registrationSucceeded = true; },
        onFailure : () => {},
      },
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
    const { agent } = recoveredAgent(identities, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'ready', didUri, endpoints: [endpoints.get(didUri)],
      }),
      rpcGetServerInfo: async (endpoint) => {
        serverInfoCalls.push(endpoint);
        return { registrationRequirements: [], maxFileSize: 10_000_000 };
      },
    });

    await recover(agent, {
      registration: { onSuccess: () => {}, onFailure: () => {} },
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
    const { agent } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'ready', didUri, endpoints: ['https://owner-dwn.example'],
      }),
      identitySetDwnEndpoints: async params => { endpointUpdates.push(params); },
    });

    await recover(agent, {
      replacementDwnEndpoints: ['https://replacement.example'],
    });

    expect(endpointUpdates).toHaveLength(0);
  });

  test('replaces a resolved owned DID only when explicitly requested', async () => {
    const identity = createMockIdentity();
    const endpointUpdates: any[] = [];
    const { agent } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'ready', didUri, endpoints: ['https://resolved.example'],
      }),
      identitySetDwnEndpoints: async params => { endpointUpdates.push(params); },
    });

    await recover(agent, {
      replacementDwnEndpoints: ['https://replacement.example'],
    });

    expect(endpointUpdates).toEqual([{
      didUri    : identity.did.uri,
      endpoints : ['https://replacement.example'],
    }]);
  });

  test('keeps registration callbacks outside the lifecycle mutation runner', async () => {
    const identity = createMockIdentity();
    let mutationDepth = 0;
    let registrationMutationDepth: number | undefined;
    const { agent } = recoveredAgent(identity, {
      rpcGetServerInfo: async () => ({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
      }),
    });

    await recover(agent, {
      registration: {
        onSuccess : () => { registrationMutationDepth = mutationDepth; },
        onFailure : () => {},
      },
      runMutation: async <T>(operation: () => Promise<T>): Promise<T> => {
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
    const syncCalls: any[] = [];
    const { agent, pulls } = recoveredAgent(identity, {
      syncRegisterIdentity : async (params) => { syncCalls.push(params); },
      rpcGetServerInfo     : async () => { throw new Error('network error'); },
    });

    const result = await recover(agent, {
      identitySyncProtocols : ['https://proto.example/profile'],
      registration          : {
        onSuccess : () => {},
        onFailure : () => {},
      },
    });

    expect(result).toHaveLength(1);
    expect(syncCalls).toHaveLength(1);
    expect(pulls()).toBe(2);
  });

  test('uses connectedDid for delegate identities', async () => {
    const delegateIdentity = createMockIdentity({
      metadata: { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });
    const syncCalls: any[] = [];
    const { agent } = recoveredAgent(delegateIdentity, {
      syncRegisterIdentity: async (params) => { syncCalls.push(params); },
    });

    await recover(agent, {
      identitySyncProtocols: ['https://proto.example/profile'],
    });

    expect(syncCalls[0].did).toBe('did:dht:external');
  });

  test('tolerates already-registered sync identity', async () => {
    const identity = createMockIdentity();
    const { agent, pulls } = recoveredAgent(identity, {
      syncRegisterIdentity: async () => { throw new Error('already registered'); },
    });

    const result = await recover(agent, {
      identitySyncProtocols: ['https://proto.example/profile'],
    });

    expect(result).toHaveLength(1);
    expect(pulls()).toBe(2);
  });

  test('throws when recovered identity sync registration fails for another reason', async () => {
    const identity = createMockIdentity();
    const { agent, pulls } = recoveredAgent(identity, {
      syncRegisterIdentity: async () => { throw new Error('sync store unavailable'); },
    });

    await expect(
      recover(agent, {
        identitySyncProtocols: ['https://proto.example/profile'],
      })
    ).rejects.toThrow('sync store unavailable');

    expect(pulls()).toBe(1);
  });
});
