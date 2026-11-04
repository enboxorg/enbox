import type { BearerDid } from '@enbox/dids';
import type { ConnectApproval, ConnectRequest, ConnectTransport } from '../src/types.js';

import { DidJwk } from '@enbox/dids';
import { CryptoUtils, X25519 } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';

import { ConnectProvider } from '../src/provider.js';
import { createOwnerAuthenticationProof } from '../src/owner-authentication.js';
import { ConnectClient, randomToken } from '../src/client.js';

type WalletAction = (request: ConnectRequest, signer: BearerDid, pin?: string) => Promise<string>;

async function loopback(mode: 'relay' | 'popup', action: WalletAction,
  onAuthenticationRequest?: (request: Readonly<ConnectRequest>) => Promise<void> | void): Promise<{
  client: ConnectClient; observed: { completions: number; requests: ConnectRequest[] };
}> {
  const requestKey = CryptoUtils.randomBytes(32);
  const walletEpk = await X25519.generateKey();
  const signer = await DidJwk.create();
  const pin = mode === 'relay' ? '1234' : undefined;
  const observed = { completions: 0, requests: [] as ConnectRequest[] };
  let pending: Promise<string> | undefined;
  const transport: ConnectTransport = {
    requiresPin    : mode === 'relay',
    requestProfile : async state => ({
      state,
      encryption: mode === 'relay' ? { mode: 'dir', requestKey }
        : { mode: 'ecdh-es', walletEpk: { kty: 'OKP', crv: 'X25519', x: walletEpk.x }, walletOrigin: 'https://wallet.example' },
      reply: mode === 'relay' ? { mode: 'direct_post', callbackUrl: 'https://identity.example/callback' } : { mode: 'post_message' },
    }),
    deliverRequest: async (jwe): Promise<void> => {
      const request = await ConnectProvider.openRequest({ jwe, decryption: mode === 'relay'
        ? { mode: 'dir', requestKey } : { mode: 'ecdh-es', recipientPrivateKey: walletEpk, walletOrigin: 'https://wallet.example' } });
      observed.requests.push(request);
      pending = action(request, signer, pin);
      // Keep rejected responses observed until the client reaches awaitResponse.
      void pending.catch((): undefined => undefined);
    },
    awaitResponse   : (): Promise<string> => pending ?? Promise.reject(new Error('No pending request.')),
    confirmComplete : async (): Promise<void> => { observed.completions++; },
  };
  return { client: new ConnectClient({ transport, onAuthenticationRequest, requestPin: async (): Promise<string> => pin ?? '' }), observed };
}

describe('ConnectClient owner authentication', () => {
  it('should register an isolated public request before delivery and never deliver after failed durable registration', async () => {
    const owner = await DidJwk.create();
    let registered = false;
    const { client, observed } = await loopback('relay', async (request, signer, pin): Promise<string> => {
      expect(registered).toBe(true);
      expect(request.appName).toBe('Identity service');
      expect(request.authentication?.audience).toBe('https://identity.example');
      return ConnectProvider.sealAuthenticationResponse({ request, providerDid : owner.uri, signer, pin,
        approval    : { authenticationProof: await createOwnerAuthenticationProof({ request, owner }) } });
    }, async request => {
      expect(Object.hasOwn(request.responseKey, 'd')).toBe(false);
      expect(JSON.stringify(request)).not.toContain('privateKeys');
      await Promise.resolve();
      registered = true;
      (request as ConnectRequest).appName = 'Changed callback clone';
      request.authentication!.audience = 'https://changed.example';
    });
    const params = { appName        : 'Identity service', authentication : { version   : 1 as const,
      audience  : 'https://identity.example', challenge : randomToken() } };
    expect((await client.authenticate(params))?.authentication.subject).toBe(owner.uri);
    expect(observed.requests).toHaveLength(1);
    const blocked = await loopback('relay', async (): Promise<never> => { throw new Error('Must not reach wallet'); },
      async (): Promise<never> => { throw new Error('Registration failed'); });
    await expect(blocked.client.authenticate(params)).rejects.toThrow('Registration failed');
    expect(blocked.observed.requests).toHaveLength(0);
    expect(blocked.observed.completions).toBe(0);
  });

  it('should complete real authentication-only proofs over encrypted relay and popup channels without delegate fields', async () => {
    for (const mode of ['relay', 'popup'] as const) {
      const owner = await DidJwk.create();
      const { client, observed } = await loopback(mode, async (request, signer, pin): Promise<string> => {
        expect(request.requestType).toBe('authenticate');
        expect(request.permissionRequests).toEqual([]);
        expect(request.delegateDid).toBeUndefined();
        expect(request.requestedSessionTtlSeconds).toBeUndefined();
        const authenticationProof = await createOwnerAuthenticationProof({ request, owner });
        return ConnectProvider.sealAuthenticationResponse({ request, providerDid : owner.uri,
          approval    : { authenticationProof }, signer, pin });
      });
      const result = await client.authenticate({ appName             : 'Identity service', expectedProviderDid : owner.uri,
        authentication      : { version: 1, audience: 'https://identity.example', challenge: randomToken() } });
      expect(result?.connectedDid).toBe(owner.uri);
      expect(result?.authentication.subject).toBe(owner.uri);
      expect(Object.keys(result ?? {}).sort()).toEqual(['authentication', 'connectedDid']);
      expect(observed.completions).toBe(1);
      expect(observed.requests).toHaveLength(1);
    }
  });

  it('should preserve delegated connect results while returning an explicitly requested verified owner proof', async () => {
    const owner = await DidJwk.create();
    const delegate = await DidJwk.create();
    const portable = await delegate.export();
    const { client } = await loopback('relay', async (request, signer, pin): Promise<string> => {
      const approval: ConnectApproval = {
        delegateDid         : delegate.uri, delegateGrants      : [], sessionRevocations  : [],
        authenticationProof : await createOwnerAuthenticationProof({ owner, request }),
      };
      return ConnectProvider.sealApprovedResponse({ request, providerDid: owner.uri, approval, signer, pin });
    });
    const result = await client.connect({ appName             : 'Data app', permissionRequests  : [], delegatePortableDid : portable,
      authentication      : { version: 1, audience: 'https://identity.example', challenge: randomToken() } });
    expect(result?.delegatePortableDid).toBe(portable);
    expect(result?.authentication?.subject).toBe(owner.uri);
    expect(result?.connectedDid).toBe(owner.uri);
  });

  it('should fail closed when an older wallet drops requested authentication or returns delegation for login-only', async () => {
    for (const authenticationOnly of [false, true]) {
      const owner = await DidJwk.create();
      const delegate = await DidJwk.create();
      const portable = await delegate.export();
      const { client, observed } = await loopback('relay', (request, signer, pin): Promise<string> =>
        ConnectProvider.sealApprovedResponse({ request     : { ...request, authentication: undefined, requestType: 'connect' },
          providerDid : owner.uri, signer, pin, approval    : {
            delegateDid: delegate.uri, delegatePortableDid: portable, delegateGrants: [], sessionRevocations: [],
          } }));
      const params = { appName        : 'Identity service', authentication : { version   : 1 as const,
        audience  : 'https://identity.example', challenge : randomToken() } };
      await expect(authenticationOnly ? client.authenticate(params) : client.connect({ ...params, permissionRequests: [] }))
        .rejects.toThrow();
      expect(observed.completions).toBe(0);
    }
  });

  it('should reject an ephemeral signer posing as the selected owner even inside a valid encrypted response', async () => {
    const owner = await DidJwk.create();
    const { client, observed } = await loopback('relay', async (request, signer, pin): Promise<string> => {
      const proof = await createOwnerAuthenticationProof({ request: { ...request, expectedProviderDid: undefined }, owner: signer });
      return ConnectProvider.sealAuthenticationResponse({ request, providerDid : owner.uri,
        approval    : { authenticationProof: proof }, signer, pin });
    });
    await expect(client.authenticate({ appName             : 'Identity service', expectedProviderDid : owner.uri,
      authentication      : { version: 1, audience: 'https://identity.example', challenge: randomToken() } }))
      .rejects.toThrow();
    expect(observed.completions).toBe(0);
  });

  it('should return no identity on denial and reject delegation-only parameters on authenticate', async () => {
    const { client, observed } = await loopback('relay', async (): Promise<string> => 'DENIED');
    const params = { appName        : 'Identity service', authentication : { version   : 1 as const,
      audience  : 'https://identity.example', challenge : randomToken() } };
    expect(await client.authenticate(params)).toBeUndefined();
    await expect(client.authenticate({ ...params, permissionRequests: [] } as Parameters<ConnectClient['authenticate']>[0]))
      .rejects.toMatchObject({ code: 'invalid-request' });
    await expect(client.connect({ ...params, requestType: 'authenticate', permissionRequests: [] })).rejects.toThrow('use authenticate()');
    expect(observed.requests).toHaveLength(1);
    expect(observed.completions).toBe(0);
  });
});
