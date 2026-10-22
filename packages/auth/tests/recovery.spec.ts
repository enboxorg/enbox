import type { EnboxUserAgent } from '@enbox/agent';

import type { MockAgentOverrides, MockIdentity } from './helpers/mock-agent.js';

import { describe, expect, test } from 'bun:test';

import { DidErrorCode } from '@enbox/dids';

import { AGENT_DID_SYNC_PROTOCOLS, recoverIdentitiesFromRemote, registerAgentDidForSync } from '../src/connect/recovery.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

type RecoveryOptions = Omit<
  Parameters<typeof recoverIdentitiesFromRemote>[0],
  'userAgent' | 'operationSignal' | 'assertActive' | 'runMutation'
>;

function recover(
  agent: EnboxUserAgent,
  options: RecoveryOptions = {},
  runMutation: Parameters<typeof recoverIdentitiesFromRemote>[0]['runMutation'] = operation => operation(),
): ReturnType<typeof recoverIdentitiesFromRemote> {
  const operationSignal = new AbortController().signal;
  return recoverIdentitiesFromRemote({
    userAgent    : agent,
    operationSignal,
    assertActive : (): void => operationSignal.throwIfAborted(),
    runMutation,
    ...options,
  });
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
  test('sets the agent DID recovery protocols', async () => {
    const syncCalls: any[] = [];
    const agent = createMockAgent({
      syncSetIdentityOptions: async (params) => { syncCalls.push(params); },
    });

    await registerAgentDidForSync(agent);

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].did).toBe('did:dht:testagent');
    expect(syncCalls[0].options.protocols).toEqual(AGENT_DID_SYNC_PROTOCOLS);
  });

  test('throws when setting sync options fails', async () => {
    const agent = createMockAgent({
      syncSetIdentityOptions: async () => { throw new Error('storage unavailable'); },
    });

    await expect(registerAgentDidForSync(agent)).rejects.toThrow('storage unavailable');
  });
});

describe('recoverIdentitiesFromRemote', () => {
  test('returns recovered identities after explicitly scoped two-phase pull', async () => {
    const identity = createMockIdentity();
    const syncCalls: any[] = [];
    const { agent, pulls } = recoveredAgent(identity, {
      syncSetIdentityOptions: async (params) => { syncCalls.push(params); },
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
    const delegate = createMockIdentity({
      did      : { uri: 'did:jwk:delegate' },
      metadata : { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });
    let grantQueries = 0;
    const syncCalls: any[] = [];
    const { agent, pulls } = recoveredAgent([identity, delegate], {
      syncSetIdentityOptions : async (params) => { syncCalls.push(params); },
      permissionsFetchGrants : async () => { grantQueries++; return []; },
    });

    const result = await recover(agent);

    expect(result).toHaveLength(2);
    expect(pulls()).toBe(1);
    expect(syncCalls).toHaveLength(0);
    expect(grantQueries).toBe(0);
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

  for (const notFound of [false, true]) {
    test(`prepares explicit bootstrap targets before publication when the recovered DID ${notFound ? 'is not found' : 'has no service'}`, async () => {
      const identity = createMockIdentity() as any;
      identity.did.document = { id: identity.did.uri };
      const calls: string[] = [];
      const { agent } = recoveredAgent(identity, {
        identityGetDwnEndpointStatus: async ({ didUri }) => notFound
          ? { status: 'resolution-failed', didUri, message: 'DID not found', resolutionError: DidErrorCode.NotFound }
          : { status: 'service-missing', didUri, message: 'DID has no #dwn service' },
        identitySetDwnEndpoints : async (): Promise<void> => { calls.push('publish'); },
        rpcGetServerInfo        : async () => { calls.push('prepare'); throw new Error('new endpoint unavailable'); },
      });
      await expect(recover(agent, {
        replacementDwnEndpoints: ['https://new.example'], registration: {},
      })).rejects.toThrow('Unable to register every requested DWN tenant');
      expect(calls).toEqual(['prepare']);
    });
  }

  test('publishes explicit bootstrap targets after successful tenant preparation', async () => {
    const calls: string[] = [];
    let published = false;
    const { agent } = recoveredAgent(createMockIdentity(), {
      identityGetDwnEndpointStatus: async ({ didUri }) => published
        ? { status: 'ready', didUri, endpoints: ['https://new.example'] }
        : { status: 'service-missing', didUri, message: 'No #dwn service' },
      identitySetDwnEndpoints : async (): Promise<void> => { calls.push('publish'); published = true; },
      rpcGetServerInfo        : async () => { calls.push('prepare'); return { registrationRequirements: [], maxFileSize: 10_000_000 }; },
    });
    await recover(agent, { replacementDwnEndpoints: ['https://new.example'], registration: {} });
    expect(calls).toEqual(['prepare', 'publish']);
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

  test('preserves existing remote tenancy without registration on recovered endpoints', async () => {
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
      registration: {},
    });

    expect(serverInfoCalls).toEqual([]);
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

  test('recovers matching explicit endpoints without preparing tenancy or changing routing', async () => {
    const identity = createMockIdentity();
    let registrationRequests = 0;
    let endpointUpdates = 0;
    const { agent, pulls } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'ready', didUri, endpoints: ['https://existing.example'],
      }),
      identitySetDwnEndpoints : async () => { endpointUpdates++; },
      rpcGetServerInfo        : async () => {
        registrationRequests++;
        throw new Error('Existing tenancy must not require new authorization');
      },
    });

    const recovered = await recover(agent, {
      replacementDwnEndpoints : ['https://existing.example'],
      identitySyncProtocols   : ['https://proto.example/profile'],
      registration            : {},
    });

    expect(recovered.map(({ did }) => did.uri)).toEqual([identity.did.uri]);
    expect(pulls()).toBe(2);
    expect(registrationRequests).toBe(0);
    expect(endpointUpdates).toBe(0);
  });

  test('replaces a resolved owned DID only when explicitly requested', async () => {
    const identity = createMockIdentity();
    const endpointUpdates: any[] = [];
    let pullsAtUpdate: number | undefined;
    let getPullCount = (): number => 0;
    const { agent, pulls } = recoveredAgent(identity, {
      identityGetDwnEndpointStatus: async ({ didUri }) => ({
        status: 'ready', didUri, endpoints: ['https://resolved.example'],
      }),
      identitySetDwnEndpoints: async params => {
        endpointUpdates.push(params);
        pullsAtUpdate = getPullCount();
      },
    });
    getPullCount = pulls;

    await recover(agent, {
      replacementDwnEndpoints : ['https://replacement.example'],
      identitySyncProtocols   : ['https://proto.example/profile'],
    });

    expect(endpointUpdates).toEqual([{
      didUri    : identity.did.uri,
      endpoints : ['https://replacement.example'],
    }]);
    expect(pullsAtUpdate).toBe(2);
  });

  test('keeps credential persistence callbacks outside the lifecycle mutation runner', async () => {
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
      replacementDwnEndpoints : ['https://replacement.example'],
      registration            : {
        onRegistrationTokens: () => { registrationMutationDepth = mutationDepth; },
      },
    }, async <T>(operation: () => Promise<T>): Promise<T> => {
      mutationDepth++;
      try {
        return await operation();
      } finally {
        mutationDepth--;
      }
    });

    expect(registrationMutationDepth).toBe(0);
    expect(mutationDepth).toBe(0);
  });

  test('restores scoped sync without re-registering the recovered tenant', async () => {
    const identity = createMockIdentity();
    const syncCalls: any[] = [];
    const { agent, pulls } = recoveredAgent(identity, {
      syncSetIdentityOptions : async (params) => { syncCalls.push(params); },
      rpcGetServerInfo       : async () => { throw new Error('network error'); },
    });

    const result = await recover(agent, {
      identitySyncProtocols : ['https://proto.example/profile'],
      registration          : {
      },
    });

    expect(result).toHaveLength(1);
    expect(syncCalls).toHaveLength(1);
    expect(pulls()).toBe(2);
  });

  test('prepares one usable signer per recovered owner before pulling protocol data', async () => {
    const ownerIdentity = createMockIdentity({ did: { uri: 'did:dht:local' } });
    const localDelegate = createMockIdentity({
      did      : { uri: 'did:jwk:local-delegate' },
      metadata : { name: 'Local delegate', tenant: 'did:dht:testagent', connectedDid: ownerIdentity.did.uri },
    });
    const delegateIdentity = createMockIdentity({
      metadata: { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });
    const emptyDelegate = createMockIdentity({
      did      : { uri: 'did:jwk:empty-delegate' },
      metadata : { name: 'Old delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });
    const identities = [localDelegate, ownerIdentity, delegateIdentity, emptyDelegate];
    let pulls = 0;
    const registrations = new Map<string, unknown>();
    const removed: string[] = [];
    const grantQueries: any[] = [];
    const expectedRegistrations = [
      { did: ownerIdentity.did.uri, options: { protocols: ['https://proto.example/profile'] } },
      { did: 'did:dht:external', options: { delegateDid: delegateIdentity.did.uri, protocols: ['https://proto.example/granted'] } },
    ];
    const agent = createMockAgent({
      identityList           : async () => pulls > 0 ? identities : [],
      syncSetIdentityOptions : async ({ did, options }) => { registrations.set(did, options); },
      syncRemoveIdentity     : async (did) => { removed.push(did); registrations.delete(did); },
      permissionsFetchGrants : async (params) => {
        grantQueries.push(params);
        if (params.grantee !== delegateIdentity.did.uri) {
          return [];
        }
        return [{ grant: {
          dateExpires : '2040-01-01T00:00:00.000000Z',
          scope       : { interface: 'Messages', method: 'Read', protocol: 'https://proto.example/granted' },
        } }];
      },
      syncSync: async () => {
        pulls++;
        if (pulls === 2) {
          expect(Array.from(registrations, ([did, options]) => ({ did, options }))).toEqual(expectedRegistrations);
        }
      },
    });

    const recovered = await recover(agent, {
      identitySyncProtocols: ['https://proto.example/profile'],
    });

    expect(pulls).toBe(2);
    expect(recovered.map(identity => identity.did.uri)).toEqual(identities.map(identity => identity.did.uri));
    expect(removed).toEqual([]);
    expect(grantQueries).toEqual([{
      author: delegateIdentity.did.uri, target: delegateIdentity.did.uri, grantee: delegateIdentity.did.uri, checkRevoked: true,
    }]);
  });

  test('skips the protocol-data pull when a recovered delegate has no active local grants', async () => {
    const delegate = createMockIdentity({
      metadata: { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:external' },
    });
    const syncCalls: any[] = [];
    const removed: string[] = [];
    const { agent, pulls } = recoveredAgent(delegate, {
      permissionsFetchGrants : async () => [],
      syncRemoveIdentity     : async (did) => { removed.push(did); },
      syncSetIdentityOptions : async (params) => { syncCalls.push(params); },
    });

    const result = await recover(agent, { identitySyncProtocols: ['https://proto.example/profile'] });

    expect(result.map(identity => identity.did.uri)).toEqual([delegate.did.uri]);
    expect(pulls()).toBe(1);
    expect(syncCalls).toEqual([]);
    expect(removed).toEqual(['did:dht:external']);
  });

  test('throws when setting recovered identity sync options fails', async () => {
    const identity = createMockIdentity();
    const { agent, pulls } = recoveredAgent(identity, {
      syncSetIdentityOptions: async () => { throw new Error('sync store unavailable'); },
    });

    await expect(
      recover(agent, {
        identitySyncProtocols: ['https://proto.example/profile'],
      })
    ).rejects.toThrow('sync store unavailable');

    expect(pulls()).toBe(1);
  });
});
