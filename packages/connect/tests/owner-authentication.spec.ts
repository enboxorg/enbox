import type { ConnectRequest } from '../src/types.js';
import type { BearerDid, DidDocument } from '@enbox/dids';
import type { ConnectAuthenticationReplayStore, ConnectAuthenticationResolver } from '../src/owner-authentication.js';

import { Convert } from '@enbox/common';
import { X25519 } from '@enbox/crypto';
import { describe, expect, it, spyOn } from 'bun:test';
import { DidDht, DidJwk } from '@enbox/dids';

import { randomToken } from '../src/client.js';
import {
  assertConnectAuthenticationParams,
  assertConnectAuthenticationRequest,
  assertConnectRequestAuthentication,
  CONNECT_AUTHENTICATION_MAX_REQUEST_BYTES,
  CONNECT_OWNER_AUTHENTICATION_TYP,
  ConnectAuthenticationError,
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
  it('should reject another service audience or transaction challenge before resolving or consuming', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const issued = request.authentication!;
    let resolutions = 0;
    let consumptions = 0;
    for (const expected of [
      { audience: 'https://another-service.example', challenge: issued.challenge },
      { audience: `${issued.audience}/`, challenge: issued.challenge },
      { audience: `${issued.audience}/other-issuer`, challenge: issued.challenge },
      { audience: issued.audience, challenge: randomToken() },
    ]) {
      await expect(verifyOwnerAuthenticationProof({
        proof, request, expected, providerDid : owner.uri, now         : NOW,
        resolver    : { resolve: async did => { resolutions++; return resolver.resolve(did); } },
        replayStore : { consume: async () => { consumptions++; return true; } },
      })).rejects.toMatchObject({ code: 'context-mismatch' });
    }
    expect(resolutions).toBe(0);
    expect(consumptions).toBe(0);
  });

  it('should require valid expected service and transaction bindings at runtime', async () => {
    const { owner, request } = await fixture();
    const expectedValues: unknown[] = [undefined, null, 'service', {},
      { audience: 'http://identity.example', challenge: randomToken() },
      { audience: 'https://identity.example', challenge: 'short' }];
    for (const expected of expectedValues) {
      await expect(verifyOwnerAuthenticationProof({
        proof: 'unused', request, expected: expected as { audience: string; challenge: string }, providerDid: owner.uri, now: NOW,
      })).rejects.toMatchObject({ code: 'invalid-request' });
    }
  });

  it('should preserve signer acquisition causes without exposing them in the public error message or JSON', async () => {
    const { owner, request } = await fixture();
    const cause = new Error('private key-store diagnostic');
    const spy = spyOn(owner.keyManager, 'getPublicKey').mockRejectedValue(cause);
    try {
      const caught = await prepareOwnerAuthenticationProof({ owner, request }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ConnectAuthenticationError);
      const failure = caught as ConnectAuthenticationError;
      expect(failure.code).toBe('unsupported-key');
      expect(failure.cause).toBe(cause);
      expect(failure.message).toBe('Connect authentication failed: unsupported-key.');
      expect(Object.keys(failure)).not.toContain('cause');
      expect(JSON.stringify(failure)).not.toContain(cause.message);
    } finally { spy.mockRestore(); }
  });

  it('should categorize malformed requests and non-string transaction identifiers in the public validator', async () => {
    const { request } = await fixture();
    const malformed: unknown[] = [null, undefined, 12, 'request', [],
      { ...request, clientDid: null }, { ...request, nonce: 1234567890123456789012n },
      { ...request, state: 1234567890123456789012n }];
    for (const value of malformed) {
      expect(() => assertConnectRequestAuthentication(value as ConnectRequest)).toThrow('Connect authentication failed: invalid-request.');
    }
  });

  it('should reject malformed DID method containers and entries with categorized errors', async () => {
    const { owner, request } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const malformed = [
      { verificationMethod: {} }, { verificationMethod: [null] }, { verificationMethod: [{}] }, { verificationMethod: new Array(1) },
      { verificationMethod: [{ id: 12 }] }, { authentication: [null] },
      { authentication: [{}] }, { authentication: [{ id: 12 }] }, { authentication: new Array(1) },
    ];
    for (const change of malformed) {
      await expect(verifyOwnerAuthenticationProof({ expected    : request.authentication!, proof, request, providerDid : owner.uri, now         : NOW,
        resolver    : resolverFor({ ...owner.document, ...change } as DidDocument) }))
        .rejects.toMatchObject({ name: 'ConnectAuthenticationError', code: 'unsupported-key' });
    }
    await expect(prepareOwnerAuthenticationProof({ owner, request, methodId: 12 as unknown as string }))
      .rejects.toMatchObject({ name: 'ConnectAuthenticationError', code: 'unsupported-key' });
  });

  it('should resolve only the selected authentication key and reject duplicate selected relationships', async () => {
    const { owner, request } = await fixture();
    const selected = owner.document.authentication![0] as string;
    owner.document.authentication = [selected, '#unavailable-unused-key'];
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const options = { proof, request, expected: request.authentication!, providerDid: owner.uri, now: NOW, resolver: resolverFor(owner.document) };
    expect((await verifyOwnerAuthenticationProof(options)).subject).toBe(owner.uri);
    owner.document.authentication = ['#unavailable-unused-key', selected];
    expect((await verifyOwnerAuthenticationProof(options)).subject).toBe(owner.uri);
    await expect(prepareOwnerAuthenticationProof({ owner, request })).rejects.toMatchObject({ code: 'unsupported-key' });
    await expect(prepareOwnerAuthenticationProof({ owner, request, methodId: selected })).resolves.toBeDefined();
    owner.document.authentication = [selected, selected];
    await expect(verifyOwnerAuthenticationProof(options)).rejects.toMatchObject({ code: 'unsupported-key' });
  });

  it('should categorize unavailable KMS and embedded-only signing keys while verifying embedded authentication keys', async () => {
    const { owner, request } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const method = owner.document.verificationMethod![0];
    owner.document.authentication = [method];
    owner.document.verificationMethod = [];
    expect((await verifyOwnerAuthenticationProof({ expected    : request.authentication!, proof, request, providerDid : owner.uri, now         : NOW,
      resolver    : resolverFor(owner.document) })).subject).toBe(owner.uri);
    await expect(prepareOwnerAuthenticationProof({ owner, request }))
      .rejects.toMatchObject({ name: 'ConnectAuthenticationError', code: 'unsupported-key' });
    owner.document.verificationMethod = [method];
    owner.document.authentication = [structuredClone(method)];
    method.controller = 'did:example:another-controller';
    await expect(prepareOwnerAuthenticationProof({ owner, request }))
      .rejects.toMatchObject({ name: 'ConnectAuthenticationError', code: 'unsupported-key' });
    method.controller = owner.uri;
    owner.document.authentication = [method];
    const anotherOwner = await DidJwk.create();
    method.publicKeyJwk = anotherOwner.document.verificationMethod![0].publicKeyJwk;
    await expect(prepareOwnerAuthenticationProof({ owner, request }))
      .rejects.toMatchObject({ name: 'ConnectAuthenticationError', code: 'unsupported-key' });
  });

  it('should reject live signing-key replacement or ambiguity during asynchronous preparation', async () => {
    const { owner, request } = await fixture();
    const replacementUri = await owner.keyManager.generateKey({ algorithm: 'Ed25519' });
    const replacementKey = await owner.keyManager.getPublicKey({ keyUri: replacementUri });
    const originalDocument = structuredClone(owner.document);
    for (const duringSignerAcquisition of [false, true]) {
      owner.document.verificationMethod = structuredClone(originalDocument.verificationMethod);
      const replaceKey = (): void => { owner.document.verificationMethod![0].publicKeyJwk = replacementKey; };
      const getSigner = owner.getSigner.bind(owner);
      const spy = duringSignerAcquisition ? spyOn(owner, 'getSigner').mockImplementation(async params => {
        const signer = await getSigner(params);
        replaceKey();
        return signer;
      }) : undefined;
      try {
        const pending = prepareOwnerAuthenticationProof({ owner, request });
        if (!duringSignerAcquisition) { replaceKey(); }
        await expect(pending).rejects.toMatchObject({ code: 'unsupported-key' });
      } finally { spy?.mockRestore(); }
    }
    owner.document.verificationMethod = structuredClone(originalDocument.verificationMethod);
    const pending = prepareOwnerAuthenticationProof({ owner, request });
    owner.document.verificationMethod!.push(structuredClone(owner.document.verificationMethod![0]));
    await expect(pending).rejects.toMatchObject({ code: 'unsupported-key' });
  });

  it('should allow signing-key metadata changes that preserve the algorithm and public key material', async () => {
    const { owner, request } = await fixture();
    const pending = prepareOwnerAuthenticationProof({ owner, request });
    owner.document.verificationMethod![0].publicKeyJwk!.kid = 'metadata-only-change';
    const proof = await (await pending).sign({ now: NOW });
    expect((await verifyOwnerAuthenticationProof({ expected    : request.authentication!, proof, request, providerDid : owner.uri, now         : NOW,
      resolver    : resolverFor(owner.document) })).subject).toBe(owner.uri);
  });

  it('should reject non-JSON objects before signing and preserve plain null-prototype metadata', async () => {
    const { owner, request } = await fixture();
    for (const value of [new Date(), /pattern/u, new Map([['name', 'value']]), new Set(['value']), new Array(2)]) {
      const changed = { ...request, clientMetadata: { value } } as unknown as ConnectRequest;
      await expect(connectAuthenticationRequestDigest(changed)).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(prepareOwnerAuthenticationProof({ owner, request: changed })).rejects.toMatchObject({ code: 'invalid-request' });
    }
    const metadata = Object.assign(Object.create(null), { name: 'value' });
    expect(await connectAuthenticationRequestDigest({ ...request, clientMetadata: metadata }))
      .toBe(await connectAuthenticationRequestDigest({ ...request, clientMetadata: { name: 'value' } } as ConnectRequest));
  });

  it('should keep verified and consumed bindings on the initial request across asynchronous resolution', async () => {
    const { owner, request } = await fixture();
    const original = structuredClone(request);
    const expected = { audience: original.authentication!.audience, challenge: original.authentication!.challenge };
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    let consumed: Parameters<ConnectAuthenticationReplayStore['consume']>[0] | undefined;
    const pending = verifyOwnerAuthenticationProof({ expected,
      proof, request, providerDid : owner.uri, now         : NOW,
      resolver    : { resolve: async () => {
        request.authentication!.audience = 'https://unverified.example';
        request.authentication!.challenge = randomToken();
        expected.audience = 'https://changed-during-resolution.example';
        expected.challenge = randomToken();
        return { didDocument: owner.document, didDocumentMetadata: {}, didResolutionMetadata: {} };
      } },
      replayStore: { consume: async binding => { consumed = binding; return true; } },
    });
    request.nonce = randomToken();
    request.expectedProviderDid = 'did:example:changed';
    expected.audience = 'https://changed-before-resolution.example';
    expected.challenge = randomToken();
    const verified = await pending;
    expect(verified.audience).toBe(original.authentication!.audience);
    expect(verified.challenge).toBe(original.authentication!.challenge);
    expect(verified.requestDigest).toBe(await connectAuthenticationRequestDigest(original));
    expect(consumed).toEqual({ audience      : verified.audience, challenge     : verified.challenge, subject       : owner.uri,
      requestDigest : verified.requestDigest, expiresAt     : NOW + 300 });
  });

  it('should reject a proof that expires during DID resolution before consuming the challenge', async () => {
    const { owner, request } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const clock = spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    let consumptions = 0;
    try {
      await expect(verifyOwnerAuthenticationProof({ expected    : request.authentication!,
        proof, request, providerDid : owner.uri,
        resolver    : { resolve: async () => {
          clock.mockReturnValue((NOW + 300) * 1000);
          return { didDocument: owner.document, didDocumentMetadata: {}, didResolutionMetadata: {} };
        } },
        replayStore: { consume: async () => { consumptions++; return true; } },
      })).rejects.toMatchObject({ code: 'expired-proof' });
      expect(consumptions).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it('should fail closed when an asynchronous replay store finishes after proof expiry', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const clock = spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    let consumptions = 0;
    try {
      await expect(verifyOwnerAuthenticationProof({ expected    : request.authentication!, proof, request, providerDid : owner.uri, resolver,
        replayStore : { consume: async () => {
          consumptions++;
          clock.mockReturnValue((NOW + 300) * 1000);
          return true;
        } },
      })).rejects.toMatchObject({ code: 'expired-proof' });
      expect(consumptions).toBe(1);
    } finally { clock.mockRestore(); }
  });

  it('should preserve the v1 UTF-16 canonical digest for mixed-case and Unicode keys in any insertion order', async () => {
    const publicKey = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
    // Supplementary U+10000 sorts before U+E000 by UTF-16 code units. Locale
    // collation, code-point sorting and Unicode normalization must not change
    // this existing wire digest, including distinct composed/decomposed keys.
    const entries = [
      ['\uE000', 'private-use'], ['\u{10000}', 'supplementary'], ['é', 'composed'],
      ['e\u0301', 'decomposed'], ['a', 'lower'], ['Z', 'upper-late'], ['A', 'upper-early'],
    ];
    const request: ConnectRequest = {
      clientDid           : 'did:jwk:' + Convert.object(publicKey).toBase64Url(),
      appName             : 'Canonical fixture', permissionRequests  : [], requestType         : 'authenticate',
      authentication      : { version: 1, audience: 'https://identity.example', challenge: 'ABCDEFGHIJKLMNOPQRSTUV' },
      nonce               : 'abcdefghijklmnopqrstuv', state               : 'zyxwvutsrqponmlkjihgfea', supportedDidMethods : ['did:jwk'],
      responseKey         : { kty: 'OKP', crv: 'X25519', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      reply               : { mode: 'post_message' }, clientMetadata      : Object.fromEntries(entries),
    };
    // Captured from the original v1 canonical encoding before the comparator refactor.
    const expected = '1wk99C4CLgQLCBI5q_0_t_XB7Jr04RE7_sac9CGephE';
    expect(await connectAuthenticationRequestDigest(request)).toBe(expected);
    const reordered = Object.fromEntries(Object.entries({ ...request, clientMetadata: Object.fromEntries([...entries].reverse()) }).reverse());
    expect(await connectAuthenticationRequestDigest(reordered as ConnectRequest)).toBe(expected);
  });

  it('should snapshot preflight context but start the proof lifetime only after slow approval setup', async () => {
    const { owner, request, resolver } = await fixture();
    const original = structuredClone(request);
    const prepared = await prepareOwnerAuthenticationProof({ owner, request });
    request.appName = 'Changed after preflight';
    request.authentication = { version: 1, audience: 'https://changed.example', challenge: randomToken() };
    request.reply = { mode: 'direct_post', callbackUrl: 'https://changed.example/callback' };
    const issuedAt = NOW + 600;
    const proof = await prepared.sign({ now: issuedAt });
    expect(await verifyOwnerAuthenticationProof({
      expected: original.authentication!, proof, request: original, providerDid: owner.uri, resolver, now: issuedAt,
    }))
      .toMatchObject({ issuedAt, expiresAt: issuedAt + 300, audience: 'https://identity.example' });
    await expect(verifyOwnerAuthenticationProof({
      expected: request.authentication!, proof, request, providerDid: owner.uri, resolver, now: issuedAt,
    }))
      .rejects.toMatchObject({ code: 'context-mismatch' });
  });

  it('should verify a real did:dht owner key without exporting it and cover the exact full request', async () => {
    const { owner, request, resolver } = await fixture();
    owner.export = async (): Promise<never> => { throw new Error('Owner key export is forbidden.'); };
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const verified = await verifyOwnerAuthenticationProof({
      expected: request.authentication!, proof, request, providerDid: owner.uri, resolver, now: NOW,
    });
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
      const verified = await verifyOwnerAuthenticationProof({ expected    : request.authentication!, proof, request, providerDid : owner.uri,
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
        moduleDefinition: { module: 'https://example/module', published: false, types: {}, structure: {} }, permissionScopes: [],
      }] },
      { ...request, responseKey: { ...request.responseKey, x: (await X25519.generateKey()).x } },
    ];
    for (const changed of variants) {
      await expect(verifyOwnerAuthenticationProof({
        expected: request.authentication!, proof, request: changed, providerDid: owner.uri, resolver, now: NOW,
      }))
        .rejects.toThrow();
    }
  });

  it('should reject a forged signature, substituted owner, removed authentication key, and failed DID resolution', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const attacker = await DidDht.create({ options: { publish: false } });
    const forged = await resign(proof, attacker, {});
    await expect(verifyOwnerAuthenticationProof({
      expected: request.authentication!, proof: forged, request, providerDid: owner.uri, resolver, now: NOW,
    }))
      .rejects.toMatchObject({ code: 'invalid-signature' });
    await expect(verifyOwnerAuthenticationProof({ expected: request.authentication!, proof, request, providerDid: attacker.uri, resolver, now: NOW }))
      .rejects.toMatchObject({ code: 'context-mismatch' });
    await expect(verifyOwnerAuthenticationProof({ expected    : request.authentication!, proof, request, providerDid : owner.uri,
      resolver    : resolverFor({ ...owner.document, authentication: [] }), now         : NOW }))
      .rejects.toMatchObject({ code: 'unsupported-key' });
    await expect(verifyOwnerAuthenticationProof({ expected    : request.authentication!, proof, request, providerDid : owner.uri,
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
      await expect(verifyOwnerAuthenticationProof({
        expected: request.authentication!, proof: altered, request, providerDid: owner.uri, resolver, now: NOW,
      })).rejects.toThrow();
    }
    await expect(verifyOwnerAuthenticationProof({
      expected: request.authentication!, proof, request, providerDid: owner.uri, resolver, now: NOW + 300,
    }))
      .rejects.toMatchObject({ code: 'expired-proof' });
  });

  it('should consume only a pre-issued live transaction with its registered binding and reject replay', async () => {
    const { owner, request, resolver } = await fixture();
    const proof = await createOwnerAuthenticationProof({ owner, request, now: NOW });
    const key = `${request.authentication!.audience}:${request.authentication!.challenge}`;
    const transaction = {
      subject: owner.uri, requestDigest: await connectAuthenticationRequestDigest(request), expiresAt: NOW + 300, consumed: false,
    };
    const issued = new Map([[key, transaction]]);
    let calls = 0;
    let consumptions = 0;
    const replayStore: ConnectAuthenticationReplayStore = {
      consume: async binding => {
        calls++;
        expect(Object.keys(binding).sort()).toEqual(['audience', 'challenge', 'expiresAt', 'requestDigest', 'subject']);
        const registered = issued.get(`${binding.audience}:${binding.challenge}`);
        if (registered === undefined || registered.consumed || registered.expiresAt <= NOW ||
            registered.subject !== binding.subject || registered.requestDigest !== binding.requestDigest) { return false; }
        registered.consumed = true;
        consumptions++;
        return true;
      },
    };
    const unissued = { ...request, authentication: { ...request.authentication!, challenge: randomToken() } };
    const wrongContext = { ...request, appName: 'Different transaction context' };
    for (const candidate of [unissued, wrongContext]) {
      await expect(verifyOwnerAuthenticationProof({
        proof       : await createOwnerAuthenticationProof({ owner, request: candidate, now: NOW }), request     : candidate,
        expected    : candidate.authentication!, providerDid : owner.uri, resolver, replayStore, now         : NOW,
      })).rejects.toMatchObject({ code: 'replayed-proof' });
    }
    const secondOwner = await DidDht.create({ options: { publish: false } });
    await expect(verifyOwnerAuthenticationProof({
      proof       : await createOwnerAuthenticationProof({ owner: secondOwner, request, now: NOW }), request,
      expected    : request.authentication!, providerDid : secondOwner.uri,
      resolver    : resolverFor(secondOwner.document), replayStore, now         : NOW,
    })).rejects.toMatchObject({ code: 'replayed-proof' });
    transaction.expiresAt = NOW;
    await expect(verifyOwnerAuthenticationProof({
      proof, request, expected: request.authentication!, providerDid: owner.uri, resolver, replayStore, now: NOW,
    })).rejects.toMatchObject({ code: 'replayed-proof' });
    expect(transaction.consumed).toBe(false);
    transaction.expiresAt = NOW + 300;
    await verifyOwnerAuthenticationProof({
      proof, request, expected: request.authentication!, providerDid: owner.uri, resolver, replayStore, now: NOW,
    });
    await expect(verifyOwnerAuthenticationProof({
      proof, request, expected: request.authentication!, providerDid: owner.uri, resolver, replayStore, now: NOW,
    }))
      .rejects.toMatchObject({ code: 'replayed-proof' });
    await expect(verifyOwnerAuthenticationProof({
      proof: 'forged', request, expected: request.authentication!, providerDid: owner.uri, resolver, replayStore, now: NOW,
    })).rejects.toMatchObject({ code: 'invalid-proof' });
    expect(calls).toBe(6);
    expect(consumptions).toBe(1);
    expect(issued.size).toBe(1);
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
