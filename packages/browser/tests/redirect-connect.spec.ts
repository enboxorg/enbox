import type { RedirectSessionStorage } from '../src/redirect-connect.js';

import { describe, expect, it } from 'bun:test';

import { DidJwk } from '@enbox/dids';
import {
  buildRedirectReturnUri,
  ConnectProvider,
  createOwnerAuthenticationProof,
  generateRedirectResponseSecret,
  parseWalletConnectUri,
  randomToken,
} from '@enbox/connect';

import {
  completeRedirectAuthenticationFromWindow,
  completeRedirectConnectFromWindow,
  getPendingRedirectConnectType,
  hasPendingRedirectConnect,
  isIosStandalonePwa,
  isSessionStorageAvailable,
  PENDING_REDIRECT_MAX_AGE_MS,
  PENDING_REDIRECT_STORAGE_KEY,
  startRedirectConnect,
} from '../src/redirect-connect.js';

function createFakeStorage(): RedirectSessionStorage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem    : (key: string): string | null => map.get(key) ?? null,
    setItem    : (key: string, value: string): void => { map.set(key, value); },
    removeItem : (key: string): void => { map.delete(key); },
    dump       : (): Record<string, string> => Object.fromEntries(map),
  };
}

describe('isIosStandalonePwa', () => {
  it('detects navigator.standalone === true', () => {
    expect(isIosStandalonePwa(
      { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5, standalone: true },
      undefined,
    )).toBe(true);
  });

  it('detects iOS / iPadOS desktop-UA devices matching display-mode: standalone', () => {
    const standaloneWin = {
      matchMedia: (query: string): MediaQueryList => ({ matches: query === '(display-mode: standalone)' } as MediaQueryList),
    };
    const browserWin = {
      matchMedia: (): MediaQueryList => ({ matches: false } as MediaQueryList),
    };

    expect(isIosStandalonePwa(
      { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 },
      standaloneWin,
    )).toBe(true);

    expect(isIosStandalonePwa(
      { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 },
      standaloneWin,
    )).toBe(true);

    expect(isIosStandalonePwa(
      { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 },
      browserWin,
    )).toBe(false);

    expect(isIosStandalonePwa(
      { userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l', maxTouchPoints: 5 },
      standaloneWin,
    )).toBe(false);

    expect(isIosStandalonePwa(
      { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: '', maxTouchPoints: 5 },
      { matchMedia: (query: string): MediaQueryList => ({ matches: query === '(display-mode: fullscreen)' } as MediaQueryList) },
    )).toBe(true);

    expect(isIosStandalonePwa(undefined, undefined)).toBe(false);
  });

  it('probes sessionStorage availability safely', () => {
    expect(isSessionStorageAvailable()).toBe(true);
    expect(isSessionStorageAvailable(createFakeStorage())).toBe(true);
    expect(isSessionStorageAvailable(null)).toBe(false);
    expect(isSessionStorageAvailable({
      getItem    : (): null => null,
      setItem    : (): void => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
      removeItem : (): void => {},
    })).toBe(false);
  });
});

describe('browser redirect connect lifecycle', () => {
  const connectServerUrl = 'https://relay.example/connect';
  const walletUri = 'https://wallet.example/connect/app';
  const redirectUri = 'https://app.example/connect/callback';
  const requestUri = 'https://relay.example/connect/authorize/req-1.jwt';

  it('persists session, navigates to wallet, scrubs fragment, and completes on return', async () => {
    const storage = createFakeStorage();
    let storedRequestJwe = '';
    let storedResponseJwe = '';
    let navigatedTo = '';
    let scrubbed = 0;

    const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `${connectServerUrl}/par`) {
        storedRequestJwe = (JSON.parse(init!.body as string) as { request: string }).request;
        return new Response(JSON.stringify({ request_uri: requestUri, expires_in: 600 }), { status: 201 });
      }
      if (url.startsWith(`${connectServerUrl}/token/`)) {
        return new Response(storedResponseJwe, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };

    const pendingSession = await startRedirectConnect({
      connectServerUrl,
      walletUri,
      redirectUri,
      appName            : 'Browser Redirect App',
      permissionRequests : [],
      storage,
      fetchFn,
      navigate           : (url): void => { navigatedTo = url; },
    });

    expect(navigatedTo).toContain(walletUri);
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).not.toBeNull();

    // Wallet side approves and builds return URL.
    const parsedUri = parseWalletConnectUri(navigatedTo)!;
    const request = await ConnectProvider.openRequest({
      jwe        : storedRequestJwe,
      decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
    });
    const owner = await DidJwk.create();
    const delegate = await DidJwk.create();
    const responseSecret = generateRedirectResponseSecret();
    storedResponseJwe = await ConnectProvider.sealApprovedResponse({
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
    const returnUrl = buildRedirectReturnUri({ redirectUri, state: request.state, responseSecret });

    expect(hasPendingRedirectConnect({ storage, href: returnUrl })).toBe(true);
    expect(getPendingRedirectConnectType({ storage, href: returnUrl })).toBe('connect');
    expect(hasPendingRedirectConnect({ storage, href: redirectUri })).toBe(false);
    expect(getPendingRedirectConnectType({ storage, href: redirectUri })).toBeUndefined();

    // A stray state mismatch or wrong completion helper must NOT delete the live session.
    const wrongStateUrl = buildRedirectReturnUri({ redirectUri, state: 'other-state', responseSecret });
    await expect(completeRedirectConnectFromWindow({
      storage,
      href          : wrongStateUrl,
      scrubFragment : (): void => {},
      fetchFn,
    })).rejects.toThrow('enbox_state');
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).not.toBeNull();

    await expect(completeRedirectAuthenticationFromWindow({
      storage,
      href          : returnUrl,
      scrubFragment : (): void => {},
      fetchFn,
    })).rejects.toThrow('invalid-request');
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).not.toBeNull();

    const result = await completeRedirectConnectFromWindow({
      storage,
      href          : returnUrl,
      scrubFragment : (): void => { scrubbed += 1; },
      fetchFn,
    });

    expect(scrubbed).toBe(1);
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).toBeNull();
    expect(result?.connectedDid).toBe(owner.uri);
    expect(result?.delegatePortableDid.uri).toBe(delegate.uri);
    expect(pendingSession.state).toBe(request.state);
  });

  it('returns undefined when no redirect params are present and rejects expired or missing sessions after scrubbing', async () => {
    const storage = createFakeStorage();
    let scrubbed = 0;

    expect(await completeRedirectConnectFromWindow({
      storage,
      href          : redirectUri,
      scrubFragment : (): void => { scrubbed += 1; },
    })).toBeUndefined();
    expect(scrubbed).toBe(0);

    const returnUrl = buildRedirectReturnUri({
      redirectUri,
      state          : 'stale-state',
      responseSecret : generateRedirectResponseSecret(),
    });

    // Missing session rejects and still scrubs the URL fragment.
    await expect(completeRedirectConnectFromWindow({
      storage,
      href          : returnUrl,
      scrubFragment : (): void => { scrubbed += 1; },
    })).rejects.toThrow('No pending redirect connect session');
    expect(scrubbed).toBe(1);

    // Expired session is dropped and rejected.
    const now = 1_000_000;
    storage.setItem(PENDING_REDIRECT_STORAGE_KEY, JSON.stringify({
      clientDid          : 'did:jwk:a',
      responsePrivateKey : { kty: 'OKP', crv: 'X25519', d: 'a', x: 'b' },
      nonce              : 'n',
      state              : 'stale-state',
      connectServerUrl,
      redirectUri,
      request            : {},
      createdAt          : now - PENDING_REDIRECT_MAX_AGE_MS - 1,
    }));
    expect(hasPendingRedirectConnect({ storage, href: returnUrl, now: (): number => now })).toBe(false);
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).toBeNull();

    // Corrupt / partial session JSON is safely cleared.
    storage.setItem(PENDING_REDIRECT_STORAGE_KEY, '{not-json');
    expect(hasPendingRedirectConnect({ storage, href: returnUrl })).toBe(false);
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).toBeNull();

    storage.setItem(PENDING_REDIRECT_STORAGE_KEY, JSON.stringify({ state: 'stale-state' }));
    expect(hasPendingRedirectConnect({ storage, href: returnUrl })).toBe(false);
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).toBeNull();

    // Malformed fragment scrubs and throws.
    await expect(completeRedirectConnectFromWindow({
      storage,
      href          : `${redirectUri}#enbox_state=abc&enbox_key=AAAA`,
      scrubFragment : (): void => { scrubbed += 1; },
    })).rejects.toThrow('must decode to 32 bytes');
    expect(scrubbed).toBe(2);
    expect(hasPendingRedirectConnect({ storage, href: `${redirectUri}#enbox_state=abc&enbox_key=AAAA` })).toBe(false);
  });

  it('completes an authentication-only redirect via sessionStorage and scrubs window.location hash', async () => {
    let storedRequestJwe = '';
    let storedResponseJwe = '';
    let navigatedTo = '';
    const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `${connectServerUrl}/par`) {
        storedRequestJwe = (JSON.parse(init!.body as string) as { request: string }).request;
        return new Response(JSON.stringify({ request_uri: requestUri, expires_in: 600 }), { status: 201 });
      }
      if (url.startsWith(`${connectServerUrl}/token/`)) {
        return new Response(storedResponseJwe, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };

    const owner = await DidJwk.create();
    const challenge = randomToken();
    const windowRedirectUri = `${window.location.origin}${window.location.pathname}`;
    const isWindowHttps = window.location.protocol === 'https:';
    const authRedirectUri = isWindowHttps ? windowRedirectUri : redirectUri;
    await startRedirectConnect({
      connectServerUrl,
      walletUri,
      redirectUri         : authRedirectUri,
      appName             : 'Auth Redirect Browser App',
      requestType         : 'authenticate',
      expectedProviderDid : owner.uri,
      permissionRequests  : [],
      authentication      : { version: 1, audience: new URL(authRedirectUri).origin, challenge },
      fetchFn,
      navigate            : (url): void => { navigatedTo = url; },
    });

    const parsedUri = parseWalletConnectUri(navigatedTo)!;
    const request = await ConnectProvider.openRequest({
      jwe        : storedRequestJwe,
      decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
    });
    const responseSecret = generateRedirectResponseSecret();
    storedResponseJwe = await ConnectProvider.sealAuthenticationResponse({
      request,
      providerDid : owner.uri,
      signer      : await DidJwk.create(),
      responseSecret,
      approval    : { authenticationProof: await createOwnerAuthenticationProof({ request, owner }) },
    });

    const returnUrl = buildRedirectReturnUri({ redirectUri: authRedirectUri, state: request.state, responseSecret });
    expect(await completeRedirectAuthenticationFromWindow({ href: authRedirectUri })).toBeUndefined();

    // Exercise default window.history.replaceState scrubbing + default sessionStorage.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${new URL(returnUrl).hash}`);
    expect(hasPendingRedirectConnect({ href: returnUrl })).toBe(true);
    expect(getPendingRedirectConnectType({ href: returnUrl })).toBe('authenticate');

    const authResult = await completeRedirectAuthenticationFromWindow({ href: returnUrl, fetchFn });
    expect(window.location.hash).toBe('');
    expect(authResult?.connectedDid).toBe(owner.uri);
    expect(authResult?.authentication.subject).toBe(owner.uri);
    expect(authResult?.authentication.challenge).toBe(challenge);
  });
});
