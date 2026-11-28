import type { ConnectRequest } from '../src/types.js';

import sinon from 'sinon';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { afterEach, describe, expect, it } from 'bun:test';
import { CryptoUtils, X25519 } from '@enbox/crypto';

import { CONNECT_DENIED_TOKEN } from '../src/types.js';
import { ConnectProvider } from '../src/provider.js';
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
import { assertConnectRequestAuthentication, createOwnerAuthenticationProof } from '../src/owner-authentication.js';

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

interface FakeRedirectRelay {
  fetchFn: sinon.SinonStub;
  state: { requestJwe: string; responseJwe?: string; tokenGets: number; completePosts: number };
  openStoredRequest: (walletUri: string) => Promise<ConnectRequest>;
}

function createFakeRedirectRelay(): FakeRedirectRelay {
  const state = { requestJwe: '', responseJwe: undefined as string | undefined, tokenGets: 0, completePosts: 0 };
  const fetchFn = sinon.stub().callsFake(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${CONNECT_SERVER_URL}/par` && init?.method === 'POST') {
      state.requestJwe = (JSON.parse(init.body as string) as { request: string }).request;
      return new Response(JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }), { status: 201 });
    }
    if (url.startsWith(`${CONNECT_SERVER_URL}/token/`)) {
      state.tokenGets += 1;
      return state.responseJwe === undefined
        ? new Response(null, { status: 204 })
        : new Response(state.responseJwe, { status: 200 });
    }
    if (url === `${CONNECT_SERVER_URL}/complete` && init?.method === 'POST') {
      state.completePosts += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const openStoredRequest = async (walletUri: string): Promise<ConnectRequest> => {
    const parsedUri = parseWalletConnectUri(walletUri)!;
    return await ConnectProvider.openRequest({
      jwe        : state.requestJwe,
      decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
    });
  };
  return { fetchFn, state, openStoredRequest };
}

describe('Connect same-device hybrid redirect', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('assertValidRedirectUri and request validation', () => {
    it('accepts HTTPS and localhost HTTP redirect URIs with no query or fragment', () => {
      for (const valid of [
        'https://app.example/callback',
        'https://app.example',
        'http://localhost:5173/callback',
        'http://127.0.0.1:8080/auth',
        'http://[::1]:3000/auth',
      ]) {
        expect(() => assertValidRedirectUri(valid)).not.toThrow();
      }
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

    it('validates relay callbackUrl and pre-supplied delegateDid rules on redirect requests', async () => {
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

      const delegate = await DidJwk.create();
      for (const requestType of [undefined, 'connect'] as const) {
        const invalid = await createBaseRedirectRequest({ requestType, delegateDid: delegate.uri });
        expect(() => assertConnectRequest(invalid as unknown as Record<string, unknown>))
          .toThrow('cannot be pre-supplied on a new "redirect" request');
      }
      const validRefresh = await createBaseRedirectRequest({ requestType: 'refresh', delegateDid: delegate.uri });
      expect(() => assertConnectRequest(validRefresh as unknown as Record<string, unknown>)).not.toThrow();
    });

    it('enforces redirect validation directly inside assertConnectRequestAuthentication', async () => {
      const delegate = await DidJwk.create();
      const base = await createBaseRedirectRequest({
        authentication: { version: 1, audience: 'https://app.example', challenge: randomToken() },
      });
      expect(() => assertConnectRequestAuthentication(base)).not.toThrow();

      for (const invalid of [
        { ...base, reply: { mode: 'redirect' as const, callbackUrl: `${CONNECT_SERVER_URL}/callback`, redirectUri: `${REDIRECT_URI}?next=evil` } },
        { ...base, delegateDid: delegate.uri },
        { ...base, reply: { mode: 'redirect' as const, callbackUrl: `${CONNECT_SERVER_URL}/callback`, redirectUri: 'https://other.example/callback' } },
        { ...base, reply: { mode: 'redirect' as const, callbackUrl: `${CONNECT_SERVER_URL}/callback`, redirectUri: 'http://localhost:5173/callback' } },
      ]) {
        expect(() => assertConnectRequestAuthentication(invalid)).toThrow('invalid-request');
      }
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
    it('round-trips enbox_state, 32-byte enbox_key, and denial strictly through the fragment', () => {
      const secret = generateRedirectResponseSecret();
      const state = randomToken();

      const returnUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state, responseSecret: secret });
      const url = new URL(returnUrl);
      expect(url.search).toBe('');
      expect(url.hash).toContain('enbox_state=');
      expect(url.hash).toContain('enbox_key=');
      expect(parseRedirectReturnUri(returnUrl)).toEqual({ state, responseSecret: secret });

      const deniedUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state, error: 'denied' });
      expect(parseRedirectReturnUri(deniedUrl)).toEqual({ state, error: 'denied' });

      expect(parseRedirectReturnUri('https://app.example/callback')).toBeUndefined();
      expect(parseRedirectReturnUri('https://app.example/callback#section=1')).toBeUndefined();
      expect(parseRedirectReturnUri('https://app.example/callback?enbox_state=abc&enbox_key=xyz')).toBeUndefined();
      expect(parseRedirectReturnUri('not-a-url')).toBeUndefined();
    });

    it('rejects malformed return URIs, duplicate params, non-canonical base64url, and all-zero secrets', () => {
      const shortSecret = CryptoUtils.randomBytes(16);
      const validEncodedKey = Convert.uint8Array(generateRedirectResponseSecret()).toBase64Url();

      expect(() => buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: '', responseSecret: generateRedirectResponseSecret() }))
        .toThrow('non-empty string');
      expect(() => buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: 'abc', responseSecret: shortSecret }))
        .toThrow('must be 32 bytes');
      expect(() => buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: 'abc', responseSecret: new Uint8Array(32) }))
        .toThrow('must not be all zeros');

      const badCases: [string, string][] = [
        [`${REDIRECT_URI}#enbox_key=${validEncodedKey}`, 'missing `enbox_state`'],
        [`${REDIRECT_URI}#enbox_state=abc`, 'missing `enbox_key`'],
        [`${REDIRECT_URI}#enbox_state=abc&enbox_key=xyz&enbox_error=denied`, 'cannot carry both'],
        [`${REDIRECT_URI}#enbox_state=abc&enbox_error=unknown`, 'unsupported redirect return error'],
        [`${REDIRECT_URI}#enbox_state=abc&enbox_key=${Convert.uint8Array(shortSecret).toBase64Url()}`, 'canonical 32-byte base64url'],
        [`${REDIRECT_URI}#enbox_state=abc&enbox_key=***not-b64***`, 'canonical 32-byte base64url'],
        [`${REDIRECT_URI}#enbox_state=a&enbox_state=b&enbox_key=${validEncodedKey}`, 'duplicate Enbox parameters'],
        [`${REDIRECT_URI}#enbox_state=abc&enbox_key=${validEncodedKey.slice(0, 42)}9`, 'canonical 32-byte base64url'],
        [`${REDIRECT_URI}#enbox_state=abc&enbox_key=${Convert.uint8Array(new Uint8Array(32)).toBase64Url()}`, 'must not be all zeros'],
      ];
      for (const [uri, expectedMessage] of badCases) {
        expect(() => parseRedirectReturnUri(uri)).toThrow(expectedMessage);
      }
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

    it('returns undefined when manifest is missing, redirected, invalid, oversized, non-local http, or malformed origin', async () => {
      expect(await fetchConnectAppManifest('not-a-url')).toBeUndefined();
      expect(await fetchConnectAppManifest('https://app.example/with-path')).toBeUndefined();
      const remoteHttpFetch = sinon.stub();
      expect(await fetchConnectAppManifest('http://app.example', { fetchFn: remoteHttpFetch })).toBeUndefined();
      expect(remoteHttpFetch.called).toBe(false);

      expect(await fetchConnectAppManifest('https://app.example', {
        fetchFn: sinon.stub().resolves(new Response('Not Found', { status: 404 })),
      })).toBeUndefined();
      expect(await fetchConnectAppManifest('https://app.example', {
        fetchFn: sinon.stub().rejects(new TypeError('redirect blocked')),
      })).toBeUndefined();
      expect(await fetchConnectAppManifest('https://app.example', {
        fetchFn: sinon.stub().resolves(new Response(JSON.stringify({ redirectUris: 'not-array' }), { status: 200 })),
      })).toBeUndefined();

      let chunksPulled = 0;
      const hugeStream = new ReadableStream<Uint8Array>({
        pull(controller): void {
          chunksPulled += 1;
          controller.enqueue(new Uint8Array(32_768));
        },
      });
      expect(await fetchConnectAppManifest('https://app.example', {
        fetchFn: sinon.stub().resolves(new Response(hugeStream, { status: 200 })),
      })).toBeUndefined();
      expect(chunksPulled).toBeLessThanOrEqual(4);
    });
  });

  describe('prepareRedirectConnectRequest + completeRedirectConnect / completeRedirectAuthentication', () => {
    it('runs a full delegation redirect handshake without polling while away', async () => {
      const relay = createFakeRedirectRelay();
      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Mobile App',
        permissionRequests : [],
        fetchFn            : relay.fetchFn,
      });

      // Phase 1 MUST NOT poll /token while away.
      expect(relay.state.tokenGets).toBe(0);
      expect(prepared.requestUri).toBe(REQUEST_URI);
      expect(prepared.pendingSession.redirectUri).toBe(REDIRECT_URI);

      const request = await relay.openStoredRequest(prepared.walletUri);
      expect(request.reply).toEqual({
        mode        : 'redirect',
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        redirectUri : REDIRECT_URI,
      });

      const owner = await DidJwk.create();
      const delegate = await DidJwk.create();
      const responseSecret = generateRedirectResponseSecret();
      relay.state.responseJwe = await ConnectProvider.sealApprovedResponse({
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

      const returnUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: request.state, responseSecret });
      const wrongSecretUrl = buildRedirectReturnUri({
        redirectUri    : REDIRECT_URI,
        state          : request.state,
        responseSecret : generateRedirectResponseSecret(),
      });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : wrongSecretUrl,
        fetchFn        : relay.fetchFn,
      })).rejects.toThrow();

      const result = await completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl,
        fetchFn        : relay.fetchFn,
      });
      expect(result?.connectedDid).toBe(owner.uri);
      expect(result?.delegatePortableDid.uri).toBe(delegate.uri);
      expect(relay.state.completePosts).toBe(1);
    });

    it('returns undefined on redirect denial and rejects state mismatch', async () => {
      const relay = createFakeRedirectRelay();
      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Mobile App',
        permissionRequests : [],
        fetchFn            : relay.fetchFn,
      });

      const deniedUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: prepared.pendingSession.state, error: 'denied' });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : deniedUrl,
        fetchFn        : relay.fetchFn,
      })).resolves.toBeUndefined();

      const wrongStateUrl = buildRedirectReturnUri({
        redirectUri    : REDIRECT_URI,
        state          : 'other-state',
        responseSecret : generateRedirectResponseSecret(),
      });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : wrongStateUrl,
        fetchFn        : relay.fetchFn,
      })).rejects.toThrow('enbox_state');
    });

    it('completes an authentication-only redirect flow and enforces expectedProviderDid', async () => {
      const relay = createFakeRedirectRelay();
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
        fetchFn             : relay.fetchFn,
      });

      const request = await relay.openStoredRequest(prepared.walletUri);
      const responseSecret = generateRedirectResponseSecret();
      relay.state.responseJwe = await ConnectProvider.sealAuthenticationResponse({
        request,
        providerDid : owner.uri,
        signer      : await DidJwk.create(),
        responseSecret,
        approval    : { authenticationProof: await createOwnerAuthenticationProof({ request, owner }) },
      });

      const returnUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: request.state, responseSecret });
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl,
        fetchFn        : relay.fetchFn,
      })).rejects.toThrow('completeRedirectAuthentication');

      await expect(completeRedirectAuthentication({
        pendingSession      : prepared.pendingSession,
        returnUrl,
        expectedProviderDid : 'did:dht:other-provider',
        fetchFn             : relay.fetchFn,
      })).rejects.toThrow('expectedProviderDid');

      const authResult = await completeRedirectAuthentication({
        pendingSession : prepared.pendingSession,
        returnUrl,
        fetchFn        : relay.fetchFn,
      });
      expect(authResult?.connectedDid).toBe(owner.uri);
      expect(authResult?.authentication.subject).toBe(owner.uri);
      expect(authResult?.authentication.challenge).toBe(challenge);
    });

    it('keeps delegate private keys out of pendingSession on refresh and re-supplies localDelegatePortableDid on return', async () => {
      const relay = createFakeRedirectRelay();
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
        fetchFn             : relay.fetchFn,
      });
      expect(JSON.stringify(prepared.pendingSession)).not.toContain('privateKeys');

      const request = await relay.openStoredRequest(prepared.walletUri);
      const responseSecret = generateRedirectResponseSecret();
      relay.state.responseJwe = await ConnectProvider.sealApprovedResponse({
        request,
        providerDid : owner.uri,
        signer      : delegate,
        responseSecret,
        approval    : { delegateDid: delegate.uri, delegateGrants: [], sessionRevocations: [] },
      });
      const returnUrl = buildRedirectReturnUri({ redirectUri: REDIRECT_URI, state: request.state, responseSecret });

      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl,
        fetchFn        : relay.fetchFn,
      })).rejects.toThrow('localDelegatePortableDid');

      const result = await completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl,
        localDelegatePortableDid,
        fetchFn        : relay.fetchFn,
      });
      expect(result?.connectedDid).toBe(owner.uri);
      expect(result?.delegatePortableDid).toEqual(localDelegatePortableDid);
    });

    it('enforces session expiry and exact returnUrl match (including bare trailing ?)', async () => {
      const baseNow = 1_700_000_000_000;
      const relay = createFakeRedirectRelay();
      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Hardened Redirect App',
        permissionRequests : [],
        fetchFn            : relay.fetchFn,
        now                : (): number => baseNow,
      });

      const validReturnUrl = buildRedirectReturnUri({
        redirectUri    : REDIRECT_URI,
        state          : prepared.pendingSession.state,
        responseSecret : generateRedirectResponseSecret(),
      });
      const fragment = new URL(validReturnUrl).hash;

      await expect(completeRedirectConnect({
        pendingSession  : prepared.pendingSession,
        returnUrl       : validReturnUrl,
        fetchFn         : relay.fetchFn,
        maxSessionAgeMs : 60_000,
        now             : (): number => baseNow + 60_001,
      })).rejects.toThrow('expired');

      for (const badReturnUrl of [
        `https://app.example/other/path${fragment}`,
        `${REDIRECT_URI}?${fragment}`,
        `${REDIRECT_URI}?injected=1${fragment}`,
      ]) {
        await expect(completeRedirectConnect({
          pendingSession : prepared.pendingSession,
          returnUrl      : badReturnUrl,
          fetchFn        : relay.fetchFn,
          now            : (): number => baseNow + 1_000,
        })).rejects.toThrow('does not match the requested `redirectUri`');
      }
    });

    it('retries transient token errors, fast-fails 4xx, and honors prepare abort signals', async () => {
      const baseNow = 1_700_000_000_000;
      const relay = createFakeRedirectRelay();
      const prepared = await prepareRedirectConnectRequest({
        connectServerUrl   : CONNECT_SERVER_URL,
        walletUri          : WALLET_URI,
        redirectUri        : REDIRECT_URI,
        appName            : 'Retry Redirect App',
        permissionRequests : [],
        fetchFn            : relay.fetchFn,
        now                : (): number => baseNow,
      });
      const validReturnUrl = buildRedirectReturnUri({
        redirectUri    : REDIRECT_URI,
        state          : prepared.pendingSession.state,
        responseSecret : generateRedirectResponseSecret(),
      });

      const forbiddenFetch = sinon.stub().resolves(new Response('Forbidden', { status: 403 }));
      await expect(completeRedirectConnect({
        pendingSession : prepared.pendingSession,
        returnUrl      : validReturnUrl,
        fetchFn        : forbiddenFetch,
        sleepFn        : async (): Promise<void> => {},
        now            : (): number => baseNow + 1_000,
      })).rejects.toThrow('HTTP 403');
      expect(forbiddenFetch.callCount).toBe(1);

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
