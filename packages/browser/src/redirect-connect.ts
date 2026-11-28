/**
 * Browser session helpers for the same-device hybrid redirect connect flow.
 *
 * Persists the ephemeral {@link PendingRedirectConnectSession} in
 * `sessionStorage` across the same-tab navigation to the wallet, detects iOS
 * standalone PWA contexts (where web-to-web redirects can trap users in an
 * isolated `SFSafariViewController`), scrubs `#enbox_state` / `#enbox_key`
 * from `window.location` immediately on return, and completes the handshake
 * via `@enbox/connect`'s {@link completeRedirectConnect}.
 *
 * @module
 */

import type { ConnectAuthenticationResolver, ConnectResult, PendingRedirectConnectSession, PrepareRedirectConnectParams } from '@enbox/connect';

import {
  completeRedirectAuthentication,
  completeRedirectConnect,
  parseRedirectReturnUri,
  prepareRedirectConnectRequest,
} from '@enbox/connect';

import { collectBrowserClientMetadata } from './dweb-connect-client.js';

/** `sessionStorage` key holding the ephemeral pending redirect session. */
export const PENDING_REDIRECT_STORAGE_KEY = 'enbox:connect:pendingRedirect';

/** Maximum age (10 minutes) of a stored pending redirect session. */
export const PENDING_REDIRECT_MAX_AGE_MS = 10 * 60 * 1_000;

/** Minimal storage seam for tests and environments with restricted storage. */
export type RedirectSessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Options for {@link startRedirectConnect}. */
export type StartRedirectConnectOptions = Omit<PrepareRedirectConnectParams, 'clientMetadata'> & {
  /** Override `sessionStorage` (defaults to `globalThis.sessionStorage`). */
  storage?: RedirectSessionStorage;

  /** Navigation callback (defaults to `window.location.assign(url)`). */
  navigate?: (url: string) => void;
};

/** Options for {@link completeRedirectConnectFromWindow}. */
export type CompleteRedirectConnectOptions = {
  /** Override `sessionStorage` (defaults to `globalThis.sessionStorage`). */
  storage?: RedirectSessionStorage;

  /** Override `window.location.href` (tests). */
  href?: string;

  /** Override history fragment scrubbing (defaults to `window.history.replaceState`). */
  scrubFragment?: () => void;

  /** Fetch implementation override. */
  fetchFn?: PrepareRedirectConnectParams['fetchFn'];

  /** DID resolver used to verify an owner authentication proof. */
  authenticationResolver?: ConnectAuthenticationResolver;

  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs?: number;

  /** Clock override returning epoch milliseconds. */
  now?: () => number;

  /** Sleep override used between short relay-propagation retries. */
  sleepFn?: (ms: number) => Promise<void>;
};

/**
 * Returns `true` when running inside an iOS standalone Home Screen PWA.
 *
 * On iOS standalone PWAs, navigating to a cross-origin web wallet opens an
 * isolated `SFSafariViewController` whose `sessionStorage` and cookies are
 * partitioned from the Home Screen app — trapping same-device web-to-web
 * redirects. Callers should keep iOS standalone PWAs on the cross-context
 * relay (SAS) path instead.
 */
export function isIosStandalonePwa(
  nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & { standalone?: boolean } | undefined =
  typeof navigator === 'undefined' ? undefined : navigator as Navigator & { standalone?: boolean },
  win: Pick<Window, 'matchMedia'> | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  if (nav === undefined) {
    return false;
  }
  if (nav.standalone === true) {
    return true;
  }
  const ua = nav.userAgent ?? '';
  const isIosDevice = /iPad|iPhone|iPod/i.test(ua)
    || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  if (!isIosDevice) {
    return false;
  }
  return win?.matchMedia?.('(display-mode: standalone)').matches === true;
}

function defaultSessionStorage(): RedirectSessionStorage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function defaultScrubFragment(): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') {
    return;
  }
  const cleanUrl = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, '', cleanUrl);
}

function readPendingSession(
  storage: RedirectSessionStorage | undefined,
  nowMs: number,
): PendingRedirectConnectSession | undefined {
  if (storage === undefined) {
    return undefined;
  }
  try {
    const raw = storage.getItem(PENDING_REDIRECT_STORAGE_KEY);
    if (raw === null) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<PendingRedirectConnectSession>;
    if (
      typeof parsed !== 'object'
      || parsed === null
      || typeof parsed.state !== 'string'
      || typeof parsed.nonce !== 'string'
      || typeof parsed.clientDid !== 'string'
      || typeof parsed.connectServerUrl !== 'string'
      || typeof parsed.redirectUri !== 'string'
      || typeof parsed.createdAt !== 'number'
      || parsed.responsePrivateKey === undefined
      || parsed.request === undefined
    ) {
      storage.removeItem(PENDING_REDIRECT_STORAGE_KEY);
      return undefined;
    }
    if (nowMs - parsed.createdAt > PENDING_REDIRECT_MAX_AGE_MS || parsed.createdAt > nowMs + 60_000) {
      storage.removeItem(PENDING_REDIRECT_STORAGE_KEY);
      return undefined;
    }
    return parsed as PendingRedirectConnectSession;
  } catch {
    try { storage.removeItem(PENDING_REDIRECT_STORAGE_KEY); } catch { /* best effort */ }
    return undefined;
  }
}

/**
 * Starts a same-device hybrid redirect connect flow:
 * 1. Prepares and pushes the `reply.mode = 'redirect'` PAR request (never
 *    polling `/connect/token/{state}.jwt` while away).
 * 2. Persists the ephemeral `pendingSession` in `sessionStorage`.
 * 3. Navigates the current tab to `walletUri`.
 */
export async function startRedirectConnect(
  options: StartRedirectConnectOptions,
): Promise<PendingRedirectConnectSession> {
  const storage = options.storage ?? defaultSessionStorage();
  if (storage === undefined) {
    throw new Error('[@enbox/browser] Redirect connect requires `sessionStorage` to persist ephemeral handshake keys across navigation.');
  }

  const prepared = await prepareRedirectConnectRequest({
    ...options,
    clientMetadata: collectBrowserClientMetadata(),
  });

  storage.setItem(PENDING_REDIRECT_STORAGE_KEY, JSON.stringify(prepared.pendingSession));

  const navigate = options.navigate ?? ((url: string): void => { window.location.assign(url); });
  navigate(prepared.walletUri);

  return prepared.pendingSession;
}

/**
 * Returns `true` when the current URL carries an Enbox redirect return
 * fragment (`#enbox_state=...`) AND a non-expired pending redirect session
 * is stored in `sessionStorage`.
 */
export function hasPendingRedirectConnect(options: {
  storage?: RedirectSessionStorage;
  href?: string;
  now?: () => number;
} = {}): boolean {
  const href = options.href ?? (typeof window === 'undefined' ? undefined : window.location.href);
  if (href === undefined) {
    return false;
  }
  let parsed;
  try {
    parsed = parseRedirectReturnUri(href);
  } catch {
    return false;
  }
  if (parsed === undefined) {
    return false;
  }

  const storage = options.storage ?? defaultSessionStorage();
  const pending = readPendingSession(storage, (options.now ?? ((): number => Date.now()))());
  return pending !== undefined && pending.state === parsed.state;
}

function consumeRedirectReturn(options: CompleteRedirectConnectOptions): {
  href: string;
  pendingSession: PendingRedirectConnectSession;
} | undefined {
  const href = options.href ?? (typeof window === 'undefined' ? undefined : window.location.href);
  if (href === undefined) {
    return undefined;
  }

  let parsed;
  try {
    parsed = parseRedirectReturnUri(href);
  } catch (error) {
    (options.scrubFragment ?? defaultScrubFragment)();
    throw error;
  }
  if (parsed === undefined) {
    return undefined;
  }

  (options.scrubFragment ?? defaultScrubFragment)();

  const storage = options.storage ?? defaultSessionStorage();
  const pendingSession = readPendingSession(storage, (options.now ?? ((): number => Date.now()))());
  try {
    storage?.removeItem(PENDING_REDIRECT_STORAGE_KEY);
  } catch { /* best effort */ }

  if (pendingSession === undefined) {
    throw new Error('[@enbox/browser] No pending redirect connect session was found (it may have expired or been started in another tab).');
  }

  return { href, pendingSession };
}

/**
 * Completes a pending same-device redirect connect flow on return from the
 * wallet: immediately scrubs the sensitive `#enbox_key` fragment from the URL
 * and browser history, removes the stored `pendingSession`, fetches the
 * single-use relay ciphertext once, and decrypts it with both the stored
 * X25519 private key and `#enbox_key`.
 *
 * Returns `undefined` when no Enbox redirect return parameters are present on
 * the URL OR when the user denied the request.
 */
export async function completeRedirectConnectFromWindow(
  options: CompleteRedirectConnectOptions = {},
): Promise<ConnectResult | undefined> {
  const consumed = consumeRedirectReturn(options);
  if (consumed === undefined) {
    return undefined;
  }

  return await completeRedirectConnect({
    pendingSession         : consumed.pendingSession,
    returnUrl              : consumed.href,
    fetchFn                : options.fetchFn,
    authenticationResolver : options.authenticationResolver,
    timeoutMs              : options.timeoutMs,
    sleepFn                : options.sleepFn,
  });
}

/**
 * Completes a pending authentication-only redirect flow on return from the wallet.
 */
export async function completeRedirectAuthenticationFromWindow(
  options: CompleteRedirectConnectOptions = {},
): Promise<Awaited<ReturnType<typeof completeRedirectAuthentication>>> {
  const consumed = consumeRedirectReturn(options);
  if (consumed === undefined) {
    return undefined;
  }

  return await completeRedirectAuthentication({
    pendingSession         : consumed.pendingSession,
    returnUrl              : consumed.href,
    fetchFn                : options.fetchFn,
    authenticationResolver : options.authenticationResolver,
    timeoutMs              : options.timeoutMs,
    sleepFn                : options.sleepFn,
  });
}
