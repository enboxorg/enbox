/**
 * Same-device hybrid redirect channel for Enbox Connect.
 *
 * Designed for mobile web browsers where `window.open` / `window.opener`
 * communication is unreliable or stripped across OS navigations:
 *
 * 1. The app calls {@link prepareRedirectConnectRequest}: mints ephemeral
 *    `clientDid` + `responseKeyPair`, builds a `ConnectRequest` with
 *    `reply: { mode: 'redirect', callbackUrl, redirectUri }`, seals it with a
 *    32-byte fragment `requestKey`, pushes it to `POST /connect/par`, and
 *    persists the returned `pendingSession` across the same-tab navigation.
 *    The app **never** polls `/connect/token/{state}.jwt` while away (avoids
 *    racing and deleting the single-use relay response before returning).
 * 2. The wallet validates `redirectUri` (HTTPS or localhost, NO query string,
 *    NO credentials/fragment), rejects pre-supplied `delegateDid` on brand-new
 *    requests, optionally verifies `redirectUri` against the app origin's
 *    `/.well-known/enbox-app` manifest (`redirect: 'error'`), runs approval,
 *    generates a fresh 256-bit `responseSecret`, seals the response JWE with
 *    `responseSecret`, POSTs it to `callbackUrl`, and navigates to
 *    `redirectUri#enbox_state=<state>&enbox_key=<base64url(responseSecret)>`.
 * 3. Back on the app, {@link completeRedirectConnect} (or
 *    {@link completeRedirectAuthentication}) parses `#fragment`, checks
 *    `enbox_state === pendingSession.state`, fetches the single-use ciphertext
 *    from `/connect/token/{state}.jwt` once, and decrypts it with BOTH
 *    `responsePrivateKey` AND `enbox_key`.
 *
 * @module
 */

import type { ConnectAuthenticationResolver } from './owner-authentication.js';
import type { ConnectClientConnectParams } from './client.js';
import type { FetchFn } from './relay-transport.js';
import type { Jwk } from '@enbox/crypto';
import type { PortableDid } from '@enbox/dids';
import type {
  ConnectAuthenticationResult,
  ConnectRequest,
  ConnectRequestType,
  ConnectResult,
  WalletUriHandoff,
} from './types.js';

import { concatenateUrl, Convert, sleep } from '@enbox/common';
import { CryptoUtils, isCanonicalBase64Url32 } from '@enbox/crypto';

import { CONNECT_DENIED_TOKEN } from './types.js';
import { ConnectAuthenticationError } from './owner-authentication.js';
import {
  assertResponseSecret,
  assertValidRedirectUri,
  isSafeConnectOrigin,
  openAuthenticationResponse,
  openResponse,
  RESPONSE_SECRET_BYTE_LENGTH,
} from './envelope.js';
import {
  createAndSealConnectRequest,
  resolveDelegatePortableDid,
  verifyResponseAuthentication,
} from './client.js';
import {
  defaultFetch,
  postRelayComplete,
  pushParRequest,
  RELAY_HTTP_TIMEOUT_MS,
} from './relay-transport.js';

/** Well-known path an app origin can publish to allowlist its exact `redirectUri` values. */
export const APP_MANIFEST_WELL_KNOWN_PATH = '/.well-known/enbox-app';

/** Default maximum age (10 minutes) of a pending redirect session before completion rejects it. */
export const DEFAULT_REDIRECT_SESSION_MAX_AGE_MS = 10 * 60 * 1_000;

const REDIRECT_RETURN_STATE_PARAM = 'enbox_state';
const REDIRECT_RETURN_KEY_PARAM = 'enbox_key';
const REDIRECT_RETURN_ERROR_PARAM = 'enbox_error';
const PENDING_SESSION_FUTURE_SKEW_MS = 60_000;
const APP_MANIFEST_TIMEOUT_MS = 5_000;
const MAX_APP_MANIFEST_BYTES = 65_536;
const MAX_APP_MANIFEST_REDIRECT_URIS = 32;
const RETRYABLE_TOKEN_HTTP_STATUSES = new Set([204, 404, 429, 502, 503, 504]);

/** Parsed return payload extracted strictly from a redirect return URL's `#fragment`. */
export type RedirectReturnPayload =
  | { state: string; responseSecret: Uint8Array; error?: undefined }
  | { state: string; error: 'denied'; responseSecret?: undefined };

/** Verified subset of `https://<origin>/.well-known/enbox-app`. */
export type ConnectAppManifest = Readonly<{
  redirectUris: readonly string[];
}>;

/**
 * Serializable pending state held by the requesting app (e.g. in
 * `sessionStorage`) across the same-tab wallet redirect.
 *
 * Intentionally carries ONLY ephemeral per-handshake state (never long-lived
 * `delegatePortableDid` private keys); for `refresh` flows, the caller
 * re-supplies its local `delegatePortableDid` from the vault on return.
 */
export type PendingRedirectConnectSession = {
  /** Ephemeral client DID URI (`did:jwk`) used to sign the request. */
  clientDid: string;

  /** Ephemeral X25519 private key paired with `request.responseKey`. */
  responsePrivateKey: Jwk;

  /** Anti-replay nonce echoed by the wallet response. */
  nonce: string;

  /** State correlator matching `enbox_state` and the relay token route. */
  state: string;

  /** Relay base URL where the single-use response token is retrieved on return. */
  connectServerUrl: string;

  /** Exact return URL embedded in `request.reply.redirectUri`. */
  redirectUri: string;

  /** Original validated request (retained for owner-authentication digest verification). */
  request: ConnectRequest;

  /** Optional expected provider DID enforced on response open. */
  expectedProviderDid?: string;

  /** Unix epoch milliseconds when this pending redirect session was created. */
  createdAt: number;
};

/** Parameters for {@link prepareRedirectConnectRequest}. */
export type PrepareRedirectConnectParams = Omit<ConnectClientConnectParams, 'delegatePortableDid' | 'requestType'> & {
  /** Base URL of the relay's connect routes (e.g. `https://dwn.example/connect`). */
  connectServerUrl: string;

  /** Wallet app URI (e.g. `https://wallet.example/connect/app`). */
  walletUri: string;

  /** Exact URL the wallet redirects back to with `#enbox_state=...&enbox_key=...`. */
  redirectUri: string;

  /** Existing delegate DID URI (allowed ONLY when `requestType === 'refresh'`). */
  delegateDid?: string;

  /** User-facing request purpose (`'connect' | 'refresh' | 'authenticate'`). */
  requestType?: ConnectRequestType;

  /** Durable registration hook for authentication-bearing requests (runs before PAR push). */
  onAuthenticationRequest?: (request: Readonly<ConnectRequest>) => Promise<void> | void;

  /** Injectable fetch implementation. */
  fetchFn?: FetchFn;

  /** Optional abort signal to cancel the PAR preparation before navigation. */
  signal?: AbortSignal;

  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs?: number;

  /** Clock override returning epoch milliseconds. */
  now?: () => number;
};

/** Output of {@link prepareRedirectConnectRequest}. */
export type PreparedRedirectConnect = WalletUriHandoff & {
  /** Pending session state to persist across the navigation and pass to {@link completeRedirectConnect}. */
  pendingSession: PendingRedirectConnectSession;
};

/** Shared options for {@link completeRedirectConnect} and {@link completeRedirectAuthentication}. */
export type CompleteRedirectOptions = {
  /** Pending session persisted before navigating to the wallet. */
  pendingSession: PendingRedirectConnectSession;
  /** Full return URL carrying `#enbox_state=...&enbox_key=...` (or `#enbox_error=denied`). */
  returnUrl: string;
  /** Local delegate credentials re-supplied from the vault when completing a `refresh` redirect. */
  localDelegatePortableDid?: PortableDid;
  /** Optional provider DID guard (must agree with `pendingSession.expectedProviderDid` if both are set). */
  expectedProviderDid?: string;
  /** Injectable fetch implementation. */
  fetchFn?: FetchFn;
  /** DID resolver used to verify an owner authentication proof. */
  authenticationResolver?: ConnectAuthenticationResolver;
  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum session lifetime in milliseconds; defaults to {@link DEFAULT_REDIRECT_SESSION_MAX_AGE_MS}. */
  maxSessionAgeMs?: number;
  /** Clock override returning epoch milliseconds. */
  now?: () => number;
  /** Sleep override used between short relay-propagation retries. */
  sleepFn?: (ms: number) => Promise<void>;
};

/** Returns whether `session.createdAt` is outside the allowed age or clock-skew window. */
export function isPendingRedirectSessionExpired(
  session: Pick<PendingRedirectConnectSession, 'createdAt'>,
  nowMs: number = Date.now(),
  maxSessionAgeMs: number = DEFAULT_REDIRECT_SESSION_MAX_AGE_MS,
): boolean {
  return !Number.isFinite(session.createdAt)
    || nowMs - session.createdAt > maxSessionAgeMs
    || session.createdAt > nowMs + PENDING_SESSION_FUTURE_SKEW_MS;
}

/** Ensures `session` matches the requested completion mode (`'connect'` vs `'authenticate'`). */
export function assertPendingRedirectSessionMode(
  session: Pick<PendingRedirectConnectSession, 'request'>,
  expectedMode: 'connect' | 'authenticate',
): void {
  const isAuth = session.request.requestType === 'authenticate';
  if (expectedMode === 'connect' && isAuth) {
    throw new Error('Connect: use completeRedirectAuthentication() for an authentication-only redirect session.');
  }
  if (expectedMode === 'authenticate' && (!isAuth || session.request.authentication === undefined)) {
    throw new ConnectAuthenticationError('invalid-request');
  }
}

/** Generates a fresh 256-bit (32-byte) high-entropy redirect response secret. */
export function generateRedirectResponseSecret(): Uint8Array {
  return CryptoUtils.randomBytes(RESPONSE_SECRET_BYTE_LENGTH);
}

/**
 * Builds the wallet-to-app return URI by attaching `#enbox_state=...&enbox_key=...`
 * (or `#enbox_state=...&enbox_error=denied`) strictly in the URL fragment so the
 * 256-bit response secret never leaves the device over HTTP.
 */
export function buildRedirectReturnUri(
  params:
    | { redirectUri: string; state: string; responseSecret: Uint8Array; error?: undefined }
    | { redirectUri: string; state: string; error: 'denied'; responseSecret?: undefined },
): string {
  assertValidRedirectUri(params.redirectUri, 'invalid redirect return URI');
  if (typeof params.state !== 'string' || params.state.length === 0) {
    throw new Error('Connect: redirect return `state` must be a non-empty string.');
  }

  const fragment = new URLSearchParams();
  fragment.set(REDIRECT_RETURN_STATE_PARAM, params.state);

  if (params.error === 'denied') {
    fragment.set(REDIRECT_RETURN_ERROR_PARAM, 'denied');
  } else {
    assertResponseSecret(params.responseSecret);
    fragment.set(REDIRECT_RETURN_KEY_PARAM, Convert.uint8Array(params.responseSecret).toBase64Url());
  }

  return `${params.redirectUri}#${fragment.toString()}`;
}

/** Decodes and validates a canonical non-zero 32-byte base64url `enbox_key` fragment secret. */
function decodeRedirectResponseSecret(encodedKey: string): Uint8Array {
  if (!isCanonicalBase64Url32(encodedKey)) {
    throw new Error(`Connect: redirect return \`enbox_key\` must be canonical ${RESPONSE_SECRET_BYTE_LENGTH}-byte base64url.`);
  }
  const responseSecret = Convert.base64Url(encodedKey).toUint8Array();
  if (CryptoUtils.isAllZeroBytes(responseSecret)) {
    throw new Error('Connect: redirect return `enbox_key` must not be all zeros.');
  }
  return responseSecret;
}

/**
 * Parses a redirect return payload strictly from `url`'s `#fragment`.
 *
 * Returns `undefined` when `url` carries no Enbox redirect return parameters
 * (so apps can call this unconditionally on load). Throws when Enbox return
 * parameters are present but malformed or incomplete. Query-string parameters
 * are deliberately ignored so a secret cannot be accepted over HTTP.
 */
export function parseRedirectReturnUri(url: string): RedirectReturnPayload | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const rawHash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : '';
  if (rawHash.length === 0) {
    return undefined;
  }

  const params = new URLSearchParams(rawHash);
  const states = params.getAll(REDIRECT_RETURN_STATE_PARAM);
  const keys = params.getAll(REDIRECT_RETURN_KEY_PARAM);
  const errors = params.getAll(REDIRECT_RETURN_ERROR_PARAM);

  if (states.length === 0 && keys.length === 0 && errors.length === 0) {
    return undefined;
  }
  if (states.length > 1 || keys.length > 1 || errors.length > 1) {
    throw new Error('Connect: redirect return fragment must not contain duplicate Enbox parameters.');
  }

  const state = states[0] ?? null;
  const encodedKey = keys[0] ?? null;
  const error = errors[0] ?? null;

  if (state === null || state.length === 0) {
    throw new Error('Connect: redirect return fragment is missing `enbox_state`.');
  }
  if (encodedKey !== null && error !== null) {
    throw new Error('Connect: redirect return fragment cannot carry both `enbox_key` and `enbox_error`.');
  }

  if (error !== null) {
    if (error !== 'denied') {
      throw new Error(`Connect: unsupported redirect return error '${error}'.`);
    }
    return { state, error: 'denied' };
  }

  if (encodedKey === null || encodedKey.length === 0) {
    throw new Error('Connect: redirect return fragment is missing `enbox_key`.');
  }

  return { state, responseSecret: decodeRedirectResponseSecret(encodedKey) };
}

/** Reads a response body as UTF-8 text while enforcing a strict byte ceiling before decoding. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const rawLength = response.headers.get('content-length');
  if (rawLength !== null && Number.isFinite(Number(rawLength)) && Number(rawLength) > maxBytes) {
    await response.body?.cancel().catch((): void => {});
    return undefined;
  }

  if (response.body === null) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); // NOSONAR: S9382 — stream chunks must be read sequentially to enforce byte ceiling
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch((): void => {});
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** Parses and filters a validated `/.well-known/enbox-app` JSON payload for `expectedOrigin`. */
function parseConnectAppManifestText(text: string, expectedOrigin: string): ConnectAppManifest | undefined {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || !Object.hasOwn(parsed, 'redirectUris')) {
    return undefined;
  }
  const redirectUris = (parsed as { redirectUris?: unknown }).redirectUris;
  if (!Array.isArray(redirectUris) || redirectUris.length > MAX_APP_MANIFEST_REDIRECT_URIS) {
    return undefined;
  }

  const verifiedUris: string[] = [];
  for (const candidate of redirectUris) {
    if (typeof candidate !== 'string') {
      continue;
    }
    try {
      assertValidRedirectUri(candidate);
      if (new URL(candidate).origin === expectedOrigin) {
        verifiedUris.push(candidate);
      }
    } catch {
      // Ignore invalid or cross-origin redirect URI entries.
    }
  }

  return Object.freeze({ redirectUris: Object.freeze(verifiedUris) });
}

/**
 * Fetches and validates an app origin's optional `/.well-known/enbox-app`
 * manifest (`redirect: 'error'`, no redirects followed).
 *
 * Only `redirectUris` entries that pass {@link assertValidRedirectUri} AND
 * share the exact queried `origin` are accepted. Returns `undefined` when the
 * manifest is absent, unreachable, redirected, oversized, or invalid.
 */
export async function fetchConnectAppManifest(
  origin: string,
  options: { fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<ConnectAppManifest | undefined> {
  if (!isSafeConnectOrigin(origin)) {
    return undefined;
  }

  const doFetch = options.fetchFn ?? defaultFetch;
  try {
    const response = await doFetch(`${origin}${APP_MANIFEST_WELL_KNOWN_PATH}`, {
      method   : 'GET',
      redirect : 'error',
      signal   : AbortSignal.timeout(options.timeoutMs ?? APP_MANIFEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch((): void => {});
      return undefined;
    }

    const text = await readBoundedText(response, MAX_APP_MANIFEST_BYTES);
    return text === undefined ? undefined : parseConnectAppManifestText(text, origin);
  } catch {
    return undefined;
  }
}

/**
 * Returns `true` iff `redirectUri` is explicitly allowlisted (exact match, same
 * origin) by `manifest` fetched from `new URL(redirectUri).origin`.
 */
export function isRedirectUriVerifiedInManifest(
  redirectUri: string,
  manifest: ConnectAppManifest | undefined,
): boolean {
  return manifest !== undefined && manifest.redirectUris.includes(redirectUri);
}

/**
 * Phase 1 of same-device hybrid redirect connect: creates ephemeral handshake
 * keys, validates and seals the `reply.mode = 'redirect'` request, pushes it
 * via `POST /connect/par`, and returns the `walletUri` + serializable
 * `pendingSession`. Does NOT start polling `/connect/token/{state}.jwt`.
 */
export async function prepareRedirectConnectRequest(
  input: PrepareRedirectConnectParams,
): Promise<PreparedRedirectConnect> {
  const params = {
    ...input,
    permissionRequests  : structuredClone(input.permissionRequests),
    clientMetadata      : structuredClone(input.clientMetadata),
    authentication      : structuredClone(input.authentication),
    supportedDidMethods : input.supportedDidMethods === undefined ? undefined : [...input.supportedDidMethods],
  };

  assertValidRedirectUri(params.redirectUri);

  const requestKey = CryptoUtils.randomBytes(32);
  const callbackUrl = concatenateUrl(params.connectServerUrl, 'callback');
  const sealed = await createAndSealConnectRequest({
    params,
    resolveProfile: (): { encryption: { mode: 'dir'; requestKey: Uint8Array }; reply: ConnectRequest['reply'] } => ({
      encryption : { mode: 'dir', requestKey },
      reply      : { mode: 'redirect', callbackUrl, redirectUri: params.redirectUri },
    }),
    onAuthenticationRequest : params.onAuthenticationRequest,
    signal                  : params.signal,
  });

  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? RELAY_HTTP_TIMEOUT_MS);
  const requestSignal = params.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([params.signal, timeoutSignal]);

  const handoff = await pushParRequest({
    connectServerUrl : params.connectServerUrl,
    walletUri        : params.walletUri,
    requestJwe       : sealed.requestJwe,
    requestKey,
    fetchFn          : params.fetchFn,
    signal           : requestSignal,
  });

  const pendingSession: PendingRedirectConnectSession = {
    clientDid           : sealed.clientDid,
    responsePrivateKey  : sealed.responsePrivateKey,
    nonce               : sealed.nonce,
    state               : sealed.state,
    connectServerUrl    : params.connectServerUrl,
    redirectUri         : params.redirectUri,
    request             : sealed.request,
    expectedProviderDid : params.expectedProviderDid,
    createdAt           : (params.now ?? ((): number => Date.now()))(),
  };

  return { ...handoff, pendingSession };
}

async function tryFetchRedirectTokenAttempt(
  tokenUrl: string,
  fetchFn: FetchFn,
  timeoutMs: number,
  isFinalAttempt: boolean,
): Promise<{ token?: string; status?: number }> {
  let response: Response;
  try {
    response = await fetchFn(tokenUrl, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (isFinalAttempt) {
      throw error;
    }
    return {};
  }

  if (response.ok && response.status !== 204) {
    const body = await response.text();
    return body.length > 0 ? { token: body } : { status: response.status };
  }

  await response.body?.cancel().catch((): void => {});
  if (!RETRYABLE_TOKEN_HTTP_STATUSES.has(response.status)) {
    throw new Error(`Connect: redirect token fetch failed with HTTP ${response.status}.`);
  }
  return { status: response.status };
}

/** Fetches the single-use relay token once on redirect return (with tiny transient propagation retry). */
async function fetchRedirectTokenOnce({ connectServerUrl, state, fetchFn, timeoutMs, sleepFn }: {
  connectServerUrl: string;
  state: string;
  fetchFn: FetchFn;
  timeoutMs: number;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<string> {
  const tokenUrl = concatenateUrl(connectServerUrl, `token/${encodeURIComponent(state)}.jwt`);
  const maxAttempts = 3;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isFinalAttempt = attempt + 1 >= maxAttempts;
    const result = await tryFetchRedirectTokenAttempt(tokenUrl, fetchFn, timeoutMs, isFinalAttempt); // NOSONAR: S9382 — sequential retries
    if (result.token !== undefined) {
      return result.token;
    }
    if (result.status !== undefined) {
      lastStatus = result.status;
    }
    if (!isFinalAttempt) {
      await sleepFn(250); // NOSONAR: S9382 — sequential retry backoff
    }
  }

  if (lastStatus !== undefined && lastStatus !== 204 && lastStatus !== 404 && (lastStatus < 200 || lastStatus >= 300)) {
    throw new Error(`Connect: redirect token fetch failed with HTTP ${lastStatus}.`);
  }
  throw new Error('Connect: redirect response was not found on the relay (it may have expired or already been consumed).');
}

/** Validates session freshness, return URL exact match, and `enbox_state` correlation. */
function validateRedirectReturn({
  pendingSession,
  returnUrl,
  maxSessionAgeMs,
  now,
}: Pick<CompleteRedirectOptions, 'pendingSession' | 'returnUrl' | 'maxSessionAgeMs' | 'now'>): RedirectReturnPayload {
  const nowMs = (now ?? ((): number => Date.now()))();
  if (isPendingRedirectSessionExpired(pendingSession, nowMs, maxSessionAgeMs)) {
    throw new Error('Connect: pending redirect session has expired.');
  }

  const parsed = parseRedirectReturnUri(returnUrl);
  if (parsed === undefined) {
    throw new Error('Connect: return URL does not contain Enbox redirect parameters.');
  }

  const preHash = returnUrl.split('#', 1)[0];
  const parsedReturnUrl = new URL(returnUrl);
  const expectedReturnUrl = new URL(pendingSession.redirectUri);
  if (
    parsedReturnUrl.origin !== expectedReturnUrl.origin
    || parsedReturnUrl.pathname !== expectedReturnUrl.pathname
    || preHash.includes('?')
  ) {
    throw new Error('Connect: redirect return URL does not match the requested `redirectUri`.');
  }

  if (parsed.state !== pendingSession.state) {
    throw new Error('Connect: redirect return `enbox_state` does not match the pending session.');
  }

  return parsed;
}

/** Validates caller-provided refresh delegate credentials and expected provider DID agreement. */
function resolveExpectedProviderDid(
  pendingSession: PendingRedirectConnectSession,
  expectedProviderDid: string | undefined,
): string | undefined {
  if (
    expectedProviderDid !== undefined
    && pendingSession.expectedProviderDid !== undefined
    && expectedProviderDid !== pendingSession.expectedProviderDid
  ) {
    throw new Error('Connect: `expectedProviderDid` does not match the pending redirect session.');
  }
  return expectedProviderDid ?? pendingSession.expectedProviderDid;
}

function assertRefreshDelegateMatches(
  pendingSession: PendingRedirectConnectSession,
  localDelegatePortableDid: PortableDid | undefined,
): void {
  if (pendingSession.request.delegateDid !== undefined) {
    if (localDelegatePortableDid === undefined || localDelegatePortableDid.uri !== pendingSession.request.delegateDid) {
      throw new Error('Connect: completing a refresh redirect requires the matching `localDelegatePortableDid`.');
    }
  } else if (localDelegatePortableDid !== undefined) {
    throw new Error('Connect: `localDelegatePortableDid` must only be supplied when completing a refresh redirect.');
  }
}

/** Shared Phase 2 redirect completion pipeline for both delegation and authentication-only flows. */
async function completeRedirectFlow(
  options: CompleteRedirectOptions,
  authenticationOnly: boolean,
): Promise<{
  response: Awaited<ReturnType<typeof openResponse>> | Awaited<ReturnType<typeof openAuthenticationResponse>>;
  authentication: Awaited<ReturnType<typeof verifyResponseAuthentication>>;
} | undefined> {
  const { pendingSession, localDelegatePortableDid, expectedProviderDid } = options;
  assertPendingRedirectSessionMode(pendingSession, authenticationOnly ? 'authenticate' : 'connect');

  const parsed = validateRedirectReturn(options);
  const effectiveExpectedProviderDid = resolveExpectedProviderDid(pendingSession, expectedProviderDid);
  if (!authenticationOnly) {
    assertRefreshDelegateMatches(pendingSession, localDelegatePortableDid);
  }

  if (parsed.error === 'denied') {
    return undefined;
  }

  const doFetch = options.fetchFn ?? defaultFetch;
  const responseCiphertext = await fetchRedirectTokenOnce({
    connectServerUrl : pendingSession.connectServerUrl,
    state            : pendingSession.state,
    fetchFn          : doFetch,
    timeoutMs        : options.timeoutMs ?? RELAY_HTTP_TIMEOUT_MS,
    sleepFn          : options.sleepFn ?? sleep,
  });

  if (responseCiphertext === CONNECT_DENIED_TOKEN) {
    return undefined;
  }

  const response = await (authenticationOnly ? openAuthenticationResponse : openResponse)({
    jwe                 : responseCiphertext,
    recipientPrivateKey : pendingSession.responsePrivateKey,
    responseSecret      : parsed.responseSecret,
    expected            : {
      clientDid   : pendingSession.clientDid,
      nonce       : pendingSession.nonce,
      state       : pendingSession.state,
      providerDid : effectiveExpectedProviderDid,
    },
  });

  const authentication = await verifyResponseAuthentication({
    request                : pendingSession.request,
    authenticationProof    : response.authenticationProof,
    providerDid            : response.providerDid,
    authenticationResolver : options.authenticationResolver,
  });

  void postRelayComplete({
    connectServerUrl : pendingSession.connectServerUrl,
    state            : pendingSession.state,
    fetchFn          : doFetch,
    signal           : AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS),
  }).catch((): undefined => undefined);

  return { response, authentication };
}

/**
 * Phase 2 of same-device hybrid redirect connect (delegation / combined flow):
 * parses `#enbox_state` + `#enbox_key` (or `#enbox_error=denied`) from
 * `returnUrl`, fetches the single-use response JWE from the relay, decrypts it
 * with BOTH `pendingSession.responsePrivateKey` and `enbox_key`, verifies any
 * requested owner authentication proof, and returns {@link ConnectResult} (or
 * `undefined` on denial).
 */
export async function completeRedirectConnect(
  options: CompleteRedirectOptions,
): Promise<ConnectResult | undefined> {
  const completed = await completeRedirectFlow(options, false);
  if (completed === undefined) {
    return undefined;
  }
  const response = completed.response as Awaited<ReturnType<typeof openResponse>>;
  const delegatePortableDid = resolveDelegatePortableDid({
    localDelegatePortableDid: options.localDelegatePortableDid,
    response,
  });
  return {
    delegatePortableDid,
    delegateGrants     : response.delegateGrants,
    connectedDid       : response.providerDid,
    sessionRevocations : response.sessionRevocations,
    ...(completed.authentication === undefined ? {} : { authentication: completed.authentication }),
  };
}

/**
 * Phase 2 of same-device hybrid redirect connect (authentication-only flow).
 */
export async function completeRedirectAuthentication(
  options: Omit<CompleteRedirectOptions, 'localDelegatePortableDid'>,
): Promise<ConnectAuthenticationResult | undefined> {
  const completed = await completeRedirectFlow(options, true);
  if (completed === undefined) {
    return undefined;
  }
  return {
    connectedDid   : completed.response.providerDid,
    authentication : completed.authentication!,
  };
}
