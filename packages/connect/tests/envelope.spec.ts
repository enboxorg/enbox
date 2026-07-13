import type { BearerDid } from '@enbox/dids';
import type { Jwk } from '@enbox/crypto';
import type { ConnectRequest, ConnectResponse } from '../src/types.js';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { signJwt } from '../src/jwt.js';
import {
  assertConnectRequest,
  assertX25519PublicJwk,
  CONNECT_REQUEST_JWE_TYP,
  CONNECT_RESPONSE_JWE_TYP,
  openRequest,
  openResponse,
  sealRequest,
  sealResponse,
} from '../src/envelope.js';
import { CompactJwe, CryptoUtils, X25519 } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';

const WALLET_ORIGIN = 'https://wallet.example';

/** Builds a valid connect request along with its client DID and response key pair. */
async function createTestRequest(overrides: Partial<ConnectRequest> = {}): Promise<{
  clientDid: BearerDid;
  request: ConnectRequest;
  responsePrivateKey: Jwk;
}> {
  const clientDid = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();

  const request: ConnectRequest = {
    clientDid           : clientDid.uri,
    appName             : 'Test App',
    permissionRequests  : [],
    supportedDidMethods : ['did:dht', 'did:jwk'],
    nonce               : Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url(),
    state               : Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url(),
    responseKey         : { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x },
    reply               : { mode: 'direct_post', callbackUrl: 'https://relay.example/connect/callback' },
    ...overrides,
  };

  return { clientDid, request, responsePrivateKey };
}

/** Builds a valid connect response echoing the given request. */
function buildTestResponse(request: ConnectRequest, overrides: Partial<ConnectResponse> = {}): ConnectResponse {
  const iat = Math.floor(Date.now() / 1000);

  return {
    providerDid        : 'did:example:provider',
    delegateDid        : 'did:example:delegate',
    aud                : request.clientDid,
    iat,
    exp                : iat + 600,
    nonce              : request.nonce,
    state              : request.state,
    delegateGrants     : [],
    sessionRevocations : [],
    ...overrides,
  };
}

/** Flips one character in the ciphertext part of a Compact JWE. */
function tamperCiphertext(jwe: string): string {
  const parts = jwe.split('.');
  const ciphertext = parts[3];
  const flipped = ciphertext[0] === 'A' ? 'B' : 'A';
  parts[3] = flipped + ciphertext.slice(1);
  return parts.join('.');
}

describe('connect envelope', () => {
  describe('assertX25519PublicJwk', () => {
    it('should accept a public X25519 JWK', () => {
      expect(() => assertX25519PublicJwk({ kty: 'OKP', crv: 'X25519', x: 'abc' })).not.toThrow();
    });

    it('should reject non-objects, non-X25519 keys, and private key material', () => {
      expect(() => assertX25519PublicJwk('not-a-jwk')).toThrow('X25519 public JWK');
      expect(() => assertX25519PublicJwk({ kty: 'OKP', crv: 'Ed25519', x: 'abc' })).toThrow('X25519 public JWK');
      expect(() => assertX25519PublicJwk({ kty: 'EC', crv: 'X25519', x: 'abc' })).toThrow('X25519 public JWK');
      expect(() => assertX25519PublicJwk({ kty: 'OKP', crv: 'X25519', x: 'abc', d: 'secret' })).toThrow('X25519 public JWK');
    });
  });

  describe('sealRequest / openRequest — relay (dir) profile', () => {
    it('should round-trip a request through the dir profile', async () => {
      const { clientDid, request } = await createTestRequest();
      const requestKey = CryptoUtils.randomBytes(32);

      const jwe = await sealRequest({ request, signer: clientDid, encryption: { mode: 'dir', requestKey } });

      const header = Convert.base64Url(jwe.split('.')[0]).toObject() as Record<string, unknown>;
      expect(header.alg).toBe('dir');
      expect(header.enc).toBe('XC20P');
      expect(header.typ).toBe(CONNECT_REQUEST_JWE_TYP);
      expect(header.cty).toBe('JWT');

      const opened = await openRequest({ jwe, decryption: { mode: 'dir', requestKey } });
      expect(opened).toEqual(request);
      expect(opened.requestType).toBeUndefined();
    });

    it('should round-trip a refresh request through the dir profile', async () => {
      const { clientDid, request } = await createTestRequest({
        delegateDid : 'did:example:existing-delegate',
        requestType : 'refresh',
      });
      const requestKey = CryptoUtils.randomBytes(32);

      const jwe = await sealRequest({ request, signer: clientDid, encryption: { mode: 'dir', requestKey } });
      const opened = await openRequest({ jwe, decryption: { mode: 'dir', requestKey } });

      expect(opened.requestType).toBe('refresh');
      expect(opened.delegateDid).toBe('did:example:existing-delegate');
    });

    it('should reject an unsupported request type', async () => {
      const { request } = await createTestRequest();

      expect(() => assertConnectRequest({ ...request, requestType: 'replace' }))
        .toThrow('`requestType` must be "connect" or "refresh"');
    });

    it('should reject a refresh request without an existing delegate', async () => {
      const { request } = await createTestRequest();

      expect(() => assertConnectRequest({ ...request, requestType: 'refresh' }))
        .toThrow('`delegateDid` is required');
    });

    it('should reject sealing when the signer does not match clientDid', async () => {
      const { request } = await createTestRequest();
      const otherDid = await DidJwk.create();

      await expect(sealRequest({
        request,
        signer     : otherDid,
        encryption : { mode: 'dir', requestKey: CryptoUtils.randomBytes(32) },
      })).rejects.toThrow('must be signed by the `clientDid`');
    });

    it('should reject a tampered ciphertext', async () => {
      const { clientDid, request } = await createTestRequest();
      const requestKey = CryptoUtils.randomBytes(32);
      const jwe = await sealRequest({ request, signer: clientDid, encryption: { mode: 'dir', requestKey } });

      await expect(openRequest({ jwe: tamperCiphertext(jwe), decryption: { mode: 'dir', requestKey } }))
        .rejects.toThrow();
    });

    it('should reject the wrong request key', async () => {
      const { clientDid, request } = await createTestRequest();
      const jwe = await sealRequest({
        request,
        signer     : clientDid,
        encryption : { mode: 'dir', requestKey: CryptoUtils.randomBytes(32) },
      });

      await expect(openRequest({ jwe, decryption: { mode: 'dir', requestKey: CryptoUtils.randomBytes(32) } }))
        .rejects.toThrow();
    });

    it('should reject a request key of invalid length', async () => {
      const { clientDid, request } = await createTestRequest();

      await expect(sealRequest({
        request,
        signer     : clientDid,
        encryption : { mode: 'dir', requestKey: CryptoUtils.randomBytes(16) },
      })).rejects.toThrow('must be 32 bytes');
    });

    it('should reject a JWE whose typ is not enbox-connect-req', async () => {
      const { clientDid, request } = await createTestRequest();
      const requestKey = CryptoUtils.randomBytes(32);
      const jwt = await signJwt({ did: clientDid, data: request });

      const jwe = await CompactJwe.encrypt({
        plaintext       : Convert.string(jwt).toUint8Array(),
        protectedHeader : { alg: 'dir', cty: 'JWT', enc: 'XC20P', typ: 'JWT' },
        key             : { kty: 'oct', k: Convert.uint8Array(requestKey).toBase64Url() },
      });

      await expect(openRequest({ jwe, decryption: { mode: 'dir', requestKey } }))
        .rejects.toThrow('unexpected JWE "typ"');
    });

    it('should reject a popup-profile JWE opened with the relay allow-list', async () => {
      const { clientDid, request } = await createTestRequest();
      const walletEphemeral = await X25519.generateKey();

      const jwe = await sealRequest({
        request,
        signer     : clientDid,
        encryption : {
          mode         : 'ecdh-es',
          walletEpk    : { kty: 'OKP', crv: 'X25519', x: walletEphemeral.x },
          walletOrigin : WALLET_ORIGIN,
        },
      });

      await expect(openRequest({ jwe, decryption: { mode: 'dir', requestKey: CryptoUtils.randomBytes(32) } }))
        .rejects.toThrow('not allowed');
    });

    it('should reject when the embedded JWT signer differs from clientDid', async () => {
      const { request } = await createTestRequest();
      const otherDid = await DidJwk.create();
      const requestKey = CryptoUtils.randomBytes(32);

      // Sign the request payload with a DID other than `clientDid` and seal it manually.
      const jwt = await signJwt({ did: otherDid, data: request });
      const jwe = await CompactJwe.encrypt({
        plaintext       : Convert.string(jwt).toUint8Array(),
        protectedHeader : { alg: 'dir', cty: 'JWT', enc: 'XC20P', typ: CONNECT_REQUEST_JWE_TYP },
        key             : { kty: 'oct', k: Convert.uint8Array(requestKey).toBase64Url() },
      });

      await expect(openRequest({ jwe, decryption: { mode: 'dir', requestKey } }))
        .rejects.toThrow('signer does not match');
    });

    it('should reject a payload that fails the connect request shape assertion', async () => {
      const clientDid = await DidJwk.create();
      const requestKey = CryptoUtils.randomBytes(32);

      // Missing every required field except `clientDid`.
      const jwt = await signJwt({ did: clientDid, data: { clientDid: clientDid.uri } });
      const jwe = await CompactJwe.encrypt({
        plaintext       : Convert.string(jwt).toUint8Array(),
        protectedHeader : { alg: 'dir', cty: 'JWT', enc: 'XC20P', typ: CONNECT_REQUEST_JWE_TYP },
        key             : { kty: 'oct', k: Convert.uint8Array(requestKey).toBase64Url() },
      });

      await expect(openRequest({ jwe, decryption: { mode: 'dir', requestKey } }))
        .rejects.toThrow('invalid connect request');
    });
  });

  describe('sealRequest / openRequest — popup (ecdh-es) profile', () => {
    it('should round-trip a request through the popup profile with apv origin binding', async () => {
      const { clientDid, request } = await createTestRequest({ reply: { mode: 'post_message' } });
      const walletEphemeral = await X25519.generateKey();
      const walletEpk: Jwk = { kty: 'OKP', crv: 'X25519', x: walletEphemeral.x };

      const jwe = await sealRequest({
        request,
        signer     : clientDid,
        encryption : { mode: 'ecdh-es', walletEpk, walletOrigin: WALLET_ORIGIN },
      });

      const header = Convert.base64Url(jwe.split('.')[0]).toObject() as Record<string, unknown>;
      expect(header.alg).toBe('ECDH-ES');
      expect(header.enc).toBe('XC20P');
      expect(header.typ).toBe(CONNECT_REQUEST_JWE_TYP);
      expect(header.apv).toBe(Convert.string(WALLET_ORIGIN).toBase64Url());
      expect(header.epk).toBeDefined();

      const opened = await openRequest({
        jwe,
        decryption: { mode: 'ecdh-es', recipientPrivateKey: walletEphemeral, walletOrigin: WALLET_ORIGIN },
      });
      expect(opened).toEqual(request);
    });

    it('should reject when the apv header does not match the wallet origin', async () => {
      const { clientDid, request } = await createTestRequest({ reply: { mode: 'post_message' } });
      const walletEphemeral = await X25519.generateKey();

      const jwe = await sealRequest({
        request,
        signer     : clientDid,
        encryption : {
          mode         : 'ecdh-es',
          walletEpk    : { kty: 'OKP', crv: 'X25519', x: walletEphemeral.x },
          walletOrigin : WALLET_ORIGIN,
        },
      });

      await expect(openRequest({
        jwe,
        decryption: { mode: 'ecdh-es', recipientPrivateKey: walletEphemeral, walletOrigin: 'https://evil.example' },
      })).rejects.toThrow();
    });

    it('should reject decryption with the wrong wallet key', async () => {
      const { clientDid, request } = await createTestRequest({ reply: { mode: 'post_message' } });
      const walletEphemeral = await X25519.generateKey();
      const otherKey = await X25519.generateKey();

      const jwe = await sealRequest({
        request,
        signer     : clientDid,
        encryption : {
          mode         : 'ecdh-es',
          walletEpk    : { kty: 'OKP', crv: 'X25519', x: walletEphemeral.x },
          walletOrigin : WALLET_ORIGIN,
        },
      });

      await expect(openRequest({
        jwe,
        decryption: { mode: 'ecdh-es', recipientPrivateKey: otherKey, walletOrigin: WALLET_ORIGIN },
      })).rejects.toThrow();
    });
  });

  describe('sealResponse / openResponse', () => {
    it('should round-trip a response without a PIN', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const response = buildTestResponse(request);

      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey });

      const header = Convert.base64Url(jwe.split('.')[0]).toObject() as Record<string, unknown>;
      expect(header.alg).toBe('ECDH-ES');
      expect(header.enc).toBe('XC20P');
      expect(header.typ).toBe(CONNECT_RESPONSE_JWE_TYP);
      expect(header.cty).toBe('JWT');
      expect(header.apu).toBe(Convert.string(request.state).toBase64Url());

      const opened = await openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      });
      expect(opened).toEqual(response);
    });

    it('should round-trip a response with a PIN', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const response = buildTestResponse(request);

      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey, pin: '4291' });

      const opened = await openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
        pin                 : '4291',
      });
      expect(opened).toEqual(response);
    });

    it('should fail closed on a wrong PIN', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();

      const jwe = await sealResponse({
        response    : buildTestResponse(request),
        signer      : walletSigner,
        responseKey : request.responseKey,
        pin         : '4291',
      });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
        pin                 : '0000',
      })).rejects.toThrow();
    });

    it('should fail closed when the PIN is omitted on open', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();

      const jwe = await sealResponse({
        response    : buildTestResponse(request),
        signer      : walletSigner,
        responseKey : request.responseKey,
        pin         : '4291',
      });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow();
    });

    it('should reject an aud mismatch', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const response = buildTestResponse(request, { aud: 'did:jwk:someone-else' });

      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('does not match the client DID');
    });

    it('should reject a nonce mismatch', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const response = buildTestResponse(request, { nonce: 'stale-nonce' });

      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('does not echo the request nonce');
    });

    it('should reject when the expected state differs from the apu binding', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();

      const jwe = await sealResponse({
        response    : buildTestResponse(request),
        signer      : walletSigner,
        responseKey : request.responseKey,
      });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: 'a-different-state' },
      })).rejects.toThrow('"apu"');
    });

    it('should reject a payload state mismatch behind a matching apu header', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const response = buildTestResponse(request, { state: 'tampered-state' });

      // Seal manually so the apu header carries the *expected* state while the
      // payload carries a different one.
      const jwt = await signJwt({ did: walletSigner, data: response });
      const jwe = await CompactJwe.encrypt({
        plaintext       : Convert.string(jwt).toUint8Array(),
        protectedHeader : {
          alg : 'ECDH-ES',
          apu : Convert.string(request.state).toBase64Url(),
          cty : 'JWT',
          enc : 'XC20P',
          typ : CONNECT_RESPONSE_JWE_TYP,
        },
        key: { mode: 'ecdh-es', peerPublicKey: request.responseKey },
      });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('does not echo the request state');
    });

    it('should reject an expired response', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const response = buildTestResponse(request, { iat: nowSeconds - 700, exp: nowSeconds - 100 });

      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('expired');
    });

    it('should reject a response issued in the future', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const response = buildTestResponse(request, { iat: nowSeconds + 3600, exp: nowSeconds + 4200 });

      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('is in the future');
    });

    it('should reject a response whose exp is not later than iat', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const response = buildTestResponse(request, { iat: nowSeconds, exp: nowSeconds });

      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('must be later than');
    });

    it('should reject a JWE whose typ is not enbox-connect-res', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();

      const jwt = await signJwt({ did: walletSigner, data: buildTestResponse(request) });
      const jwe = await CompactJwe.encrypt({
        plaintext       : Convert.string(jwt).toUint8Array(),
        protectedHeader : {
          alg : 'ECDH-ES',
          apu : Convert.string(request.state).toBase64Url(),
          cty : 'JWT',
          enc : 'XC20P',
          typ : CONNECT_REQUEST_JWE_TYP,
        },
        key: { mode: 'ecdh-es', peerPublicKey: request.responseKey },
      });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('unexpected JWE "typ"');
    });

    it('should reject a tampered response ciphertext', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();

      const jwe = await sealResponse({
        response    : buildTestResponse(request),
        signer      : walletSigner,
        responseKey : request.responseKey,
      });

      await expect(openResponse({
        jwe                 : tamperCiphertext(jwe),
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow();
    });

    it('should reject a payload that fails the connect response shape assertion', async () => {
      const { clientDid, request, responsePrivateKey } = await createTestRequest();
      const walletSigner = await DidJwk.create();

      // `sessionRevocations` entries must be grant/revocation ID pairs.
      const response = buildTestResponse(request, {
        sessionRevocations: [{ grantId: 'g1' } as unknown as ConnectResponse['sessionRevocations'][number]],
      });
      const jwe = await sealResponse({ response, signer: walletSigner, responseKey: request.responseKey });

      await expect(openResponse({
        jwe,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce: request.nonce, state: request.state },
      })).rejects.toThrow('invalid connect response');
    });
  });
});
