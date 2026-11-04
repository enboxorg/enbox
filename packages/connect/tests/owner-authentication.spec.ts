import type { ConnectRequest } from '../src/types.js';
import type { BearerDid, DidDocument } from '@enbox/dids';
import type { ConnectAuthenticationReplayStore, ConnectAuthenticationResolver } from '../src/owner-authentication.js';

import { Convert } from '@enbox/common';
import { X25519 } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';
import { DidDht, DidJwk } from '@enbox/dids';

import { randomToken } from '../src/client.js';
import {
  assertConnectAuthenticationParams,
  assertConnectAuthenticationRequest,
  CONNECT_AUTHENTICATION_MAX_REQUEST_BYTES,
  CONNECT_OWNER_AUTHENTICATION_TYP,
  connectAuthenticationRequestDigest,
  createOwnerAuthenticationProof,
  prepareOwnerAuthenticationProof,
  verifyOwnerAuthenticationProof,
} from '../src/owner-authentication.js';

const NOW = 1_800_000_000;

async function fixture(): Promise<{ owner: BearerDid; request: ConnectRequest; resolver: ConnectAuthenticationResolver }> {
  const owner = await DidDht.create({ options: { publish: false } });
  const client = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();
  const request: ConnectRequest = {
    clientDid           : client.uri, appName             : 'Test identity provider', permissionRequests  : [], requestType         : 'authenticate',
    authentication      : { version: 1, audience: 'https://identity.example', challenge: randomToken() },
    nonce               : randomToken(), state               : randomToken(), supportedDidMethods : ['did:dht', 'did:jwk'],
    responseKey         : { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x },
    reply               : { mode: 'direct_post', callbackUrl: 'https://identity.example/transactions/callback' },
  };
  return { owner, request, resolver: resolverFor(owner.document) };
}

function resolverFor(document: DidDocument): ConnectAuthenticationResolver {
  return { resolve: async (): Promise<Awaited<ReturnType<ConnectAuthenticationResolver['resolve']>>> => ({
    didDocument: document, didDocumentMetadata: {}, didResolutionMetadata: {},
  }) };
}

async function resign(proof: string, owner: BearerDid, change: {
  header?: Record<string, unknown>; payload?: Record<string, unknown>;
}): Promise<string> {
  const [originalHeader, originalPayload] = proof.split('.');
  const header = { ...Convert.base64Url(originalHeader).toObject(), ...change.header };
  const payload = { ...Convert.base64Url(originalPayload).toObject(), ...change.payload };
  const encodedHeader = Convert.object(header).toBase64Url();
  const encodedPayload = Convert.object(payload).toBase64Url();
  const signer = await owner.getSigner();
  const signature = await signer.sign({ data: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`) });
  return `${encodedHeader}.${encodedPayload}.${Convert.uint8Array(signature).toBase64Url()}`;
}

describe('owner authentication proofs', () => {
  it('should snapshot preflight context but start the proof lifetime only after slow approval setup', async () => {
    const { owner, request, resolver } = await fixture();
    const original = structuredClone(request);
    const prepared = await prepareOwnerAuthenticationProof({ owner, request });
    request.appName = 'Changed after preflight';
    request.authentication = { version: 1, audience: 'https://changed.example', challenge: randomToken() };
    request.reply = { mode: 'direct_post', callbackUrl: 'https://changed.example/callback' };
    const issuedAt = NOW + 600;
    const proof = await prepared.sign({ now: issuedAt });
    expect(await verifyOwnerAuthenticationProof({ proof, request: original, providerDid: owner.uri, resolver, now: issuedAt }))
      .toMatchObject({ issuedAt, expiresAt: issuedAt + 300, audience: 'https://identity.example' });
    await expect(verifyOwnerAuthenticationProof({ proof, request, providerDid: owner.uri, resolver, now: issuedAt }))
      .rejects.toMatchObject({ code: 'context-mismatch' });
  });

  it('should verify a real did:dht owner key without exporting it and cover the exact full request', async () => {
    const { owner, request, resolver } = await fixture();
    owner.export = async (): Promise<never> => { throw new Error('Owner key export is forbidden.'); };
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const verified = await verifyOwnerAuthenticationProof({ proof, request, providerDid: owner.uri, resolver, now: NOW });
    expect(verified).toMatchObject({ proof, subject   : owner.uri, audience  : 'https://identity.example',
      challenge : request.authentication?.challenge, issuedAt  : NOW, expiresAt : NOW + 300 });
    expect(verified.requestDigest).toBe(await connectAuthenticationRequestDigest(request));
    expect(verified.methodId.startsWith(`${owner.uri}#`)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    const decoded = Convert.base64Url(proof.split('.')[0]).toObject();
    expect(decoded).toMatchObject({ typ: CONNECT_OWNER_AUTHENTICATION_TYP, alg: 'EdDSA' });
    expect(JSON.stringify(verified)).not.toContain('privateKeys');
    expect(await connectAuthenticationRequestDigest({ ...request, appIcon: undefined })).toBe(verified.requestDigest);
  });

  it('should select an authentication key instead of the default assertion key and support explicit algorithm allowlists', async () => {
    for (const algorithm of ['Ed25519', 'secp256k1', 'secp256r1'] as const) {
      const { request } = await fixture();
      const owner = await DidDht.create({ options: { publish             : false, verificationMethods : [
        { algorithm: 'Ed25519', id: 'claims', purposes: ['assertionMethod'] },
        { algorithm, id: 'login', purposes: ['authentication'] },
      ] } });
      owner.document.authentication = [`${owner.uri}#login`];
      owner.document.assertionMethod = [`${owner.uri}#claims`];
      const proof = await createOwnerAuthenticationProof({ request, owner, now: NOW });
      const verified = await verifyOwnerAuthenticationProof({ proof, request, providerDid : owner.uri,
        resolver    : resolverFor(owner.document), now         : NOW });
      expect(verified.methodId).toBe(`${owner.uri}#login`);
      await expect(createOwnerAuthenticationProof({ request, owner, methodId: `${owner.uri}#claims`, now: NOW }))
        .rejects.toMatchObject({ code: 'unsupported-key' });
    }
  });

  it('should reject changes to the relying-party transaction, channel, permissions, and delegate context', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const variants: ConnectRequest[] = [
      { ...request, appName: 'Another application' },
      { ...request, clientMetadata: { origin: 'https://another.example' } },
      { ...request, nonce: randomToken() }, { ...request, state: randomToken() },
      { ...request, reply: { mode: 'direct_post', callbackUrl: 'https://another.example/callback' } },
      { ...request, authentication: { version: 1, audience: 'https://another.example', challenge: request.authentication!.challenge } },
      { ...request, authentication: { version: 1, audience: 'https://identity.example', challenge: randomToken() } },
      { ...request, requestType: 'connect', delegateDid: (await DidJwk.create()).uri },
      { ...request, requestType        : 'connect', permissionRequests : [{
        protocolDefinition: { protocol: 'https://example/protocol', published: false, types: {}, structure: {} }, permissionScopes: [],
      }] },
      { ...request, responseKey: { ...request.responseKey, x: (await X25519.generateKey()).x } },
    ];
    for (const changed of variants) {
      await expect(verifyOwnerAuthenticationProof({ proof, request: changed, providerDid: owner.uri, resolver, now: NOW }))
        .rejects.toThrow();
    }
  });

  it('should reject a forged signature, substituted owner, removed authentication key, and failed DID resolution', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const attacker = await DidDht.create({ options: { publish: false } });
    const forged = await resign(proof, attacker, {});
    await expect(verifyOwnerAuthenticationProof({ proof: forged, request, providerDid: owner.uri, resolver, now: NOW }))
      .rejects.toMatchObject({ code: 'invalid-signature' });
    await expect(verifyOwnerAuthenticationProof({ proof, request, providerDid: attacker.uri, resolver, now: NOW }))
      .rejects.toMatchObject({ code: 'context-mismatch' });
    await expect(verifyOwnerAuthenticationProof({ proof, request, providerDid : owner.uri,
      resolver    : resolverFor({ ...owner.document, authentication: [] }), now         : NOW }))
      .rejects.toMatchObject({ code: 'unsupported-key' });
    await expect(verifyOwnerAuthenticationProof({ proof, request, providerDid : owner.uri,
      resolver    : { resolve: async (): Promise<never> => { throw new Error('Unavailable'); } }, now         : NOW }))
      .rejects.toMatchObject({ code: 'did-resolution' });
  });

  it('should reject expired/future/overlong proofs, other purposes, injected keys and unsafe headers', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const changes = [
      { payload: { exp: NOW } }, { payload: { iat: NOW + 31, exp: NOW + 300 } },
      { payload: { exp: NOW + 301 } }, { payload: { purpose: 'permission-grant' } },
      { header: { typ: 'JWT' } }, { header: { alg: 'none' } },
      { header: { jwk: owner.document.verificationMethod?.[0].publicKeyJwk } },
      { header: { kid: `${(await DidJwk.create()).uri}#0` } },
    ];
    for (const change of changes) {
      const altered = await resign(proof, owner, change);
      await expect(verifyOwnerAuthenticationProof({ proof: altered, request, providerDid: owner.uri, resolver, now: NOW })).rejects.toThrow();
    }
    await expect(verifyOwnerAuthenticationProof({ proof, request, providerDid: owner.uri, resolver, now: NOW + 300 }))
      .rejects.toMatchObject({ code: 'expired-proof' });
  });

  it('should consume a service-owned challenge only after valid proof verification and reject replay', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const consumed = new Set<string>();
    let calls = 0;
    const replayStore: ConnectAuthenticationReplayStore = {
      consume: async binding => {
        calls++;
        expect(Object.keys(binding).sort()).toEqual(['audience', 'challenge', 'expiresAt', 'requestDigest', 'subject']);
        const key = `${binding.audience}:${binding.challenge}`;
        if (consumed.has(key)) { return false; }
        consumed.add(key); return true;
      },
    };
    await verifyOwnerAuthenticationProof({ proof, request, providerDid: owner.uri, resolver, replayStore, now: NOW });
    await expect(verifyOwnerAuthenticationProof({ proof, request, providerDid: owner.uri, resolver, replayStore, now: NOW }))
      .rejects.toMatchObject({ code: 'replayed-proof' });
    await expect(verifyOwnerAuthenticationProof({ proof: 'forged', request, providerDid: owner.uri, resolver, replayStore, now: NOW }))
      .rejects.toThrow();
    expect(calls).toBe(2);
    expect(consumed.size).toBe(1);
    const secondOwner = await DidDht.create({ options: { publish: false } });
    const anotherProof = await createOwnerAuthenticationProof({ owner: secondOwner, request, now: NOW });
    await expect(verifyOwnerAuthenticationProof({ proof       : anotherProof, request, providerDid : secondOwner.uri,
      resolver    : resolverFor(secondOwner.document), replayStore, now         : NOW }))
      .rejects.toMatchObject({ code: 'replayed-proof' });
    expect(consumed.size).toBe(1);
  });

  it('should reject authentication-only delegation, unsupported versions and oversized requests before signing', async () => {
    const { owner, request } = await fixture();
    const ephemeral = await DidJwk.create();
    await expect(createOwnerAuthenticationProof({ owner: ephemeral, request: { ...request, clientDid: ephemeral.uri }, now: NOW }))
      .rejects.toMatchObject({ code: 'context-mismatch' });
    expect(() => assertConnectAuthenticationRequest({ ...request, delegateDid: owner.uri })).toThrow();
    expect(() => assertConnectAuthenticationRequest({ ...request, requestedSessionTtlSeconds: 3600 })).toThrow();
    expect(() => assertConnectAuthenticationParams({ ...request.authentication, version: 2 })).toThrow();
    for (const audience of ['http://identity.example', 'https://user:secret@identity.example',
      'https://identity.example/?query=1', 'https://identity.example/#fragment']) {
      expect(() => assertConnectAuthenticationParams({ version: 1, audience, challenge: randomToken() })).toThrow();
    }
    for (const audience of ['https://identity.example', 'https://identity.example/', 'https://identity.example/issuer']) {
      expect(() => assertConnectAuthenticationParams({ version: 1, audience, challenge: randomToken() })).not.toThrow();
    }
    await expect(createOwnerAuthenticationProof({ owner, request : { ...request,
      appIcon: 'x'.repeat(CONNECT_AUTHENTICATION_MAX_REQUEST_BYTES) }, now     : NOW })).rejects.toMatchObject({ code: 'invalid-request' });
  });
});
