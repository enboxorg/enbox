import type { RedirectSessionStorage } from '../src/redirect-connect.js';

import { describe, expect, it } from 'bun:test';

import { DidJwk } from '@enbox/dids';
import {
  buildRedirectReturnUri,
  ConnectProvider,
  createOwnerAuthenticationProof,
  DEFAULT_REDIRECT_SESSION_MAX_AGE_MS,
  generateRedirectResponseSecret,
  parseWalletConnectUri,
  randomToken,
} from '@enbox/connect';

import {
  completeRedirectAuthenticationFromWindow,
  completeRedirectConnectFromWindow,
  getPendingRedirectConnectType,
  isIosStandalonePwa,
  isSessionStorageAvailable,
  PENDING_REDIRECT_STORAGE_KEY,
  startRedirectConnect,
} from '../src/redirect-connect.js';

function createFakeStorage(): RedirectSessionStorage {
  const map = new Map<string, string>();
  return {
    getItem    : (key: string): string | null => map.get(key) ?? null,
    setItem    : (key: string, value: string): void => { map.set(key, value); },
    removeItem : (key: string): void => { map.delete(key); },
  };
}

describe('isIosStandalonePwa & isSessionStorageAvailable', () => {
  const matchDisplay = (mode?: string): Pick<Window, 'matchMedia'> => ({
    matchMedia: (query: string): MediaQueryList => ({ matches: mode !== undefined && query === `(display-mode: ${mode})` } as MediaQueryList),
  });

  it.each([
    ['navigator.standalone === true', { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5, standalone: true }, undefined, true],
    ['iPhone standalone display-mode', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }, matchDisplay('standalone'), true],
    ['iPadOS desktop UA standalone', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }, matchDisplay('standalone'), true],
    ['iPadOS Macintosh UA fullscreen', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: '', maxTouchPoints: 5 }, matchDisplay('fullscreen'), true],
    ['iPhone normal Safari tab', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }, matchDisplay(), false],
    ['Android standalone PWA', { userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l', maxTouchPoints: 5 }, matchDisplay('standalone'), false],
    ['missing navigator', undefined, undefined, false],
  ] as const)('isIosStandalonePwa(%s) -> %s', (_label, nav, win, expected) => {
    expect(isIosStandalonePwa(nav, win)).toBe(expected);
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

  interface FakeBrowserRelay {
    fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>;
    box: { requestJwe: string; responseJwe: string };
  }

  function createFakeRelay(): FakeBrowserRelay {
    const box = { requestJwe: '', responseJwe: '' };
    const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `${connectServerUrl}/par`) {
        box.requestJwe = (JSON.parse(init!.body as string) as { request: string }).request;
        return new Response(JSON.stringify({ request_uri: requestUri, expires_in: 600 }), { status: 201 });
      }
      if (url.startsWith(`${connectServerUrl}/token/`)) {
        return new Response(box.responseJwe, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };
    return { fetchFn, box };
  }

  it('persists session, preserves storage on state/mode mismatch, scrubs fragment, and completes on return', async () => {
    const storage = createFakeStorage();
    const { fetchFn, box } = createFakeRelay();
    let navigatedTo = '';
    let scrubbed = 0;

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

    const parsedUri = parseWalletConnectUri(navigatedTo)!;
    const request = await ConnectProvider.openRequest({
      jwe        : box.requestJwe,
      decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
    });
    const owner = await DidJwk.create();
    const delegate = await DidJwk.create();
    const responseSecret = generateRedirectResponseSecret();
    box.responseJwe = await ConnectProvider.sealApprovedResponse({
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

    expect(getPendingRedirectConnectType({ storage, href: returnUrl })).toBe('connect');
    expect(getPendingRedirectConnectType({ storage, href: redirectUri })).toBeUndefined();

    // Stray state mismatch or wrong completion helper must NOT clobber the live stored session.
    const wrongStateUrl = buildRedirectReturnUri({ redirectUri, state: 'other-state', responseSecret });
    await expect(completeRedirectConnectFromWindow({
      storage, href: wrongStateUrl, scrubFragment: (): void => {}, fetchFn,
    })).rejects.toThrow('enbox_state');
    expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).not.toBeNull();

    await expect(completeRedirectAuthenticationFromWindow({
      storage, href: returnUrl, scrubFragment: (): void => {}, fetchFn,
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

  it('handles absent params, missing/expired/corrupt storage, and scrubs malformed return fragments', async () => {
    const storage = createFakeStorage();
    let scrubbed = 0;

    expect(await completeRedirectConnectFromWindow({
      storage, href: redirectUri, scrubFragment: (): void => { scrubbed += 1; },
    })).toBeUndefined();
    expect(scrubbed).toBe(0);

    const returnUrl = buildRedirectReturnUri({
      redirectUri,
      state          : 'stale-state',
      responseSecret : generateRedirectResponseSecret(),
    });
    await expect(completeRedirectConnectFromWindow({
      storage, href: returnUrl, scrubFragment: (): void => { scrubbed += 1; },
    })).rejects.toThrow('No pending redirect connect session');
    expect(scrubbed).toBe(1);

    const now = 1_000_000;
    for (const storedRaw of [
      JSON.stringify({
        session: {
          clientDid          : 'did:jwk:a',
          responsePrivateKey : { kty: 'OKP', crv: 'X25519', d: 'a', x: 'b' },
          nonce              : 'n',
          state              : 'stale-state',
          connectServerUrl,
          redirectUri,
          request            : {},
          createdAt          : now - DEFAULT_REDIRECT_SESSION_MAX_AGE_MS - 1,
        },
      }),
      '{not-json',
      JSON.stringify({ session: { state: 'stale-state' } }),
    ]) {
      storage.setItem(PENDING_REDIRECT_STORAGE_KEY, storedRaw);
      expect(getPendingRedirectConnectType({ storage, href: returnUrl, now: (): number => now })).toBeUndefined();
      expect(storage.getItem(PENDING_REDIRECT_STORAGE_KEY)).toBeNull();
    }

    await expect(completeRedirectConnectFromWindow({
      storage, href: `${redirectUri}#enbox_state=abc&enbox_key=AAAA`, scrubFragment: (): void => { scrubbed += 1; },
    })).rejects.toThrow('canonical 32-byte base64url');
    expect(scrubbed).toBe(2);
    expect(getPendingRedirectConnectType({ storage, href: `${redirectUri}#enbox_state=abc&enbox_key=AAAA` })).toBeUndefined();
  });

  it('completes an authentication-only redirect using default sessionStorage and window.history hash scrubbing', async () => {
    const { fetchFn, box } = createFakeRelay();
    let navigatedTo = '';
    const owner = await DidJwk.create();
    const challenge = randomToken();

    await startRedirectConnect({
      connectServerUrl,
      walletUri,
      redirectUri,
      appName             : 'Auth Redirect Browser App',
      requestType         : 'authenticate',
      expectedProviderDid : owner.uri,
      permissionRequests  : [],
      authentication      : { version: 1, audience: new URL(redirectUri).origin, challenge },
      fetchFn,
      navigate            : (url): void => { navigatedTo = url; },
    });

    const parsedUri = parseWalletConnectUri(navigatedTo)!;
    const request = await ConnectProvider.openRequest({
      jwe        : box.requestJwe,
      decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
    });
    const responseSecret = generateRedirectResponseSecret();
    box.responseJwe = await ConnectProvider.sealAuthenticationResponse({
      request,
      providerDid : owner.uri,
      signer      : await DidJwk.create(),
      responseSecret,
      approval    : { authenticationProof: await createOwnerAuthenticationProof({ request, owner }) },
    });

    const returnUrl = buildRedirectReturnUri({ redirectUri, state: request.state, responseSecret });
    expect(await completeRedirectAuthenticationFromWindow({ href: redirectUri })).toBeUndefined();

    window.history.replaceState(window.history.state, '', `${window.location.pathname}${new URL(returnUrl).hash}`);
    expect(getPendingRedirectConnectType({ href: returnUrl })).toBe('authenticate');

    const authResult = await completeRedirectAuthenticationFromWindow({ href: returnUrl, fetchFn });
    expect(window.location.hash).toBe('');
    expect(authResult?.connectedDid).toBe(owner.uri);
    expect(authResult?.authentication.challenge).toBe(challenge);
  });
});
