import type { ConnectRequest } from '../src/types.js';

import sinon from 'sinon';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { afterEach, describe, expect, it } from 'bun:test';
import { CryptoUtils, X25519 } from '@enbox/crypto';

import { CONNECT_DENIED_TOKEN } from '../src/types.js';
import { ConnectProvider } from '../src/provider.js';
import { createOwnerAuthenticationProof } from '../src/owner-authentication.js';
import { parseWalletConnectUri } from '../src/uri.js';
import { randomToken } from '../src/client.js';
import {
  APP_MANIFEST_WELL_KNOWN_PATH,
  buildRedirectReturnUri,
  completeRedirectAuthentication,
  completeRedirectConnect,
  fetchConnectAppManifest,
  generateRedirectResponseSecret,
  isRedirectUriVerifiedInManifest,
  parseRedirectReturnUri,
  prepareRedirectConnectRequest,
} from '../src/redirect.js';
import { assertConnectRequest, assertValidRedirectUri, openResponse, sealResponse } from '../src/envelope.js';

const CONNECT_SERVER_URL = 'https://relay.example/connect';
const WALLET_URI = 'https://wallet.example/connect/app';
const REDIRECT_URI = 'https://app.example/connect/callback';
const REQUEST_URI = 'https://relay.example/connect/authorize/req-1.jwt';

async function createBaseRedirectRequest(overrides: Partial<ConnectRequest> = {}): Promise<ConnectRequest> {
  const clientDid = await DidJwk.create();
  const responseKey = await X25519.generateKey();
  return {
    clientDid           : clientDid.uri,
    appName             : 'Redirect App',
    permissionRequests  : [],
    supportedDidMethods : ['did:dht', 'did:jwk'],
    nonce               : randomToken(),
    state               : randomToken(),
    responseKey         : { kty: 'OKP', crv: 'X25519', x: responseKey.x },
    reply               : {
      mode        : 'redirect',
      callbackUrl : `${CONNECT_SERVER_URL}/callback`,
      redirectUri : REDIRECT_URI,
    },
    ...overrides,
  };
}

describe('Connect same-device hybrid redirect', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('assertValidRedirectUri and request validation', () => {
    it('accepts HTTPS and localhost HTTP redirect URIs with no query or fragment', () => {
      expect(() => assertValidRedirectUri('https://app.example/callback')).not.toThrow();
      expect(() => assertValidRedirectUri('https://app.example')).not.toThrow();
      expect(() => assertValidRedirectUri('http://localhost:5173/callback')).not.toThrow();
      expect(() => assertValidRedirectUri('http://127.0.0.1:8080/auth')).not.toThrow();
      expect(() => assertValidRedirectUri('http://[::1]:3000/auth')).not.toThrow();
    });

    it('rejects insecure schemes, query strings, fragments, credentials, whitespace, and oversized URIs', () => {
      for (const invalid of [
        '',
        'not a url',
        'http://app.example/callback',
        'javascript:alert(1)',
        'https://user:pass@app.example/callback',
        'https://app.example/callback?next=https://evil.example',
        'https://app.example/callback?',
        'https://app.example/callback#existing',
        'https://app.example/callback#',
        'https://app.example/call back',
        `https://app.example/${'a'.repeat(2_040)}`,
      ]) {
        expect(() => assertValidRedirectUri(invalid)).toThrow('reply.redirectUri');
      }
    });

    it('rejects brand-new pre-supplied delegateDid on redirect requests while permitting refresh', async () => {
      const delegate = await DidJwk.create();

      const invalidNew = await createBaseRedirectRequest({ delegateDid: delegate.uri });
      expect(() => assertConnectRequest(invalidNew as unknown as Record<string, unknown>))
        .toThrow('cannot be pre-supplied on a new "redirect" request');

      const invalidConnectType = await createBaseRedirectRequest({
        requestType : 'connect',
        delegateDid : delegate.uri,
      });
      expect(() => assertConnectRequest(invalidConnectType as unknown as Record<string, unknown>))
        .toThrow('cannot be pre-supplied on a new "redirect" request');

      const validRefresh = await createBaseRedirectRequest({
        requestType : 'refresh',
        delegateDid : delegate.uri,
      });
      expect(() => assertConnectRequest(validRefresh as unknown as Record<string, unknown>)).not.toThrow();
    });

    it('enforces redirect validation on authentication-bearing requests too', async () => {
      const delegate = await DidJwk.create();
      const base = await createBaseRedirectRequest({
        authentication: { version: 1, audience: 'https://app.example', challenge: randomToken() },
      });

      expect(() => assertConnectRequest(base as unknown as Record<string, unknown>)).not.toThrow();

      const badQuery = {
        ...base,
        reply: { mode: 'redirect' as const, callbackUrl: `${CONNECT_SERVER_URL}/callback`, redirectUri: `${REDIRECT_URI}?next=evil` },
      };
      expect(() => assertConnectRequest(badQuery as unknown as Record<string, unknown>)).toThrow();

      const preSupplied = { ...base, delegateDid: delegate.uri };
      expect(() => assertConnectRequest(preSupplied as unknown as Record<string, unknown>)).toThrow();
    });

    it('rejects combining handshakeKey and responseSecret or omitting responseSecret on redirect seal', async () => {
      const owner = await DidJwk.create();
      const delegate = await DidJwk.create();
      const request = await createBaseRedirectRequest();
      const responsePrivateKey = await X25519.generateKey();
      const handshakePrivate = await X25519.generateKey();
      const handshakeKey = { kty: 'OKP', crv: 'X25519', x: handshakePrivate.x };
      const responseSecret = generateRedirectResponseSecret();

      await expect(ConnectProvider.sealApprovedResponse({
        request,
        providerDid : owner.uri,
        signer      : delegate,
        approval    : {
          delegateDid         : delegate.uri,
          delegatePortableDid : await delegate.export(),
          delegateGrants      : [],
          sessionRevocations  : [],
        },
      })).rejects.toThrow('redirect responses require a 32-byte `responseSecret`');

      const iat = Math.floor(Date.now() / 1000);
      await expect(sealResponse({
        response: {
          providerDid        : owner.uri,
          delegateDid        : delegate.uri,
          aud                : request.clientDid,
          iat,
          exp                : iat + 600,
          nonce              : request.nonce,
          state              : request.state,
          delegateGrants     : [],
          sessionRevocations : [],
        },
        signer      : delegate,
        responseKey : { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x },
        handshakeKey,
        responseSecret,
      })).rejects.toThrow('cannot combine `handshakeKey` and `responseSecret`');

      await expect(openResponse({
        jwe                 : 'a.b.c.d.e',
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: request.clientDid, nonce: request.nonce, state: request.state, handshakeKey },
        responseSecret,
      })).rejects.toThrow('cannot combine `handshakeKey` and `responseSecret`');
    });
  });

  describe('buildRedirectReturnUri / parseRedirectReturnUri', () => {
    it('round-trips enbox_state and 32-byte enbox_key strictly through the fragment', () => {
      const secret = generateRedirectResponseSecret();
      const state = randomToken();

      const returnUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state, responseSecret: secret });
      const url = new URL(returnUrl);
      expect(url.search).toBe('');
      expect(url.hash).toContain('enbox_state=');
      expect(url.hash).toContain('enbox_key=');

      const parsed = parseRedirectReturnUri(returnUrl);
      expect(parsed).toEqual({ state, responseSecret: secret });
    });

    it('round-trips denial via enbox_error=denied', () => {
      const state = randomToken();
      const returnUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state, error: 'denied' });
      expect(parseRedirectReturnUri(returnUrl)).toEqual({ state, error: 'denied' });
    });

    it('returns undefined when no Enbox fragment parameters are present and ignores query params', () => {
      expect(parseRedirectReturnUri('https://app.example/callback')).toBeUndefined();
      expect(parseRedirectReturnUri('https://app.example/callback#section=1')).toBeUndefined();
      expect(parseRedirectReturnUri('https://app.example/callback?enbox_state=abc&enbox_key=xyz')).toBeUndefined();
      expect(parseRedirectReturnUri('not-a-url')).toBeUndefined();
    });

    it('rejects malformed return URIs and wrong-length secrets', () => {
      const shortSecret = CryptoUtils.randomBytes(16);
      expect(() => buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: '', responseSecret: generateRedirectResponseSecret() }))
        .toThrow('non-empty string');
      expect(() => buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: 'abc', responseSecret: shortSecret }))
        .toThrow('must be 32 bytes');

      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_key=${Convert.uint8Array(generateRedirectResponseSecret()).toBase64Url()}`))
        .toThrow('missing `enbox_state`');
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=abc`))
        .toThrow('missing `enbox_key`');
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=abc&enbox_key=xyz&enbox_error=denied`))
        .toThrow('cannot carry both');
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=abc&enbox_error=unknown`))
        .toThrow('unsupported redirect return error');
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=abc&enbox_key=${Convert.uint8Array(shortSecret).toBase64Url()}`))
        .toThrow('must decode to 32 bytes');
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=abc&enbox_key=***not-b64***`))
        .toThrow('not valid base64url');
    });
  });

  describe('fetchConnectAppManifest & isRedirectUriVerifiedInManifest', () => {
    it('fetches /.well-known/enbox-app with redirect: error and filters cross-origin or invalid entries', async () => {
      let observedUrl = '';
      let observedRedirect: RequestRedirect | undefined;
      const fetchFn = sinon.stub().callsFake(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        observedUrl = String(input);
        observedRedirect = init?.redirect;
        return new Response(JSON.stringify({
          redirectUris: [
            'https://app.example/connect/callback',
            'https://evil.example/steal',
            'https://app.example/callback?next=evil',
            42,
          ],
        }), { status: 200 });
      });

      const manifest = await fetchConnectAppManifest('https://app.example', { fetchFn });
      expect(observedUrl).toBe(`https://app.example${APP_MANIFEST_WELL_KNOWN_PATH}`);
      expect(observedRedirect).toBe('error');
      expect(manifest).toEqual({ redirectUris: ['https://app.example/connect/callback'] });

      expect(isRedirectUriVerifiedInManifest('https://app.example/connect/callback', manifest)).toBe(true);
      expect(isRedirectUriVerifiedInManifest('https://app.example/other', manifest)).toBe(false);
      expect(isRedirectUriVerifiedInManifest('https://evil.example/steal', manifest)).toBe(false);
      expect(isRedirectUriVerifiedInManifest('https://app.example/connect/callback', undefined)).toBe(false);
    });

    it('returns undefined when manifest is missing, redirected, invalid, or origin is malformed', async () => {
      expect(await fetchConnectAppManifest('not-a-url')).toBeUndefined();
      expect(await fetchConnectAppManifest('https://app.example/with-path')).toBeUndefined();

      const notFound = sinon.stub().resolves(new Response('Not Found', { status: 404 }));
      expect(await fetchConnectAppManifest('https://app.example', { fetchFn: notFound })).toBeUndefined();

      const redirected = sinon.stub().rejects(new TypeError('redirect blocked'));
      expect(await fetchConnectAppManifest('https://app.example', { fetchFn: redirected })).toBeUndefined();

      const badShape = sinon.stub().resolves(new Response(JSON.stringify({ redirectUris: 'not-array' }), { status: 200 }));
      expect(await fetchConnectAppManifest('https://app.example', { fetchFn: badShape })).toBeUndefined();
    });
  });

  describe('prepareRedirectConnectRequest + completeRedirectConnect / completeRedirectAuthentication', () => {
    it('runs a full delegation redirect handshake without polling while away', async () => {
      let storedRequestJwe = '';
      const relayBox: { responseJwe?: string } = {};
      let tokenGets = 0;
      let completePosts = 0;

      const fetchFn = sinon.stub().callsFake(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === `${CONNECT_SERVER_URL}/par` && init?.method === 'POST') {
          storedRequestJwe = (JSON.parse(init.body as string) as { request: string }).request;
          return new Response(JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }), { status: 201 });
        }
        if (url.startsWith(`${CONNECT_SERVER_URL}/token/`)) {
          tokenGets += 1;
          return relayBox.responseJwe === undefined
            ? new Response(null, { status: 204 })
            : new Response(relayBox.responseJwe, { status: 200 });
        }
        if (url === `${CONNECT_SERVER_URL}/complete` && init?.method === 'POST') {
          completePosts += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 201 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Mobile App',
        permissionRequests : [],
        fetchFn,
      });

      // Phase 1 MUST NOT poll /token while away.
      expect(tokenGets).toBe(0);
      expect(prepared.requestUri).toBe(REQUEST_URI);
      expect(prepared.pendingSession.redirectUri).toBe(REDIRECT_URI);

      // Wallet opens the request and seals with a fresh 256-bit responseSecret.
      const parsedUri = parseWalletConnectUri(prepared.walletUri)!;
      const request = await ConnectProvider.openRequest({
        jwe        : storedRequestJwe,
        decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
      });
      expect(request.reply).toEqual({
        mode        : 'redirect',
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        redirectUri : REDIRECT_URI,
      });

      const owner = await DidJwk.create();
      const delegate = await DidJwk.create();
      const responseSecret = generateRedirectResponseSecret();
      relayBox.responseJwe = await ConnectProvider.sealApprovedResponse({
        request,
        providerDid : owner.uri,
        signer      : delegate,
        responseSecret,
        approval    : {
          delegateDid         : delegate.uri,
          delegatePortableDid : await delegate.export(),
          delegateGrants      : [],
          sessionRevocations  : [],
        },
      });

      const returnUrl = buildRedirectReturnUri({
        redirectUri : REDIRECT_URI,
        state       : request.state,
        responseSecret,
      });

      // Wrong fragment secret must fail closed!
      const wrongSecretUrl = buildRedirectReturnUri({
        redirectUri    : REDIRECT_URI,
        state          : request.state,
        responseSecret : generateRedirectResponseSecret(),
      });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : wrongSecretUrl,
        fetchFn,
      })).rejects.toThrow();

      // Correct return URL decrypts and completes!
      const result = await completeRedirectConnect({
        pendingSession: prepared.pendingSession,
        returnUrl,
        fetchFn,
      });
      expect(result?.connectedDid).toBe(owner.uri);
      expect(result?.delegatePortableDid.uri).toBe(delegate.uri);
      expect(completePosts).toBe(1);
    });

    it('returns undefined on redirect denial and rejects state mismatch', async () => {
      const fetchFn = sinon.stub().resolves(
        new Response(JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }), { status: 201 }),
      );

      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Mobile App',
        permissionRequests : [],
        fetchFn,
      });

      const deniedUrl = buildRedirectReturnUri({
        redirectUri : REDIRECT_URI,
        state       : prepared.pendingSession.state,
        error       : 'denied',
      });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : deniedUrl,
        fetchFn,
      })).resolves.toBeUndefined();

      const wrongStateUrl = buildRedirectReturnUri({
        redirectUri    : REDIRECT_URI,
        state          : 'other-state',
        responseSecret : generateRedirectResponseSecret(),
      });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : wrongStateUrl,
        fetchFn,
      })).rejects.toThrow('enbox_state');
    });

    it('completes an authentication-only redirect flow end-to-end', async () => {
      let storedRequestJwe = '';
      const relayBox: { responseJwe?: string } = {};

      const fetchFn = sinon.stub().callsFake(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === `${CONNECT_SERVER_URL}/par`) {
          storedRequestJwe = (JSON.parse(init!.body as string) as { request: string }).request;
          return new Response(JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }), { status: 201 });
        }
        if (url.startsWith(`${CONNECT_SERVER_URL}/token/`)) {
          return new Response(relayBox.responseJwe ?? CONNECT_DENIED_TOKEN, { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      });

      const owner = await DidJwk.create();
      const challenge = randomToken();
      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl    : CONNECT_SERVER_URL,
        walletUri           : WALLET_URI,
        redirectUri         : REDIRECT_URI,
        appName             : 'Auth Redirect App',
        requestType         : 'authenticate',
        expectedProviderDid : owner.uri,
        permissionRequests  : [],
        authentication      : { version: 1, audience: 'https://app.example', challenge },
        fetchFn,
      });

      const parsedUri = parseWalletConnectUri(prepared.walletUri)!;
      const request = await ConnectProvider.openRequest({
        jwe        : storedRequestJwe,
        decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
      });

      const responseSecret = generateRedirectResponseSecret();
      relayBox.responseJwe = await ConnectProvider.sealAuthenticationResponse({
        request,
        providerDid : owner.uri,
        signer      : await DidJwk.create(),
        responseSecret,
        approval    : {
          authenticationProof: await createOwnerAuthenticationProof({ request, owner }),
        },
      });

      const returnUrl = buildRedirectReturnUri({
        redirectUri : REDIRECT_URI,
        state       : request.state,
        responseSecret,
      });

      await expect(completeRedirectConnect({
        pendingSession: prepared.pendingSession,
        returnUrl,
        fetchFn,
      })).rejects.toThrow('completeRedirectAuthentication');

      const authResult = await completeRedirectAuthentication({
        pendingSession: prepared.pendingSession,
        returnUrl,
        fetchFn,
      });
      expect(authResult?.connectedDid).toBe(owner.uri);
      expect(authResult?.authentication.subject).toBe(owner.uri);
      expect(authResult?.authentication.challenge).toBe(challenge);
    });
  });
});
