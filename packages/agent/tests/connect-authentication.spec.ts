import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ConnectRequest } from '@enbox/connect';

import sinon from 'sinon';

import { DidJwk } from '@enbox/dids';
import { X25519 } from '@enbox/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomToken, verifyOwnerAuthenticationProof } from '@enbox/connect';

import { executeConnectApproval } from '../src/connect-approval.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { createConnectAuthenticationProof, executeConnectAuthentication } from '../src/connect-authentication.js';

const ORIGIN = 'https://login.example';

describe('Connect owner authentication approval', () => {
  let harness: PlatformAgentTestHarness;
  let owner: BearerIdentity;
  let request: ConnectRequest;

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({
      agentClass: TestAgent, agentStores: 'memory', testDataLocation: '__TESTDATA__/connect-owner-authentication',
    });
  });

  beforeEach(async () => {
    await harness.clearStorage();
    await harness.createAgentDid({ publish: false });
    owner = await harness.agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Login identity' } });
    const client = await DidJwk.create();
    const responseKey = await X25519.generateKey();
    request = {
      clientDid           : client.uri, appName             : 'OAuth client', permissionRequests  : [],
      requestType         : 'authenticate', supportedDidMethods : ['did:jwk'],
      nonce               : randomToken(), state               : randomToken(),
      responseKey         : { kty: 'OKP', crv: 'X25519', x: responseKey.x },
      reply               : { mode: 'post_message' },
      authentication      : { version: 1, audience: `${ORIGIN}/`, challenge: randomToken() },
    };
  });

  afterEach(() => { sinon.restore(); });
  afterAll(async () => { await harness.clearStorage(); await harness.closeStorage(); });

  it('signs through the owner KMS without exporting keys, creating grants, or opening a data session', async () => {
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    const send = sinon.spy(harness.agent, 'sendDwnRequest');
    const rpc = sinon.spy(harness.agent.rpc, 'sendDwnRequest');
    const grant = sinon.spy(harness.agent.permissions, 'createGrant');
    const exported = sinon.stub(harness.agent.keyManager, 'exportKey').rejects(new Error('Unexpected private-key export'));
    const identitiesBefore = await harness.agent.identity.list();
    const result = await executeConnectAuthentication({
      agent: harness.agent, providerDid: owner.did.uri, request, verifiedRequesterOrigin: ORIGIN,
    });
    const verified = await verifyOwnerAuthenticationProof({ proof: result.authenticationProof, request, providerDid: owner.did.uri });
    expect(verified.subject).toBe(owner.did.uri);
    expect(verified.audience).toBe(`${ORIGIN}/`);
    expect(result.responseSigner.uri).not.toBe(owner.did.uri);
    expect(Object.keys(result).sort()).toEqual(['authenticationProof', 'responseSigner']);
    expect(await harness.agent.identity.list()).toEqual(identitiesBefore);
    expect(process.called).toBe(false);
    expect(send.called).toBe(false);
    expect(rpc.called).toBe(false);
    expect(grant.called).toBe(false);
    expect(exported.called).toBe(false);
  });

  it('rejects an authentication-only request on the delegation ceremony before writing anything', async () => {
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    await expect(executeConnectApproval({
      agent: harness.agent, providerDid: owner.did.uri, request, transport: 'postMessage', verifiedRequesterOrigin: ORIGIN,
    })).rejects.toThrow('executeConnectAuthentication');
    expect(process.called).toBe(false);
  });

  it('requires the verified requester origin and rejects an unrelated audience before signing', async () => {
    const signer = sinon.spy(harness.agent.keyManager, 'sign');
    for (const verifiedRequesterOrigin of ['', `${ORIGIN}/path`, 'https://other.example']) {
      await expect(executeConnectAuthentication({
        agent: harness.agent, providerDid: owner.did.uri, request, verifiedRequesterOrigin,
      })).rejects.toThrow();
    }
    expect(signer.called).toBe(false);
  });

  it('rejects a missing or delegated identity even when private signing material is present', async () => {
    const identityGet = sinon.stub(harness.agent.identity, 'get');
    identityGet.resolves(undefined);
    await expect(executeConnectAuthentication({
      agent: harness.agent, providerDid: owner.did.uri, request, verifiedRequesterOrigin: ORIGIN,
    })).rejects.toThrow('locally owned');
    owner.metadata.connectedDid = 'did:example:delegating-owner';
    identityGet.resolves(owner);
    await expect(executeConnectAuthentication({
      agent: harness.agent, providerDid: owner.did.uri, request, verifiedRequesterOrigin: ORIGIN,
    })).rejects.toThrow('locally owned');
  });

  it('rejects grant, delegate and lifetime fields on identity-only approval', async () => {
    const identityGet = sinon.spy(harness.agent.identity, 'get');
    const mutations: Partial<ConnectRequest>[] = [
      { delegateDid: owner.did.uri },
      { requestedSessionTtlSeconds: 3600 },
      { permissionRequests: [{
        protocolDefinition : { protocol: 'https://example.com/data', published: false, types: {}, structure: {} },
        permissionScopes   : [{ interface: 'Protocols', method: 'Query', protocol: 'https://example.com/data' }],
      }] },
      { requestType: 'connect' },
    ];
    for (const mutation of mutations) {
      await expect(executeConnectAuthentication({
        agent: harness.agent, providerDid: owner.did.uri, request: { ...request, ...mutation }, verifiedRequesterOrigin: ORIGIN,
      })).rejects.toThrow('authentication-only');
    }
    expect(identityGet.called).toBe(false);
  });

  it('rejects missing authentication key and never falls back to an assertion key', async () => {
    sinon.stub(harness.agent.identity, 'get').resolves(owner);
    owner.did.document.authentication = [];
    await expect(createConnectAuthenticationProof({
      agent: harness.agent, providerDid: owner.did.uri, request, verifiedRequesterOrigin: ORIGIN,
    })).rejects.toThrow('unsupported-key');
  });

  it('rejects incomplete combined authentication and missing origin before any delegation mutation', async () => {
    const process = sinon.spy(harness.agent, 'processDwnRequest');
    const mint = sinon.spy(DidJwk, 'create');
    const combined: ConnectRequest = { ...request, requestType: 'connect' };
    await expect(executeConnectApproval({
      agent: harness.agent, providerDid: owner.did.uri, request: combined, transport: 'postMessage',
    })).rejects.toThrow('verified requester origin');
    await expect(executeConnectApproval({
      agent                   : harness.agent, providerDid             : owner.did.uri,
      request                 : { ...combined, nonce: 'invalid' }, transport               : 'postMessage', verifiedRequesterOrigin : ORIGIN,
    })).rejects.toThrow('invalid-request');
    expect(process.called).toBe(false);
    expect(mint.called).toBe(false);
  });
});
