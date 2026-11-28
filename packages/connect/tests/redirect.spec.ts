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

    it('rejects insecure schemes, query strings, fragments, credentials, whitespace, non-canonical URLs, and oversized URIs', () => {
      for (const invalid of [
        '',
        'not a url',
        'http://app.example/callback',
        'javascript:alert(1)',
        'https://user:pass@app.example/callback',
        'https://@app.example/callback',
        'https://:@app.example/callback',
        'https://evil.example\\@app.example/callback',
        'https://app.example/callback\u0000',
        'https://app.example/callback\n',
        'https://app.example:0/callback',
        'https://app.example/a/../callback',
        'http://127.1/callback',
        'https://APP.EXAMPLE/callback',
        'https://app.example:443/callback',
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

    it('validates relay callbackUrl on redirect requests', async () => {
      for (const badCallback of [
        '',
        'http://relay.example/callback',
        'https://user:pass@relay.example/callback',
        'https://relay.example/callback#frag',
        'javascript:alert(1)',
      ]) {
        const invalid = await createBaseRedirectRequest({
          reply: { mode: 'redirect', callbackUrl: badCallback, redirectUri: REDIRECT_URI },
        });
        expect(() => assertConnectRequest(invalid as unknown as Record<string, unknown>)).toThrow('reply.callbackUrl');
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

      // Authentication-bearing redirect requests must match the audience origin over HTTPS.
      const crossOriginRedirect = {
        ...base,
        reply: { mode: 'redirect' as const, callbackUrl: `${CONNECT_SERVER_URL}/callback`, redirectUri: 'https://other.example/callback' },
      };
      expect(() => assertConnectRequest(crossOriginRedirect as unknown as Record<string, unknown>)).toThrow('invalid-request');

      const localhostRedirect = {
        ...base,
        reply: { mode: 'redirect' as const, callbackUrl: `${CONNECT_SERVER_URL}/callback`, redirectUri: 'http://localhost:5173/callback' },
      };
      expect(() => assertConnectRequest(localhostRedirect as unknown as Record<string, unknown>)).toThrow('invalid-request');
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
      // Duplicate fragment params
      const validEncodedKey = Convert.uint8Array(generateRedirectResponseSecret()).toBase64Url();
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=a&enbox_state=b&enbox_key=${validEncodedKey}`))
        .toThrow('duplicate Enbox parameters');
      // Non-canonical trailing bits in 43-char base64url
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=abc&enbox_key=${validEncodedKey.slice(0, 42)}9`))
        .toThrow('not valid base64url');
      // All-zero 32-byte key
      expect(() => parseRedirectReturnUri(`${REDIRECT_URI}#enbox_state=abc&enbox_key=${Convert.uint8Array(new Uint8Array(32)).toBase64Url()}`))
        .toThrow('must not be all zeros');
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

    it('returns undefined when manifest is missing, redirected, invalid, oversized, non-local http, or origin is malformed', async () => {
      expect(await fetchConnectAppManifest('not-a-url')).toBeUndefined();
      expect(await fetchConnectAppManifest('https://app.example/with-path')).toBeUndefined();
      // Cleartext HTTP is rejected for remote origins (allowed only on loopback).
      const remoteHttpFetch = sinon.stub();
      expect(await fetchConnectAppManifest('http://app.example', { fetchFn: remoteHttpFetch })).toBeUndefined();
      expect(remoteHttpFetch.called).toBe(false);

      const notFound = sinon.stub().resolves(new Response('Not Found', { status: 404 }));
      expect(await fetchConnectAppManifest('https://app.example', { fetchFn: notFound })).toBeUndefined();

      const redirected = sinon.stub().rejects(new TypeError('redirect blocked'));
      expect(await fetchConnectAppManifest('https://app.example', { fetchFn: redirected })).toBeUndefined();

      const badShape = sinon.stub().resolves(new Response(JSON.stringify({ redirectUris: 'not-array' }), { status: 200 }));
      expect(await fetchConnectAppManifest('https://app.example', { fetchFn: badShape })).toBeUndefined();

      // Oversized streaming body is aborted without buffering unbounded bytes.
      let chunksPulled = 0;
      const hugeStream = new ReadableStream<Uint8Array>({
        pull(controller): void {
          chunksPulled += 1;
          controller.enqueue(new Uint8Array(32_768));
        },
      });
      const hugeFetch = sinon.stub().resolves(new Response(hugeStream, { status: 200 }));
      expect(await fetchConnectAppManifest('https://app.example', { fetchFn: hugeFetch })).toBeUndefined();
      expect(chunksPulled).toBeLessThanOrEqual(4);
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

    it('keeps delegate private keys out of pendingSession on refresh and re-supplies localDelegatePortableDid on return', async () => {
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
      const delegate = await DidJwk.create();
      const localDelegatePortableDid = await delegate.export();

      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl    : CONNECT_SERVER_URL,
        walletUri           : WALLET_URI,
        redirectUri         : REDIRECT_URI,
        appName             : 'Refresh Redirect App',
        requestType         : 'refresh',
        delegateDid         : delegate.uri,
        expectedProviderDid : owner.uri,
        permissionRequests  : [],
        fetchFn,
      });

      // Serialized pendingSession must never carry long-lived delegate private keys.
      expect(JSON.stringify(prepared.pendingSession)).not.toContain('privateKeys');

      const parsedUri = parseWalletConnectUri(prepared.walletUri)!;
      const request = await ConnectProvider.openRequest({
        jwe        : storedRequestJwe,
        decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
      });
      const responseSecret = generateRedirectResponseSecret();
      relayBox.responseJwe = await ConnectProvider.sealApprovedResponse({
        request,
        providerDid : owner.uri,
        signer      : delegate,
        responseSecret,
        approval    : {
          delegateDid        : delegate.uri,
          delegateGrants     : [],
          sessionRevocations : [],
        },
      });
      const returnUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: request.state, responseSecret });

      // Missing localDelegatePortableDid fails before consuming the relay token.
      await expect(completeRedirectConnect({
        pendingSession: prepared.pendingSession,
        returnUrl,
        fetchFn,
      })).rejects.toThrow('localDelegatePortableDid');

      const result = await completeRedirectConnect({
        pendingSession: prepared.pendingSession,
        returnUrl,
        localDelegatePortableDid,
        fetchFn,
      });
      expect(result?.connectedDid).toBe(owner.uri);
      expect(result?.delegatePortableDid).toEqual(localDelegatePortableDid);
    });

    it('enforces session expiry, exact returnUrl match, transient token retries, and fast-fail 4xx', async () => {
      const baseNow = 1_700_000_000_000;
      const fetchFn = sinon.stub().resolves(
        new Response(JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }), { status: 201 }),
      );

      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Hardened Redirect App',
        permissionRequests : [],
        fetchFn,
        now                : (): number => baseNow,
      });

      const validReturnUrl = buildRedirectReturnUri({
        redirectUri    : REDIRECT_URI,
        state          : prepared.pendingSession.state,
        responseSecret : generateRedirectResponseSecret(),
      });

      // Expired pendingSession is rejected inside @enbox/connect itself.
      await expect(completeRedirectConnect({
        pendingSession  : prepared.pendingSession,
        returnUrl       : validReturnUrl,
        fetchFn,
        maxSessionAgeMs : 60_000,
        now             : (): number => baseNow + 60_001,
      })).rejects.toThrow('expired');

      // Mismatched returnUrl path or injected query string is rejected.
      const wrongPathUrl = buildRedirectReturnUri({
        redirectUri    : 'https://app.example/other/path',
        state          : prepared.pendingSession.state,
        responseSecret : generateRedirectResponseSecret(),
      });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : wrongPathUrl,
        fetchFn,
        now            : (): number => baseNow + 1_000,
      })).rejects.toThrow('does not match the requested `redirectUri`');

      // Non-retryable 403 fast-fails with exact status without retrying.
      const forbiddenFetch = sinon.stub().resolves(new Response('Forbidden', { status: 403 }));
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : validReturnUrl,
        fetchFn        : forbiddenFetch,
        sleepFn        : async (): Promise<void> => {},
        now            : (): number => baseNow + 1_000,
      })).rejects.toThrow('HTTP 403');
      expect(forbiddenFetch.callCount).toBe(1);

      // Transient network error + 503 retries and succeeds on 3rd attempt (DENIED).
      const flakyFetch = sinon.stub();
      flakyFetch.onCall(0).rejects(new TypeError('Failed to fetch'));
      flakyFetch.onCall(1).resolves(new Response('Service Unavailable', { status: 503 }));
      flakyFetch.onCall(2).resolves(new Response(CONNECT_DENIED_TOKEN, { status: 200 }));
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : validReturnUrl,
        fetchFn        : flakyFetch,
        sleepFn        : async (): Promise<void> => {},
        now            : (): number => baseNow + 1_000,
      })).resolves.toBeUndefined();
      expect(flakyFetch.callCount).toBe(3);

      // Aborted signal aborts prepareRedirectConnectRequest before calling fetch.
      const controller = new AbortController();
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      const unusedFetch = sinon.stub();
      await expect(prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Aborted App',
        permissionRequests : [],
        fetchFn            : unusedFetch,
        signal             : controller.signal,
      })).rejects.toThrow();
      expect(unusedFetch.called).toBe(false);
    });
  });
});
