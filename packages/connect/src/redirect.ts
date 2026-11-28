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
 * 3. Back on the app, {@link completeRedirectConnect} parses `#fragment`,
 *    checks `enbox_state === pendingSession.state`, fetches the single-use
 *    ciphertext from `/connect/token/{state}.jwt` once, and decrypts it with
 *    BOTH `responsePrivateKey` AND `enbox_key`.
 *
 * @module
 */

import type { ConnectAuthenticationResolver } from './owner-authentication.js';
import type { FetchFn } from './relay-transport.js';
import type { Jwk } from '@enbox/crypto';
import type { PortableDid } from '@enbox/dids';
import type {
  ConnectAuthenticationParams,
  ConnectAuthenticationResult,
  ConnectClientMetadata,
  ConnectPermissionRequest,
  ConnectRequest,
  ConnectRequestType,
  ConnectResult,
  WalletUriHandoff,
} from './types.js';

import { DidJwk } from '@enbox/dids';
import { concatenateUrl, Convert, sleep } from '@enbox/common';
import { CryptoUtils, X25519 } from '@enbox/crypto';

import { buildWalletConnectUri } from './uri.js';
import { CONNECT_DENIED_TOKEN } from './types.js';
import {
  assertConnectRequest,
  assertValidRedirectUri,
  openAuthenticationResponse,
  openResponse,
  RESPONSE_SECRET_BYTE_LENGTH,
  sealRequest,
} from './envelope.js';
import { ConnectAuthenticationError, verifyOwnerAuthenticationProof } from './owner-authentication.js';
import { randomToken, resolveDelegatePortableDid } from './client.js';

/** Well-known path an app origin can publish to allowlist its exact `redirectUri` values. */
export const APP_MANIFEST_WELL_KNOWN_PATH = '/.well-known/enbox-app';

/** Fragment parameter carrying the request `state` correlator on redirect return. */
export const REDIRECT_RETURN_STATE_PARAM = 'enbox_state';

/** Fragment parameter carrying the 256-bit base64url response secret on redirect return. */
export const REDIRECT_RETURN_KEY_PARAM = 'enbox_key';

/** Fragment parameter carrying a redirect error token (e.g. `denied`) on redirect return. */
export const REDIRECT_RETURN_ERROR_PARAM = 'enbox_error';

/** Default per-request HTTP timeout for redirect relay calls. */
const REDIRECT_HTTP_TIMEOUT_MS = 30_000;

/** Default HTTP timeout for fetching an app's `/.well-known/enbox-app` manifest. */
const APP_MANIFEST_TIMEOUT_MS = 5_000;

/** Max manifest size accepted from `/.well-known/enbox-app` (64 KiB). */
const MAX_APP_MANIFEST_BYTES = 65_536;

/** Max `redirectUris` entries accepted from one app manifest. */
const MAX_APP_MANIFEST_REDIRECT_URIS = 32;

/** DID methods accepted by default on prepared redirect requests. */
const DEFAULT_SUPPORTED_DID_METHODS = ['did:dht', 'did:jwk'];

/** Default fetch helper deferring to ambient global `fetch`. */
const defaultFetch: FetchFn = (input, init): Promise<Response> => globalThis.fetch(input, init);

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

  /** Pre-supplied delegate DID credentials (present only for `requestType === 'refresh'`). */
  delegatePortableDid?: PortableDid;

  /** Unix epoch milliseconds when this pending redirect session was created. */
  createdAt: number;
};

/** Parameters for {@link prepareRedirectConnectRequest}. */
export type PrepareRedirectConnectParams = {
  /** Base URL of the relay's connect routes (e.g. `https://dwn.example/connect`). */
  connectServerUrl: string;

  /** Wallet app URI (e.g. `https://wallet.example/connect/app`). */
  walletUri: string;

  /** Exact URL the wallet redirects back to with `#enbox_state=...&enbox_key=...`. */
  redirectUri: string;

  /** User-friendly name of the requesting application. */
  appName: string;

  /** Optional icon URL of the requesting application. */
  appIcon?: string;

  /** Optional stable application identifier hint. */
  applicationId?: string;

  /** Optional self-reported browser/client metadata. */
  clientMetadata?: ConnectClientMetadata;

  /** Optional owner authentication request. */
  authentication?: ConnectAuthenticationParams;

  /** DWN modules and permission scopes requested (must be `[]` for `authenticate`). */
  permissionRequests: ConnectPermissionRequest[];

  /** Advisory preferred session TTL in seconds. */
  requestedSessionTtlSeconds?: number;

  /** Existing delegate credentials (allowed ONLY when `requestType === 'refresh'`). */
  delegatePortableDid?: PortableDid;

  /** User-facing request purpose (`'connect' | 'refresh' | 'authenticate'`). */
  requestType?: ConnectRequestType;

  /** Wallet profile DID that must approve the request. */
  expectedProviderDid?: string;

  /** Supported DID methods for the connected identity. */
  supportedDidMethods?: string[];

  /** Durable registration hook for authentication-bearing requests (runs before PAR push). */
  onAuthenticationRequest?: (request: Readonly<ConnectRequest>) => Promise<void> | void;

  /** Injectable fetch implementation. */
  fetchFn?: FetchFn;

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
    if (!(params.responseSecret instanceof Uint8Array) || params.responseSecret.byteLength !== RESPONSE_SECRET_BYTE_LENGTH) {
      throw new Error(`Connect: redirect response secret must be ${RESPONSE_SECRET_BYTE_LENGTH} bytes.`);
    }
    fragment.set(REDIRECT_RETURN_KEY_PARAM, Convert.uint8Array(params.responseSecret).toBase64Url());
  }

  return `${params.redirectUri}#${fragment.toString()}`;
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
  const state = params.get(REDIRECT_RETURN_STATE_PARAM);
  const encodedKey = params.get(REDIRECT_RETURN_KEY_PARAM);
  const error = params.get(REDIRECT_RETURN_ERROR_PARAM);

  if (state === null && encodedKey === null && error === null) {
    return undefined;
  }

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

  let responseSecret: Uint8Array;
  try {
    responseSecret = Convert.base64Url(encodedKey).toUint8Array();
  } catch {
    throw new Error('Connect: redirect return `enbox_key` is not valid base64url.');
  }

  if (responseSecret.byteLength !== RESPONSE_SECRET_BYTE_LENGTH) {
    throw new Error(`Connect: redirect return \`enbox_key\` must decode to ${RESPONSE_SECRET_BYTE_LENGTH} bytes.`);
  }

  return { state, responseSecret };
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
  let baseUrl: URL;
  try {
    baseUrl = new URL(origin);
  } catch {
    return undefined;
  }
  if (baseUrl.origin !== origin || (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:')) {
    return undefined;
  }

  const doFetch = options.fetchFn ?? defaultFetch;
  const manifestUrl = `${baseUrl.origin}${APP_MANIFEST_WELL_KNOWN_PATH}`;

  try {
    const response = await doFetch(manifestUrl, {
      method   : 'GET',
      redirect : 'error',
      signal   : AbortSignal.timeout(options.timeoutMs ?? APP_MANIFEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch((): void => {});
      return undefined;
    }

    const text = await response.text();
    if (text.length > MAX_APP_MANIFEST_BYTES) {
      return undefined;
    }

    const parsed = JSON.parse(text) as { redirectUris?: unknown };
    if (!Array.isArray(parsed?.redirectUris) || parsed.redirectUris.length > MAX_APP_MANIFEST_REDIRECT_URIS) {
      return undefined;
    }

    const verifiedUris: string[] = [];
    for (const candidate of parsed.redirectUris) {
      if (typeof candidate !== 'string') {
        continue;
      }
      try {
        assertValidRedirectUri(candidate);
        if (new URL(candidate).origin === baseUrl.origin) {
          verifiedUris.push(candidate);
        }
      } catch {
        // Ignore invalid or cross-origin redirect URI entries.
      }
    }

    return Object.freeze({ redirectUris: Object.freeze(verifiedUris) });
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
  if (manifest === undefined) {
    return false;
  }
  try {
    assertValidRedirectUri(redirectUri);
  } catch {
    return false;
  }
  return manifest.redirectUris.includes(redirectUri);
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
    delegatePortableDid : structuredClone(input.delegatePortableDid),
    supportedDidMethods : input.supportedDidMethods === undefined ? undefined : [...input.supportedDidMethods],
  };

  assertValidRedirectUri(params.redirectUri);

  if (params.requestType === 'refresh' && params.delegatePortableDid === undefined) {
    throw new Error('Connect: refresh requests require an existing `delegatePortableDid`.');
  }
  if (params.delegatePortableDid !== undefined && params.requestType !== 'refresh') {
    throw new Error('Connect: `delegatePortableDid` cannot be pre-supplied on a new redirect request.');
  }

  const clientDid = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();
  const responsePublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x };
  const requestKey = CryptoUtils.randomBytes(32);
  const nonce = randomToken();
  const state = randomToken();
  const callbackUrl = concatenateUrl(params.connectServerUrl, 'callback');

  const request: ConnectRequest = {
    clientDid                  : clientDid.uri,
    appName                    : params.appName,
    appIcon                    : params.appIcon,
    applicationId              : params.applicationId,
    clientMetadata             : params.clientMetadata,
    authentication             : params.authentication,
    permissionRequests         : params.permissionRequests,
    requestedSessionTtlSeconds : params.requestedSessionTtlSeconds,
    delegateDid                : params.delegatePortableDid?.uri,
    requestType                : params.requestType,
    expectedProviderDid        : params.expectedProviderDid,
    supportedDidMethods        : params.supportedDidMethods ?? [...DEFAULT_SUPPORTED_DID_METHODS],
    nonce,
    state,
    responseKey                : responsePublicKey,
    reply                      : {
      mode        : 'redirect',
      callbackUrl,
      redirectUri : params.redirectUri,
    },
  };

  assertConnectRequest(request);
  if (request.authentication !== undefined) {
    await params.onAuthenticationRequest?.(structuredClone(request));
  }

  const requestJwe = await sealRequest({
    request,
    signer     : clientDid,
    encryption : { mode: 'dir', requestKey },
  });

  const doFetch = params.fetchFn ?? defaultFetch;
  const parUrl = concatenateUrl(params.connectServerUrl, 'par');
  const parResponse = await doFetch(parUrl, {
    body    : JSON.stringify({ request: requestJwe }),
    method  : 'POST',
    headers : { 'Content-Type': 'application/json' },
    signal  : AbortSignal.timeout(params.timeoutMs ?? REDIRECT_HTTP_TIMEOUT_MS),
  });

  if (!parResponse.ok) {
    throw new Error(`Connect: pushed authorization request failed with HTTP ${parResponse.status}.`);
  }

  const parData = await parResponse.json() as { request_uri?: unknown; expires_in?: unknown };
  if (typeof parData.request_uri !== 'string' || typeof parData.expires_in !== 'number') {
    throw new Error('Connect: pushed authorization response is missing `request_uri` or `expires_in`.');
  }

  const walletUri = buildWalletConnectUri({
    walletUri     : params.walletUri,
    requestUri    : parData.request_uri,
    encryptionKey : requestKey,
  });

  const pendingSession: PendingRedirectConnectSession = {
    clientDid           : clientDid.uri,
    responsePrivateKey,
    nonce,
    state,
    connectServerUrl    : params.connectServerUrl,
    redirectUri         : params.redirectUri,
    request,
    expectedProviderDid : params.expectedProviderDid,
    delegatePortableDid : params.delegatePortableDid,
    createdAt           : (params.now ?? ((): number => Date.now()))(),
  };

  return {
    walletUri,
    requestUri : parData.request_uri,
    expiresIn  : parData.expires_in,
    pendingSession,
  };
}

/** Fetches the single-use relay token once on redirect return (with tiny transient propagation retry). */
async function fetchRedirectTokenOnce({ connectServerUrl, state, fetchFn, timeoutMs, sleepFn }: {
  connectServerUrl: string;
  state: string;
  fetchFn: FetchFn;
  timeoutMs: number;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<string> {
  const tokenUrl = concatenateUrl(connectServerUrl, `token/${state}.jwt`);
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchFn(tokenUrl, {
      method : 'GET',
      signal : AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      const body = await response.text();
      if (body.length > 0) {
        return body;
      }
    } else {
      await response.body?.cancel().catch((): void => {});
    }

    if (attempt < maxAttempts - 1) {
      await sleepFn(250);
    }
  }

  throw new Error('Connect: redirect response was not found on the relay (it may have expired or already been consumed).');
}

/** Best-effort completion marker POST after successfully opening a redirected response. */
function postBestEffortComplete(connectServerUrl: string, state: string, fetchFn: FetchFn): void {
  const completeUrl = concatenateUrl(connectServerUrl, 'complete');
  void fetchFn(completeUrl, {
    body      : JSON.stringify({ state }),
    method    : 'POST',
    headers   : { 'Content-Type': 'application/json' },
    keepalive : true,
    signal    : AbortSignal.timeout(REDIRECT_HTTP_TIMEOUT_MS),
  }).catch((): undefined => undefined);
}

/**
 * Phase 2 of same-device hybrid redirect connect (delegation / combined flow):
 * parses `#enbox_state` + `#enbox_key` (or `#enbox_error=denied`) from
 * `returnUrl`, fetches the single-use response JWE from the relay, decrypts it
 * with BOTH `pendingSession.responsePrivateKey` and `enbox_key`, verifies any
 * requested owner authentication proof, and returns {@link ConnectResult} (or
 * `undefined` on denial).
 */
export async function completeRedirectConnect({
  pendingSession,
  returnUrl,
  fetchFn,
  authenticationResolver,
  timeoutMs,
  sleepFn,
}: {
  pendingSession: PendingRedirectConnectSession;
  returnUrl: string;
  fetchFn?: FetchFn;
  authenticationResolver?: ConnectAuthenticationResolver;
  timeoutMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<ConnectResult | undefined> {
  if (pendingSession.request.requestType === 'authenticate') {
    throw new Error('Connect: use completeRedirectAuthentication() for an authentication-only redirect session.');
  }

  const parsed = parseRedirectReturnUri(returnUrl);
  if (parsed === undefined) {
    throw new Error('Connect: return URL does not contain Enbox redirect parameters.');
  }
  if (parsed.state !== pendingSession.state) {
    throw new Error('Connect: redirect return `enbox_state` does not match the pending session.');
  }
  if (parsed.error === 'denied') {
    return undefined;
  }

  const doFetch = fetchFn ?? defaultFetch;
  const responseCiphertext = await fetchRedirectTokenOnce({
    connectServerUrl : pendingSession.connectServerUrl,
    state            : pendingSession.state,
    fetchFn          : doFetch,
    timeoutMs        : timeoutMs ?? REDIRECT_HTTP_TIMEOUT_MS,
    sleepFn          : sleepFn ?? sleep,
  });

  if (responseCiphertext === CONNECT_DENIED_TOKEN) {
    return undefined;
  }

  const response = await openResponse({
    jwe                 : responseCiphertext,
    recipientPrivateKey : pendingSession.responsePrivateKey,
    responseSecret      : parsed.responseSecret,
    expected            : {
      clientDid   : pendingSession.clientDid,
      nonce       : pendingSession.nonce,
      state       : pendingSession.state,
      providerDid : pendingSession.expectedProviderDid,
    },
  });

  let authentication;
  if (pendingSession.request.authentication === undefined) {
    if (response.authenticationProof !== undefined) {
      throw new ConnectAuthenticationError('context-mismatch');
    }
  } else {
    if (response.authenticationProof === undefined) {
      throw new ConnectAuthenticationError('invalid-proof');
    }
    authentication = await verifyOwnerAuthenticationProof({
      proof       : response.authenticationProof,
      request     : pendingSession.request,
      providerDid : response.providerDid,
      resolver    : authenticationResolver,
      expected    : {
        audience  : pendingSession.request.authentication.audience,
        challenge : pendingSession.request.authentication.challenge,
      },
    });
  }

  const delegatePortableDid = resolveDelegatePortableDid({
    localDelegatePortableDid: pendingSession.delegatePortableDid,
    response,
  });

  postBestEffortComplete(pendingSession.connectServerUrl, pendingSession.state, doFetch);

  return {
    delegatePortableDid,
    delegateGrants     : response.delegateGrants,
    connectedDid       : response.providerDid,
    sessionRevocations : response.sessionRevocations,
    ...(authentication === undefined ? {} : { authentication }),
  };
}

/**
 * Phase 2 of same-device hybrid redirect connect (authentication-only flow).
 */
export async function completeRedirectAuthentication({
  pendingSession,
  returnUrl,
  fetchFn,
  authenticationResolver,
  timeoutMs,
  sleepFn,
}: {
  pendingSession: PendingRedirectConnectSession;
  returnUrl: string;
  fetchFn?: FetchFn;
  authenticationResolver?: ConnectAuthenticationResolver;
  timeoutMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<ConnectAuthenticationResult | undefined> {
  if (pendingSession.request.requestType !== 'authenticate' || pendingSession.request.authentication === undefined) {
    throw new ConnectAuthenticationError('invalid-request');
  }

  const parsed = parseRedirectReturnUri(returnUrl);
  if (parsed === undefined) {
    throw new Error('Connect: return URL does not contain Enbox redirect parameters.');
  }
  if (parsed.state !== pendingSession.state) {
    throw new Error('Connect: redirect return `enbox_state` does not match the pending session.');
  }
  if (parsed.error === 'denied') {
    return undefined;
  }

  const doFetch = fetchFn ?? defaultFetch;
  const responseCiphertext = await fetchRedirectTokenOnce({
    connectServerUrl : pendingSession.connectServerUrl,
    state            : pendingSession.state,
    fetchFn          : doFetch,
    timeoutMs        : timeoutMs ?? REDIRECT_HTTP_TIMEOUT_MS,
    sleepFn          : sleepFn ?? sleep,
  });

  if (responseCiphertext === CONNECT_DENIED_TOKEN) {
    return undefined;
  }

  const response = await openAuthenticationResponse({
    jwe                 : responseCiphertext,
    recipientPrivateKey : pendingSession.responsePrivateKey,
    responseSecret      : parsed.responseSecret,
    expected            : {
      clientDid   : pendingSession.clientDid,
      nonce       : pendingSession.nonce,
      state       : pendingSession.state,
      providerDid : pendingSession.expectedProviderDid,
    },
  });

  const authentication = await verifyOwnerAuthenticationProof({
    proof       : response.authenticationProof,
    request     : pendingSession.request,
    providerDid : response.providerDid,
    resolver    : authenticationResolver,
    expected    : {
      audience  : pendingSession.request.authentication.audience,
      challenge : pendingSession.request.authentication.challenge,
    },
  });

  postBestEffortComplete(pendingSession.connectServerUrl, pendingSession.state, doFetch);

  return {
    connectedDid: response.providerDid,
    authentication,
  };
}
