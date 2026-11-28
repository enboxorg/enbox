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

import type {
  CompleteRedirectOptions,
  ConnectRequestType,
  ConnectResult,
  PendingRedirectConnectSession,
  PrepareRedirectConnectParams,
} from '@enbox/connect';

import {
  assertPendingRedirectSessionMode,
  completeRedirectAuthentication,
  completeRedirectConnect,
  isPendingRedirectSessionExpired,
  parseRedirectReturnUri,
  prepareRedirectConnectRequest,
} from '@enbox/connect';

import { collectBrowserClientMetadata } from './dweb-connect-client.js';

/** `sessionStorage` key holding the ephemeral pending redirect session. */
export const PENDING_REDIRECT_STORAGE_KEY = 'enbox:connect:pendingRedirect';

/** Probe key used to verify `sessionStorage` is writable. */
const SESSION_STORAGE_PROBE_KEY = 'enbox:connect:storageProbe';

/** Minimal storage seam for tests and environments with restricted storage. */
export type RedirectSessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Stored browser envelope pairing the ephemeral kernel session with UI metadata. */
type StoredRedirectSession = {
  session: PendingRedirectConnectSession;
  walletUrl?: string;
};

/** Options for {@link startRedirectConnect}. */
export type StartRedirectConnectOptions = Omit<PrepareRedirectConnectParams, 'clientMetadata'> & {
  /** Base wallet URL remembered by the connect modal after redirect return. */
  walletUrl?: string;

  /** Override `sessionStorage` (defaults to `globalThis.sessionStorage`). */
  storage?: RedirectSessionStorage;

  /** Navigation callback (defaults to `window.location.assign(url)`). */
  navigate?: (url: string) => void;
};

/** Options for {@link completeRedirectConnectFromWindow} and {@link completeRedirectAuthenticationFromWindow}. */
export type CompleteRedirectConnectOptions = Omit<CompleteRedirectOptions, 'pendingSession' | 'returnUrl'> & {
  /** Override `sessionStorage` (defaults to `globalThis.sessionStorage`). */
  storage?: RedirectSessionStorage;

  /** Override `window.location.href` (tests). */
  href?: string;

  /** Override history fragment scrubbing (defaults to `window.history.replaceState`). */
  scrubFragment?: () => void;
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
  const isIpadDesktopUa = (nav.platform === 'MacIntel' || /Macintosh/i.test(ua))
    && (nav.maxTouchPoints ?? 0) > 1;
  if (!(/iPad|iPhone|iPod/i.test(ua) || isIpadDesktopUa)) {
    return false;
  }
  return win?.matchMedia?.('(display-mode: standalone)').matches === true
    || win?.matchMedia?.('(display-mode: fullscreen)').matches === true;
}

function defaultSessionStorage(): RedirectSessionStorage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Probes whether `sessionStorage` (or an injected storage seam) is readable
 * and writable — restricted embedded WebViews and private contexts may expose
 * `sessionStorage` but throw `SecurityError`/`QuotaExceededError` on write.
 */
export function isSessionStorageAvailable(
  storage: RedirectSessionStorage | null = defaultSessionStorage() ?? null,
): boolean {
  if (storage === null) {
    return false;
  }
  try {
    storage.setItem(SESSION_STORAGE_PROBE_KEY, '1');
    storage.removeItem(SESSION_STORAGE_PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

function defaultScrubFragment(): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') {
    return;
  }
  try {
    const cleanUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(window.history.state, '', cleanUrl);
  } catch {
    // Some restricted sandboxes (e.g. opaque origins) forbid replaceState.
  }
}

function isValidPendingSessionShape(value: unknown): value is PendingRedirectConnectSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const parsed = value as Partial<PendingRedirectConnectSession>;
  return typeof parsed.state === 'string'
    && typeof parsed.nonce === 'string'
    && typeof parsed.clientDid === 'string'
    && typeof parsed.connectServerUrl === 'string'
    && typeof parsed.redirectUri === 'string'
    && typeof parsed.createdAt === 'number'
    && Number.isFinite(parsed.createdAt)
    && typeof parsed.responsePrivateKey === 'object'
    && parsed.responsePrivateKey !== null
    && typeof parsed.request === 'object'
    && parsed.request !== null;
}

function readStoredSession(
  storage: RedirectSessionStorage | undefined,
  nowMs: number,
  maxSessionAgeMs?: number,
): StoredRedirectSession | undefined {
  if (storage === undefined) {
    return undefined;
  }
  try {
    const raw = storage.getItem(PENDING_REDIRECT_STORAGE_KEY);
    if (raw === null) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { session?: unknown; walletUrl?: unknown } | null;
    const session = typeof parsed === 'object' && parsed !== null ? parsed.session : undefined;
    if (!isValidPendingSessionShape(session) || isPendingRedirectSessionExpired(session, nowMs, maxSessionAgeMs)) {
      storage.removeItem(PENDING_REDIRECT_STORAGE_KEY);
      return undefined;
    }
    const walletUrl = typeof parsed?.walletUrl === 'string' ? parsed.walletUrl : undefined;
    return { session, walletUrl };
  } catch {
    try { storage.removeItem(PENDING_REDIRECT_STORAGE_KEY); } catch { /* best effort */ }
    return undefined;
  }
}

/**
 * Starts a same-device hybrid redirect connect flow:
 * 1. Prepares and pushes the `reply.mode = 'redirect'` PAR request (never
 *    polling `/connect/token/{state}.jwt` while away).
 * 2. Persists the ephemeral `pendingSession` (without long-lived delegate
 *    private keys) in `sessionStorage`.
 * 3. Navigates the current tab to `walletUri`.
 */
export async function startRedirectConnect(
  options: StartRedirectConnectOptions,
): Promise<PendingRedirectConnectSession> {
  const storage = options.storage ?? defaultSessionStorage();
  if (storage === undefined) {
    throw new Error('[@enbox/browser] Redirect connect requires `sessionStorage` to persist ephemeral handshake keys across navigation.');
  }

  options.signal?.throwIfAborted();

  const prepared = await prepareRedirectConnectRequest({
    ...options,
    clientMetadata: collectBrowserClientMetadata(),
  });

  options.signal?.throwIfAborted();

  const stored: StoredRedirectSession = {
    session: prepared.pendingSession,
    ...(options.walletUrl === undefined ? {} : { walletUrl: options.walletUrl }),
  };
  storage.setItem(PENDING_REDIRECT_STORAGE_KEY, JSON.stringify(stored));

  const navigate = options.navigate ?? ((url: string): void => { window.location.assign(url); });
  navigate(prepared.walletUri);

  return prepared.pendingSession;
}

/**
 * Returns the pending redirect flow type (`'connect'`, `'refresh'`, or
 * `'authenticate'`) when the current URL carries an Enbox redirect return
 * fragment (`#enbox_state=...`) matching a live pending session in
 * `sessionStorage`, or `undefined` otherwise.
 *
 * Apps can branch on this on page load to call `auth.connect()`,
 * `auth.restoreSession()` + `auth.refresh()`, or
 * {@link completeRedirectAuthenticationFromWindow}.
 */
export function getPendingRedirectConnectType(options: {
  storage?: RedirectSessionStorage;
  href?: string;
  now?: () => number;
} = {}): ConnectRequestType | undefined {
  const href = options.href ?? (typeof window === 'undefined' ? undefined : window.location.href);
  if (href === undefined) {
    return undefined;
  }
  let parsed;
  try {
    parsed = parseRedirectReturnUri(href);
  } catch {
    return undefined;
  }
  if (parsed === undefined) {
    return undefined;
  }

  const storage = options.storage ?? defaultSessionStorage();
  const stored = readStoredSession(storage, (options.now ?? ((): number => Date.now()))());
  if (stored === undefined || stored.session.state !== parsed.state) {
    return undefined;
  }
  return stored.session.request.requestType ?? 'connect';
}

function consumeRedirectReturn(
  options: CompleteRedirectConnectOptions,
  expectedMode: 'connect' | 'authenticate',
): {
  href: string;
  stored: StoredRedirectSession;
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
  const nowMs = (options.now ?? ((): number => Date.now()))();
  const stored = readStoredSession(storage, nowMs, options.maxSessionAgeMs);
  if (stored === undefined) {
    throw new Error('[@enbox/browser] No pending redirect connect session was found (it may have expired or been started in another tab).');
  }

  // Validate state and flow type BEFORE deleting the stored session so a
  // stray/mismatched return URL or wrong completion helper cannot clobber a
  // live pending redirect session.
  if (stored.session.state !== parsed.state) {
    throw new Error('Connect: redirect return `enbox_state` does not match the pending session.');
  }
  assertPendingRedirectSessionMode(stored.session, expectedMode);

  try {
    storage?.removeItem(PENDING_REDIRECT_STORAGE_KEY);
  } catch { /* best effort */ }

  return { href, stored };
}

/**
 * Internal helper used by {@link BrowserConnectHandler} to complete a redirect
 * return and also retrieve the remembered wallet URL metadata.
 */
export async function completeRedirectConnectFromWindowWithMeta(
  options: CompleteRedirectConnectOptions = {},
): Promise<{ result: ConnectResult | undefined; walletUrl?: string } | undefined> {
  const consumed = consumeRedirectReturn(options, 'connect');
  if (consumed === undefined) {
    return undefined;
  }

  const { storage: _storage, href: _href, scrubFragment: _scrub, ...completeOptions } = options;
  const result = await completeRedirectConnect({
    ...completeOptions,
    pendingSession : consumed.stored.session,
    returnUrl      : consumed.href,
  });

  return { result, walletUrl: consumed.stored.walletUrl };
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
  const completed = await completeRedirectConnectFromWindowWithMeta(options);
  return completed?.result;
}

/**
 * Completes a pending authentication-only redirect flow on return from the wallet.
 */
export async function completeRedirectAuthenticationFromWindow(
  options: Omit<CompleteRedirectConnectOptions, 'localDelegatePortableDid'> = {},
): Promise<Awaited<ReturnType<typeof completeRedirectAuthentication>>> {
  const consumed = consumeRedirectReturn(options, 'authenticate');
  if (consumed === undefined) {
    return undefined;
  }

  const { storage: _storage, href: _href, scrubFragment: _scrub, ...completeOptions } = options;
  return await completeRedirectAuthentication({
    ...completeOptions,
    pendingSession : consumed.stored.session,
    returnUrl      : consumed.href,
  });
}
