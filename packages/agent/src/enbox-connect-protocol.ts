/**
 * Enbox Connect Protocol
 *
 * A capability delegation protocol for DWN access. Enables apps to request
 * scoped permission grants from a wallet (provider), receiving a delegate DID
 * with the granted permissions.
 *
 * Two transport modes:
 * - Local: same-device, direct HTTP against a paired local DWN
 * - Remote (`enbox://connect`): cross-device, relay-mediated with QR/deep link
 *
 * The protocol uses JWTs for signing, JWE (XChaCha20-Poly1305) for encryption,
 * and ECDH (Ed25519 → X25519 + HKDF) for key agreement.
 */

import type { EnboxPlatformAgent } from './types/agent.js';
import type { RequireOnly } from '@enbox/common';
import type { BearerDid, DidDocument, PortableDid } from '@enbox/dids';
import type { ConnectSessionMetadata, ConnectSessionTransport, DwnDataEncodedRecordsWriteMessage, DwnPermissionScope, DwnProtocolDefinition, DwnRecordsPermissionScope } from './types/dwn.js';
import type { JoseHeaderParams, Jwk, PrivateKeyJwk } from '@enbox/crypto';

/**
 * The protocols of permissions requested, along with the definition and permission scopes for each protocol.
 */
export type ConnectPermissionRequest = {
  /**
   * The definition of the protocol the permissions are being requested for.
   * In the event that the protocol is not already installed, the wallet will install this given protocol definition.
   */
  protocolDefinition: DwnProtocolDefinition;

  /** The scope of the permissions being requested for the given protocol */
  permissionScopes: DwnPermissionScope[];
};

/**
 * Client/environment details captured by the connect client for wallet session display.
 *
 * This data is self-reported by the requester, unauthenticated, and intended
 * only as display hints. Wallets must not treat it as verified app identity.
 */
export type ConnectClientMetadata = {
  /** Origin of the requesting app, when known. */
  origin?: string;
  /** Browser user agent string, when available. */
  userAgent?: string;
  /** Platform/device hint, when available. */
  platform?: string;
  /** Primary language, when available. */
  language?: string;
  /** Language preference list, when available. */
  languages?: string[];
  /** IANA timezone, when available. */
  timezone?: string;
};

export type CreateConnectSessionMetadataOptions = {
  id?: string;
  appName?: string;
  appIcon?: string;
  clientMetadata?: ConnectClientMetadata;
  transport?: ConnectSessionTransport;
  createdAt?: string;
  expiresAt?: string;
  ttlSeconds?: number;
};

export type ConnectPermissionGrantOptions = {
  /** Grant expiration timestamp. Defaults to the connect session expiration. */
  dateExpires?: string;
  /** Session metadata attached to every grant created by the approval. */
  connectSession?: ConnectSessionMetadata;
};

import { concatenateUrl, Convert, logger, nowMs, timed } from '@enbox/common';
import {
  CryptoUtils,
  Ed25519,
  EdDsaAlgorithm,
  Hkdf,
  X25519,
  XChaCha20Poly1305,
} from '@enbox/crypto';
import { Did, DidJwk } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol, Time } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnInterface } from './types/dwn.js';
import { isRecordPermissionScope } from './dwn-api.js';
import {
  createGrantKeyRecordsForGrants as createGrantKeyRecordsForGrantsFn,
  getEncryptionKeyInfo,
} from './dwn-encryption.js';
import { mapConcurrent, mapConcurrentSettled } from './utils.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Maximum fan-out concurrency used by the connect flow. Permission grants use
 * this as the endpoint concurrency while sending sequentially within each
 * endpoint; the other fan-outs use it as their total request concurrency.
 */
const CONNECT_FANOUT_CONCURRENCY = 8;

/**
 * Per-request abort budget applied to every DWN-endpoint `sendDwnRequest`
 * issued during the connect flow. The HttpDwnRpcClient's default per-attempt
 * timeout is 30 s with 3 retries (~120 s worst-case per request) — that
 * scales unacceptably when bounded fan-out has to wait for every settled
 * task. With this budget, an unhealthy / cold endpoint short-circuits the
 * retry loop within a few seconds (AbortError is non-retryable), keeping
 * the user-visible "Authorizing…" wait bounded even when one of N DWN
 * endpoints is misbehaving.
 *
 * Best-effort fan-outs tolerate per-task failure because sync delivers missed
 * copies eventually. Required permission-grant delivery combines this with a
 * separate whole-batch deadline and verifies every grant was accepted.
 */
const CONNECT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Whole-batch budget for required permission-grant delivery. Permission
 * grants are sent sequentially per endpoint because a DWN serializes writes
 * for the same tenant. This bound prevents a consistently slow endpoint from
 * extending approval time once individual requests have started succeeding.
 */
const CONNECT_PERMISSION_GRANT_BATCH_TIMEOUT_MS = 20_000;

/** Log namespace used for wallet-side connect critical-path timings. */
const CONNECT_PERF_LOG_PREFIX = '[connect.perf]';

/**
 * Default lifetime for app delegate grants created by a connect approval.
 *
 * This is a hard grant expiry. There is intentionally no renewal path in this
 * protocol layer yet; clients should treat expired connect grants as
 * reconnect-required.
 */
export const CONNECT_SESSION_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Maximum lifetime a wallet will stamp onto relay connect session grants. */
export const CONNECT_SESSION_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

const CONNECT_SESSION_METADATA_LIMITS = {
  id        : 128,
  appName   : 128,
  appIcon   : 2048,
  origin    : 512,
  userAgent : 512,
  platform  : 128,
  language  : 64,
  languages : 16,
  timezone  : 128,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pushed to the connect server so the wallet can retrieve it later.
 * The request is encrypted (JWE) before being pushed.
 *
 * Inspired by RFC 9126 (Pushed Authorization Requests).
 */
export type ConnectPushedRequest = {
  /** The encrypted JWE containing the signed {@link EnboxConnectRequest} JWT. */
  request: string;
};

/**
 * Returned by the connect server after a {@link ConnectPushedRequest}.
 * Contains a URI the wallet uses to fetch the encrypted request,
 * and the TTL before it expires.
 */
export type ConnectPushedResponse = {
  /** URI where the wallet can fetch the encrypted auth request. */
  request_uri: string;
  /** Seconds until the request expires. */
  expires_in: number;
};

/**
 * A connect request from an app to a wallet, asking for DWN permissions.
 *
 * The app creates this, signs it as a JWT, encrypts it as a JWE, and pushes
 * it to the connect server. The wallet retrieves, decrypts, verifies, and
 * displays it in a consent UI.
 */
export type EnboxConnectRequest = {
  /** Ephemeral DID (did:jwk) used for ECDH key agreement and request signing. */
  clientDid: string;

  /** Human-readable name of the requesting application, shown in the consent UI. */
  appName: string;

  /** Optional icon URL for the requesting application, shown in the consent UI. */
  appIcon?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /** Preferred session TTL in seconds. Wallets may clamp this to their policy maximum. */
  requestedSessionTtlSeconds?: number;

  /**
   * Optional delegate DID supplied by the requester.
   *
   * When present, the wallet grants permissions to this DID instead of
   * minting a new delegate DID and returning its private key material.
   */
  delegateDid?: string;

  /** DWN protocols and permission scopes being requested. */
  permissionRequests: ConnectPermissionRequest[];

  /** Anti-replay nonce (random base64url). */
  nonce: string;

  /** State correlator for matching request to response (random base64url). */
  state: string;

  /** URL where the wallet should POST the encrypted response. */
  callbackUrl: string;

  /** Response mode — always `direct_post` (wallet POSTs response to callbackUrl). */
  responseMode: 'direct_post';

  /** Supported DID methods for the connected identity. */
  supportedDidMethods: string[];
};

/**
 * A connect response from a wallet, granting DWN permissions.
 *
 * The wallet creates this after user consent, signs it as a JWT with the
 * delegate DID, encrypts it via ECDH, and POSTs it to the connect server.
 * The app retrieves, decrypts (using ECDH + optional PIN), and verifies it.
 */
export type EnboxConnectResponse = {
  /** The wallet owner's real DID that authorised the delegation. */
  providerDid: string;

  /** The delegate DID identifier that received the grants. */
  delegateDid: string;

  /** Audience — must match the `clientDid` from the request. */
  aud: string;

  /** Issued-at timestamp (Unix seconds). */
  iat: number;

  /** Expiration timestamp (Unix seconds). */
  exp: number;

  /** Echo of the request nonce. */
  nonce?: string;

  /** DWN permission grant messages (serialised RecordsWrite with encoded data). */
  delegateGrants: DwnDataEncodedRecordsWriteMessage[];

  /**
   * The delegate DID's full portable form, including private keys.
   *
   * Present for wallet-minted delegate sessions and omitted when the request
   * supplied its own delegate DID.
   */
  delegatePortableDid?: PortableDid;

  /** Per-grant revocation mappings for session-bound self-revocation on disconnect. */
  sessionRevocations?: { grantId: string; revocationGrantId: string }[];
};

/** The connect server endpoint types. */
export type ConnectEndpoint =
  | 'pushedAuthorizationRequest'
  | 'authorize'
  | 'callback'
  | 'token';

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/**
 * Builds the URL for a connect server endpoint.
 *
 * @param options.baseURL - The connect server base URL (e.g. `http://localhost:3000/connect/`)
 * @param options.endpoint - The endpoint type
 * @param options.authParam - Required for `authorize` endpoint (the request ID)
 * @param options.tokenParam - Required for `token` endpoint (the state value)
 */
function buildConnectUrl({
  baseURL,
  endpoint,
  authParam,
  tokenParam,
}: {
  baseURL: string;
  endpoint: ConnectEndpoint;
  authParam?: string;
  tokenParam?: string;
}): string {
  switch (endpoint) {
    case 'pushedAuthorizationRequest':
      return concatenateUrl(baseURL, 'par');
    case 'authorize':
      if (!authParam) {
        throw new Error('authParam must be provided when building an authorize URL');
      }
      return concatenateUrl(baseURL, `authorize/${authParam}.jwt`);
    case 'callback':
      return concatenateUrl(baseURL, 'callback');
    case 'token':
      if (!tokenParam) {
        throw new Error('tokenParam must be provided when building a token URL');
      }
      return concatenateUrl(baseURL, `token/${tokenParam}.jwt`);
    default:
      throw new Error(`Unknown connect endpoint: ${endpoint}`);
  }
}

/**
 * Builds the wallet URI handed to the user (QR code or deep link) for a
 * pushed connect request.
 *
 * The request pointer and the single-use symmetric encryption key travel in
 * the URI **fragment**, never in the query string: the fragment stays on the
 * local channel (terminal → camera, or entirely within the opening browser)
 * and is never sent to the wallet's web server, so the key cannot surface in
 * server or CDN logs on the deep-link path.
 *
 * @param options.walletUri - The wallet app URI (typically ending in the
 *   connect route, e.g. `https://wallet.example/connect/app`).
 * @param options.requestUri - The relay `request_uri` returned by the pushed
 *   authorization request.
 * @param options.encryptionKey - The single-use symmetric key protecting the
 *   pushed request.
 */
function buildWalletConnectUri({
  walletUri,
  requestUri,
  encryptionKey,
}: {
  walletUri: string;
  requestUri: string;
  encryptionKey: Uint8Array;
}): string {
  const uri = new URL(walletUri);
  const fragmentParams = new URLSearchParams();
  fragmentParams.set('request_uri', requestUri);
  fragmentParams.set('encryption_key', Convert.uint8Array(encryptionKey).toBase64Url());
  uri.hash = fragmentParams.toString();
  return uri.toString();
}

/**
 * Parses a wallet connect URI produced by {@link buildWalletConnectUri},
 * returning the relay request pointer and the request encryption key, or
 * `undefined` when the URI does not carry connect parameters.
 */
function parseWalletConnectUri(uri: string): {
  requestUri: string;
  encryptionKeyBase64Url: string;
} | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(fragment);
  const requestUri = params.get('request_uri');
  const encryptionKeyBase64Url = params.get('encryption_key');
  if (!requestUri || !encryptionKeyBase64Url) {
    return undefined;
  }
  return { requestUri, encryptionKeyBase64Url };
}

// ---------------------------------------------------------------------------
// JWT signing and verification
// ---------------------------------------------------------------------------

/**
 * Signs an object as a JWT using an Ed25519 DID key.
 *
 * `data` is constrained to `object` so callers don't have to widen
 * typed payload shapes (e.g. `EnboxConnectResponse`) to
 * `Record<string, unknown>` at the call site. `Convert.object(data)`
 * stringifies whatever JSON-serializable shape is passed.
 */
async function signJwt({
  did,
  data,
}: {
  did: BearerDid;
  data: object;
}): Promise<string> {
  const header = Convert.object({
    alg : 'EdDSA',
    kid : did.document.verificationMethod![0].id,
    typ : 'JWT',
  }).toBase64Url();

  const payload = Convert.object(data).toBase64Url();

  const signer = await did.getSigner();
  const signature = await signer.sign({
    data: Convert.string(`${header}.${payload}`).toUint8Array(),
  });

  const signatureBase64Url = Convert.uint8Array(signature).toBase64Url();
  return `${header}.${payload}.${signatureBase64Url}`;
}

/**
 * Verifies a JWT signature using the DID in the `kid` header. Returns the
 * parsed payload as an untyped object.
 *
 * The return type is intentionally `Record<string, unknown>` rather than a
 * caller-supplied generic — a JWT payload is bytes from a remote party, and
 * we can't soundly assert its shape without runtime validation. Callers must
 * apply one of the {@link assertConnectRequest} / {@link assertConnectResponse}
 * assertion helpers (or their own type guard) to narrow the payload before
 * accessing fields.
 */
async function verifyJwt({ jwt }: { jwt: string }): Promise<Record<string, unknown>> {
  const [headerB64U, payloadB64U, signatureB64U] = jwt.split('.');

  const header: JoseHeaderParams = Convert.base64Url(headerB64U).toObject();

  if (!header.kid) {
    throw new Error('Connect: JWT missing required "kid" header value.');
  }

  const { didDocument } = await DidJwk.resolve(header.kid.split('#')[0]);

  if (!didDocument) {
    throw new Error('Connect: JWT verification failed — could not resolve DID.');
  }

  const { publicKeyJwk } =
    didDocument.verificationMethod?.find((method: any) => {
      return method.id === header.kid;
    }) ?? {};

  if (!publicKeyJwk) {
    throw new Error('Connect: JWT verification failed — public key not found in DID document.');
  }

  const EdDsa = new EdDsaAlgorithm();
  const isValid = await EdDsa.verify({
    key       : publicKeyJwk,
    signature : Convert.base64Url(signatureB64U).toUint8Array(),
    data      : Convert.string(`${headerB64U}.${payloadB64U}`).toUint8Array(),
  });

  if (!isValid) {
    throw new Error('Connect: JWT verification failed — invalid signature.');
  }

  const decoded: unknown = Convert.base64Url(payloadB64U).toObject();
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Connect: JWT verification failed — payload must be a JSON object.');
  }
  return decoded as Record<string, unknown>;
}

// ─── Field-level validation helpers ─────────────────────────────────────
//
// The connect-request / connect-response assertions below describe their
// expected shape declaratively in terms of these primitive checks. Each
// helper throws a consistent `Connect: <context> — \`<field>\` <reason>`
// message on mismatch, so per-field error formatting is centralized here
// rather than duplicated at every call site.

/**
 * Throws a shape-validation error during connect JWT assertion.
 *
 * Deliberately throws plain `Error` rather than `TypeError` even though
 * the failures are runtime type-shape mismatches. The reason is layered
 * error handling: boundary-validation failures need to propagate through
 * the same `try/catch` paths as every other connect-flow error — vault
 * lock failure, JWT signature failure, DWN request failure, etc. —
 * without `catch` blocks having to special-case a `TypeError` subclass.
 *
 * SonarCloud's `typescript:S7786` flags this as "too unspecific for a
 * type check" and prefers `TypeError`. We suppress it at the file level
 * (see `sonar-project.properties`) because every `require*` helper goes
 * through this single throw site.
 */
function fail(context: string, field: string, reason: string): never {
  throw new Error(`Connect: ${context} — \`${field}\` ${reason}.`);
}

function requireString(payload: Record<string, unknown>, field: string, context: string): void {
  if (typeof payload[field] !== 'string') { fail(context, field, 'must be a string'); }
}

function requireNumber(payload: Record<string, unknown>, field: string, context: string): void {
  if (typeof payload[field] !== 'number') { fail(context, field, 'must be a number'); }
}

function requireOptionalNumber(payload: Record<string, unknown>, field: string, context: string): void {
  if (payload[field] !== undefined && typeof payload[field] !== 'number') {
    fail(context, field, 'must be a number when present');
  }
}

function requireArray(payload: Record<string, unknown>, field: string, context: string): void {
  if (!Array.isArray(payload[field])) { fail(context, field, 'must be an array'); }
}

function requireLiteral<L extends string | number | boolean>(
  payload: Record<string, unknown>, field: string, expected: L, context: string,
): void {
  if (payload[field] !== expected) { fail(context, field, `must be ${JSON.stringify(expected)}`); }
}

function requireStringArray(payload: Record<string, unknown>, field: string, context: string): void {
  const value = payload[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    fail(context, field, 'must be a string[]');
  }
}

function requireOptionalString(payload: Record<string, unknown>, field: string, context: string): void {
  if (payload[field] !== undefined && typeof payload[field] !== 'string') {
    fail(context, field, 'must be a string when present');
  }
}

function requireOptionalObject(payload: Record<string, unknown>, field: string, context: string): void {
  const value = payload[field];
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    fail(context, field, 'must be an object when present');
  }
}

function requireOptionalArray(payload: Record<string, unknown>, field: string, context: string): void {
  if (payload[field] !== undefined && !Array.isArray(payload[field])) {
    fail(context, field, 'must be an array when present');
  }
}

// ─── Boundary assertions ────────────────────────────────────────────────
//
// Each `assertConnect*` describes the shape of its target type as a list
// of per-field requirements. The structural existence/primitive checks
// are the only validation done at the JWT-payload boundary; deeper
// validation of nested arrays/objects (permission scopes, grants,
// portable DID structure) happens downstream in DWN-aware validators
// where the richer logic already lives.

/**
 * Runtime assertion that a verified JWT payload has the shape of an
 * {@link EnboxConnectRequest}. Use immediately after `verifyJwt()` to narrow
 * a `Record<string, unknown>` payload before accessing fields.
 */
function assertConnectRequest(payload: Record<string, unknown>): asserts payload is EnboxConnectRequest {
  const ctx = 'invalid connect request';
  requireString(payload, 'clientDid', ctx);
  requireString(payload, 'appName', ctx);
  requireOptionalString(payload, 'appIcon', ctx);
  requireOptionalObject(payload, 'clientMetadata', ctx);
  requireOptionalNumber(payload, 'requestedSessionTtlSeconds', ctx);
  requireOptionalString(payload, 'delegateDid', ctx);
  requireArray(payload, 'permissionRequests', ctx);
  requireString(payload, 'nonce', ctx);
  requireString(payload, 'state', ctx);
  requireString(payload, 'callbackUrl', ctx);
  requireLiteral(payload, 'responseMode', 'direct_post', ctx);
  requireStringArray(payload, 'supportedDidMethods', ctx);
}

/**
 * Runtime assertion that a verified JWT payload has the shape of an
 * {@link EnboxConnectResponse}. Use immediately after `verifyJwt()` to narrow
 * a `Record<string, unknown>` payload before accessing fields.
 */
function assertConnectResponse(payload: Record<string, unknown>): asserts payload is EnboxConnectResponse {
  const ctx = 'invalid connect response';
  requireString(payload, 'providerDid', ctx);
  requireString(payload, 'delegateDid', ctx);
  requireString(payload, 'aud', ctx);
  requireNumber(payload, 'iat', ctx);
  requireNumber(payload, 'exp', ctx);
  requireOptionalString(payload, 'nonce', ctx);
  requireArray(payload, 'delegateGrants', ctx);
  requireOptionalObject(payload, 'delegatePortableDid', ctx);
  requireOptionalArray(payload, 'sessionRevocations', ctx);
}

// ---------------------------------------------------------------------------
// Encryption: request (symmetric key via QR/deep link)
// ---------------------------------------------------------------------------

/** Encrypts the connect request JWT with a symmetric key (shared via QR code or deep link). */
async function encryptRequest({
  jwt,
  encryptionKey,
}: {
  jwt: string;
  encryptionKey: Uint8Array;
}): Promise<string> {
  const protectedHeader = {
    alg : 'dir',
    cty : 'JWT',
    enc : 'XC20P',
    typ : 'JWT',
  };
  const nonce = CryptoUtils.randomBytes(24);
  const additionalData = Convert.object(protectedHeader).toUint8Array();
  const jwtBytes = Convert.string(jwt).toUint8Array();
  const ciphertextAndTag = await XChaCha20Poly1305.encryptRaw({ data: jwtBytes, keyBytes: encryptionKey, nonce, additionalData });

  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const authenticationTag = ciphertextAndTag.subarray(-16);

  return [
    Convert.object(protectedHeader).toBase64Url(),
    '', // No wrapped key (direct encryption).
    Convert.uint8Array(nonce).toBase64Url(),
    Convert.uint8Array(ciphertext).toBase64Url(),
    Convert.uint8Array(authenticationTag).toBase64Url(),
  ].join('.');
}

/** Decrypts an encrypted connect request JWE using the symmetric key from the QR/deep link. */
async function decryptRequest({
  jwe,
  encryptionKey,
}: {
  jwe: string;
  encryptionKey: string;
}): Promise<string> {
  const [
    protectedHeaderB64U,
    ,
    nonceB64U,
    ciphertextB64U,
    authenticationTagB64U,
  ] = jwe.split('.');

  const encryptionKeyBytes = Convert.base64Url(encryptionKey).toUint8Array();
  const additionalData = Convert.base64Url(protectedHeaderB64U).toUint8Array();
  const nonce = Convert.base64Url(nonceB64U).toUint8Array();
  const ciphertext = Convert.base64Url(ciphertextB64U).toUint8Array();
  const authenticationTag = Convert.base64Url(authenticationTagB64U).toUint8Array();

  const ciphertextAndTag = new Uint8Array([...ciphertext, ...authenticationTag]);
  const decryptedJwtBytes = await XChaCha20Poly1305.decryptRaw({ data: ciphertextAndTag, keyBytes: encryptionKeyBytes, nonce, additionalData });

  return Convert.uint8Array(decryptedJwtBytes).toString();
}

// ---------------------------------------------------------------------------
// Encryption: response (ECDH shared key + optional PIN)
// ---------------------------------------------------------------------------

/**
 * Core ECDH key derivation from a raw public key JWK.
 *
 * Converts both keys to X25519, performs ECDH, and derives the final
 * symmetric key via HKDF-SHA-256.
 */
async function deriveSharedKeyFromJwk(
  privateKeyDid: BearerDid,
  publicKeyJwk: Jwk
): Promise<Uint8Array> {
  const privatePortableDid = await privateKeyDid.export();
  const privateJwk = privatePortableDid.privateKeys?.[0]!;
  const pubJwk = { ...publicKeyJwk, alg: 'EdDSA' };

  const publicX25519 = await Ed25519.convertPublicKeyToX25519({ publicKey: pubJwk });
  const privateX25519 = await Ed25519.convertPrivateKeyToX25519({ privateKey: privateJwk });

  const sharedKey = await X25519.sharedSecret({
    privateKeyA : privateX25519,
    publicKeyB  : publicX25519,
  });

  return Hkdf.deriveKeyBytes({
    baseKeyBytes : new Uint8Array(sharedKey),
    hash         : 'SHA-256',
    salt         : new Uint8Array(),
    info         : new Uint8Array(),
    length       : 256,
  });
}

/** Derives a shared ECDH key for encrypting/decrypting the connect response. */
async function deriveSharedKey(
  privateKeyDid: BearerDid,
  publicKeyDid: DidDocument
): Promise<Uint8Array> {
  const publicJwk = publicKeyDid.verificationMethod?.[0].publicKeyJwk!;
  return deriveSharedKeyFromJwk(privateKeyDid, publicJwk);
}

/**
 * Encrypts the connect response JWT.
 *
 * For remote (relay-mediated) flows, `pin` is required — it is added to the
 * AAD to prevent MITM attacks via the untrusted relay.
 *
 * For local (same-device) flows, `pin` may be omitted — the ECDH encryption
 * alone is sufficient when there is no untrusted intermediary.
 */
async function encryptResponse({
  jwt,
  encryptionKey,
  delegatePublicKeyJwk,
  pin,
}: {
  jwt: string;
  encryptionKey: Uint8Array;
  delegatePublicKeyJwk: Jwk;
  pin?: string;
}): Promise<string> {
  // Include only the minimum key material (kty, crv, x) in the ephemeral
  // public key header.  This avoids leaking DID-level identifiers (kid,
  // alg, etc.) that would let the relay correlate sessions or resolve
  // the delegate DID.  See https://github.com/enboxorg/enbox/issues/890
  const epk: Jwk = {
    kty : delegatePublicKeyJwk.kty,
    crv : delegatePublicKeyJwk.crv,
    x   : delegatePublicKeyJwk.x,
  };
  const protectedHeader = {
    alg : 'dir',
    cty : 'JWT',
    enc : 'XC20P',
    typ : 'JWT',
    epk,
  };
  const nonce = CryptoUtils.randomBytes(24);

  // Build AAD — include PIN if provided (remote flows).
  const aadObject = pin
    ? { ...protectedHeader, pin }
    : { ...protectedHeader };
  const additionalData = Convert.object(aadObject).toUint8Array();

  const jwtBytes = Convert.string(jwt).toUint8Array();
  const ciphertextAndTag = await XChaCha20Poly1305.encryptRaw({ data: jwtBytes, keyBytes: encryptionKey, nonce, additionalData });

  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const authenticationTag = ciphertextAndTag.subarray(-16);

  return [
    Convert.object(protectedHeader).toBase64Url(),
    '', // No wrapped key (direct encryption).
    Convert.uint8Array(nonce).toBase64Url(),
    Convert.uint8Array(ciphertext).toBase64Url(),
    Convert.uint8Array(authenticationTag).toBase64Url(),
  ].join('.');
}

/**
 * Decrypts the connect response JWE using ECDH + optional PIN.
 *
 * @param clientDid - The ephemeral DID used at connect initiation (for ECDH).
 * @param jwe - The encrypted response JWE.
 * @param pin - The PIN entered by the user (required for remote flows, omit for local).
 */
async function decryptResponse(
  clientDid: BearerDid,
  jwe: string,
  pin?: string
): Promise<string> {
  const [
    protectedHeaderB64U,
    ,
    nonceB64U,
    ciphertextB64U,
    authenticationTagB64U,
  ] = jwe.split('.');

  const header = Convert.base64Url(protectedHeaderB64U).toObject() as Record<string, unknown>;
  if (!header.epk || typeof header.epk !== 'object') {
    throw new Error('Connect: JWE protected header is missing required "epk" property.');
  }

  const sharedKey = await deriveSharedKeyFromJwk(clientDid, header.epk as Jwk);

  // Build AAD — include PIN if provided (must match what was used during encryption).
  const aadObject = pin
    ? { ...header, pin }
    : { ...header };
  const AAD = Convert.object(aadObject).toUint8Array();

  const nonce = Convert.base64Url(nonceB64U).toUint8Array();
  const ciphertext = Convert.base64Url(ciphertextB64U).toUint8Array();
  const authenticationTag = Convert.base64Url(authenticationTagB64U).toUint8Array();

  const ciphertextAndTag = new Uint8Array([...ciphertext, ...authenticationTag]);
  const decryptedJwtBytes = await XChaCha20Poly1305.decryptRaw({ data: ciphertextAndTag, keyBytes: sharedKey, nonce, additionalData: AAD });

  return Convert.uint8Array(decryptedJwtBytes).toString();
}

// ---------------------------------------------------------------------------
// Request creation and retrieval
// ---------------------------------------------------------------------------

/** Creates an {@link EnboxConnectRequest}. */
async function createConnectRequest(
  options: RequireOnly<
    EnboxConnectRequest,
    'clientDid' | 'callbackUrl' | 'permissionRequests' | 'appName'
  >
): Promise<EnboxConnectRequest> {
  const stateBytes = CryptoUtils.randomBytes(16);
  const nonceBytes = CryptoUtils.randomBytes(16);

  return {
    ...options,
    nonce               : Convert.uint8Array(nonceBytes).toBase64Url(),
    responseMode        : 'direct_post',
    state               : Convert.uint8Array(stateBytes).toBase64Url(),
    supportedDidMethods : options.supportedDidMethods ?? ['did:dht', 'did:jwk'],
  };
}

/**
 * Fetches an encrypted connect request from the authorize endpoint
 * and decrypts it using the encryption key from the QR/deep link.
 */
async function getConnectRequest(requestUri: string, encryptionKey: string): Promise<EnboxConnectRequest> {
  const response = await fetch(requestUri, { signal: AbortSignal.timeout(30_000) });
  const jwe = await response.text();
  const jwt = await decryptRequest({ jwe, encryptionKey });
  const payload = await verifyJwt({ jwt });
  assertConnectRequest(payload);
  return payload;
}

// ---------------------------------------------------------------------------
// Response creation
// ---------------------------------------------------------------------------

/** Creates an {@link EnboxConnectResponse} with timestamps. */
async function createConnectResponse(
  options: RequireOnly<
    EnboxConnectResponse,
    'providerDid' | 'delegateDid' | 'aud' | 'delegateGrants'
  >
): Promise<EnboxConnectResponse> {
  const currentTimeInSeconds = Math.floor(Date.now() / 1000);

  return {
    ...options,
    iat : currentTimeInSeconds,
    exp : currentTimeInSeconds + 600, // 10 minutes
  };
}

// ---------------------------------------------------------------------------
// Permission grants
// ---------------------------------------------------------------------------

function assertConnectGrantScope(scope: DwnPermissionScope): void {
  if (isRecordPermissionScope(scope)) {
    const method = scope.method as DwnMethodName;
    if (
      method === DwnMethodName.Query ||
      method === DwnMethodName.Subscribe ||
      method === DwnMethodName.Count
    ) {
      throw new Error(
        `Records.${method} grants are not supported by connect; request Records.Read instead.`
      );
    }
    return;
  }

  if (scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Configure) {
    throw new Error(
      'Protocols.Configure cannot be delegated through connect; the wallet configures protocols during approval.'
    );
  }
}

function shouldUseDelegatePermission(scope: DwnPermissionScope): boolean {
  return isRecordPermissionScope(scope);
}

function isConnectReadScope(scope: DwnPermissionScope): scope is DwnRecordsPermissionScope {
  return isRecordPermissionScope(scope) && scope.method === DwnMethodName.Read;
}

function randomSessionId(): string {
  return Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url();
}

function boundedSessionString(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value.slice(0, maxLength);
}

function boundedSessionStringArray(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const bounded = values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .slice(0, CONNECT_SESSION_METADATA_LIMITS.languages)
    .map((value) => value.slice(0, CONNECT_SESSION_METADATA_LIMITS.language));

  return bounded.length > 0 ? bounded : undefined;
}

function createConnectSessionMetadata(
  options: CreateConnectSessionMetadataOptions = {},
): ConnectSessionMetadata {
  const createdAt = options.createdAt ?? Time.getCurrentTimestamp();
  const expiresAt = options.expiresAt ?? Time.createOffsetTimestamp({
    seconds: options.ttlSeconds ?? CONNECT_SESSION_DEFAULT_TTL_SECONDS,
  }, createdAt);
  const clientMetadata = options.clientMetadata ?? {};
  const appName = boundedSessionString(options.appName, CONNECT_SESSION_METADATA_LIMITS.appName);
  const appIcon = boundedSessionString(options.appIcon, CONNECT_SESSION_METADATA_LIMITS.appIcon);
  const origin = boundedSessionString(clientMetadata.origin, CONNECT_SESSION_METADATA_LIMITS.origin);
  const userAgent = boundedSessionString(clientMetadata.userAgent, CONNECT_SESSION_METADATA_LIMITS.userAgent);
  const platform = boundedSessionString(clientMetadata.platform, CONNECT_SESSION_METADATA_LIMITS.platform);
  const language = boundedSessionString(clientMetadata.language, CONNECT_SESSION_METADATA_LIMITS.language);
  const languages = boundedSessionStringArray(clientMetadata.languages);
  const timezone = boundedSessionString(clientMetadata.timezone, CONNECT_SESSION_METADATA_LIMITS.timezone);

  return {
    id: boundedSessionString(options.id, CONNECT_SESSION_METADATA_LIMITS.id) ?? randomSessionId(),
    createdAt,
    expiresAt,
    ...(appName ? { appName } : {}),
    ...(appIcon ? { appIcon } : {}),
    ...(origin ? { origin } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(platform ? { platform } : {}),
    ...(language ? { language } : {}),
    ...(languages ? { languages } : {}),
    ...(timezone ? { timezone } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  };
}

function resolveRequestedSessionTtlSeconds(requestedSessionTtlSeconds: number | undefined): number {
  if (requestedSessionTtlSeconds === undefined) {
    return CONNECT_SESSION_DEFAULT_TTL_SECONDS;
  }

  const requestedWholeSeconds = Math.floor(requestedSessionTtlSeconds);

  if (!Number.isFinite(requestedSessionTtlSeconds) || requestedWholeSeconds <= 0) {
    throw new Error('Connect requestedSessionTtlSeconds must resolve to at least one whole second.');
  }

  return Math.min(
    requestedWholeSeconds,
    CONNECT_SESSION_MAX_TTL_SECONDS,
  );
}

function hasEncryptedProtocolTypes(protocolDefinition: DwnProtocolDefinition): boolean {
  return Object.values(protocolDefinition.types ?? {})
    .some((type: any) => type?.encryptionRequired === true);
}

function permissionRequestHasEncryptedReadScopes(permissionRequest: ConnectPermissionRequest): boolean {
  return hasEncryptedProtocolTypes(permissionRequest.protocolDefinition) &&
    permissionRequest.permissionScopes.some(isConnectReadScope);
}

function validatePermissionRequestProtocolUris(permissionRequests: ConnectPermissionRequest[]): void {
  for (const { protocolDefinition, permissionScopes } of permissionRequests) {
    const grantsMatchProtocolUri = permissionScopes.every(
      scope => 'protocol' in scope && scope.protocol === protocolDefinition.protocol
    );
    if (!grantsMatchProtocolUri) {
      throw new Error('All permission scopes must match the protocol URI they are provided with.');
    }
  }
}

function resolvePreSuppliedDelegateDid(delegateDid: string | undefined): string | undefined {
  if (delegateDid === undefined) {
    return undefined;
  }

  if (delegateDid.trim() === '' || delegateDid.trim() !== delegateDid) {
    throw new Error('Connect delegateDid must be a non-empty DID URI.');
  }

  const parsedDelegateDid = Did.parse(delegateDid);
  if (parsedDelegateDid === null || parsedDelegateDid.uri !== delegateDid) {
    throw new Error('Connect delegateDid must be a valid DID URI.');
  }

  return delegateDid;
}

function resolveConnectPermissionGrantOptions(
  options?: ConnectPermissionGrantOptions,
): { dateExpires: string; connectSession: ConnectSessionMetadata } {
  if (options?.dateExpires && options.connectSession?.expiresAt && options.dateExpires !== options.connectSession.expiresAt) {
    throw new Error('Connect grant dateExpires must match connectSession.expiresAt.');
  }

  const connectSession = options?.connectSession ?? createConnectSessionMetadata({
    expiresAt: options?.dateExpires,
  });
  return {
    dateExpires: options?.dateExpires ?? connectSession.expiresAt,
    connectSession,
  };
}

/**
 * Creates permission grants that assign the requested scopes to a delegate DID.
 */
async function createPermissionGrants(
  selectedDid: string,
  delegateDid: string,
  agent: EnboxPlatformAgent,
  scopes: DwnPermissionScope[],
  options?: ConnectPermissionGrantOptions,
): Promise<DwnDataEncodedRecordsWriteMessage[]> {
  const permissionsApi = new AgentPermissionsApi({ agent });
  const { dateExpires, connectSession } = resolveConnectPermissionGrantOptions(options);

  logger.log(`Creating permission grants for ${scopes.length} scopes...`);
  for (const scope of scopes) {
    assertConnectGrantScope(scope);
  }

  const permissionGrants = await Promise.all(
    scopes.map((scope) => {
      const delegated = shouldUseDelegatePermission(scope);

      return permissionsApi.createGrant({
        delegated,
        store     : true,
        grantedTo : delegateDid,
        scope,
        dateExpires,
        author    : selectedDid,
        connectSession,
      });
    })
  );

  // Resolve all DWN endpoints for the selected DID.  `sendDwnRequest` only
  // sends to the first reachable endpoint, but the sync engine may connect
  // to a different one and needs the grant to authenticate.  We send each
  // grant to every endpoint so that sync works regardless of which DWN the
  // agent contacts first.
  const dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
  logger.log(`Sending ${permissionGrants.length} permission grants to ${dwnEndpointUrls.length} DWN endpoint(s)...`);

  const batchSignal = AbortSignal.timeout(CONNECT_PERMISSION_GRANT_BATCH_TIMEOUT_MS);
  const outcomesByEndpoint = await mapConcurrent(
    dwnEndpointUrls,
    CONNECT_FANOUT_CONCURRENCY,
    async (dwnUrl) => {
      const outcomes: PermissionGrantSendOutcome[] = [];

      // SQL-backed DWNs serialize same-tenant writes to assign replication
      // positions. Keep one active write per endpoint so requests do not
      // consume their timeout while queued behind sibling grants.
      for (let grantIndex = 0; grantIndex < permissionGrants.length; grantIndex++) {
        if (batchSignal.aborted) {
          appendSkippedGrantOutcomes(outcomes, grantIndex, permissionGrants.length, dwnUrl, 'the grant batch timed out');
          break;
        }

        const { encodedData, ...rawMessage } = permissionGrants[grantIndex].message;
        const data = Convert.base64Url(encodedData).toUint8Array();
        const requestSignal = AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS);
        try {
          const reply = await agent.rpc.sendDwnRequest({
            dwnUrl,
            targetDid : selectedDid,
            message   : rawMessage,
            data      : new Blob([data as BlobPart]),
            signal    : AbortSignal.any([batchSignal, requestSignal]),
          });
          const accepted = reply.status.code === 202 || reply.status.code === 409;
          outcomes.push({
            accepted,
            detail: `returned ${reply.status.code}: ${reply.status.detail}`,
            dwnUrl,
            grantIndex,
          });
        } catch (reason) {
          const detail = batchSignal.aborted
            ? `permission grant batch timed out after ${CONNECT_PERMISSION_GRANT_BATCH_TIMEOUT_MS}ms`
            : requestSignal.aborted
              ? `permission grant request timed out after ${CONNECT_REQUEST_TIMEOUT_MS}ms`
              : errorDetail(reason);
          outcomes.push({
            accepted : false,
            detail   : `failed: ${detail}`,
            dwnUrl,
            grantIndex,
          });
        }
      }

      return outcomes;
    },
  );
  const outcomes = outcomesByEndpoint.flat();

  // Aggregate results back per grant: each grant must have at least one
  // endpoint accept it (status 202 or 409 — already-stored is acceptable).
  const successPerGrant = new Array<boolean>(permissionGrants.length).fill(false);
  for (const outcome of outcomes) {
    if (outcome.accepted) {
      successPerGrant[outcome.grantIndex] = true;
      continue;
    }
    logger.error(`Grant send to ${outcome.dwnUrl} ${outcome.detail}`);
  }

  for (let g = 0; g < permissionGrants.length; g++) {
    if (!successPerGrant[g]) {
      const scope = describePermissionScope(scopes[g]);
      const failures = outcomes
        .filter((outcome) => outcome.grantIndex === g && !outcome.accepted)
        .map((outcome) => `${outcome.dwnUrl} ${outcome.detail}`);
      const displayedFailures = failures.slice(0, 3).join('; ');
      const remainingFailureCount = failures.length - 3;
      const failureSummary = failures.length === 0
        ? 'no DWN endpoints were resolved'
        : remainingFailureCount > 0
          ? `${displayedFailures}; ${remainingFailureCount} more endpoint(s) failed`
          : displayedFailures;
      throw new Error(
        `Could not send permission grant to any DWN endpoint: grant ${g + 1} (${scope}); ${failureSummary}`,
      );
    }
  }

  return permissionGrants.map((g) => g.message);
}

type PermissionGrantSendOutcome = {
  accepted : boolean;
  detail : string;
  dwnUrl : string;
  grantIndex : number;
};

function appendSkippedGrantOutcomes(
  outcomes: PermissionGrantSendOutcome[],
  startIndex: number,
  grantCount: number,
  dwnUrl: string,
  reason: string,
): void {
  for (let grantIndex = startIndex; grantIndex < grantCount; grantIndex++) {
    outcomes.push({
      accepted : false,
      detail   : `was not attempted because ${reason}`,
      dwnUrl,
      grantIndex,
    });
  }
}

function describePermissionScope(scope: DwnPermissionScope): string {
  const protocol = 'protocol' in scope ? scope.protocol : undefined;
  const protocolPath = 'protocolPath' in scope ? scope.protocolPath : undefined;
  return [
    `${scope.interface}.${scope.method}`,
    typeof protocol === 'string' ? `protocol ${protocol}` : undefined,
    typeof protocolPath === 'string' ? `path ${protocolPath}` : undefined,
  ].filter((part): part is string => part !== undefined).join(', ');
}

function errorDetail(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

async function fanOutDataEncodedRecords(
  ownerDid: string,
  agent: EnboxPlatformAgent,
  records: DwnDataEncodedRecordsWriteMessage[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(ownerDid);
  const sendTasks = records.flatMap((record, recordIndex) => {
    const { encodedData, ...rawMessage } = record;
    const data = Convert.base64Url(encodedData).toUint8Array();
    return dwnEndpointUrls.map((dwnUrl) => ({ recordIndex, dwnUrl, rawMessage, data }));
  });

  const settled = await mapConcurrentSettled(
    sendTasks,
    CONNECT_FANOUT_CONCURRENCY,
    async ({ recordIndex, dwnUrl, rawMessage, data }) => {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : ownerDid,
        message   : rawMessage,
        data      : new Blob([data as BlobPart]),
        signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
      });
      return { recordIndex, dwnUrl, reply };
    },
  );

  const successPerRecord = new Array<boolean>(records.length).fill(false);
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error(`Record send to ${sendTasks[i].dwnUrl} failed: ${reason}`);
      continue;
    }

    const { recordIndex, dwnUrl, reply } = result.value;
    if (reply.status.code === 202 || reply.status.code === 409) {
      successPerRecord[recordIndex] = true;
    } else {
      logger.error(`Record send to ${dwnUrl} returned ${reply.status.code}: ${reply.status.detail}`);
    }
  }

  for (let i = 0; i < successPerRecord.length; i++) {
    if (!successPerRecord[i]) {
      throw new Error('Could not send grantKey record to any DWN endpoint.');
    }
  }
}

// ---------------------------------------------------------------------------
// Protocol installation
// ---------------------------------------------------------------------------

/**
 * Ensures the protocol is installed on the provider's local DWN so that the
 * agent can sign and (when applicable) encrypt grants for it during
 * `submitConnectResponse`.
 *
 * Remote installation (push to every owner DWN endpoint) is the
 * responsibility of the calling client (the wallet's own `prepareProtocol`
 * runs *before* `submitConnectResponse` and fans out to every endpoint in
 * parallel). When the protocol already exists locally — the common case —
 * this function performs a single local `ProtocolsQuery` and returns: there
 * is no remote send, so a slow/unhealthy DWN endpoint cannot block the
 * "Authorizing…" hot path.
 *
 * When the protocol is *not* installed locally — a safety fallback for
 * callers that did not pre-install — the protocol is configured locally
 * (with `encryption: true` when any type declares `encryptionRequired: true`,
 * so the agent injects `$keyAgreement` keys derived from the owner's X25519
 * root key) and then fanned out to every owner DWN endpoint with bounded
 * concurrency and a short per-request budget. Endpoint failures are
 * non-fatal — sync delivers any missing copies eventually.
 */
async function prepareProtocol(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition
): Promise<void> {
  const queryMessage = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ProtocolsQuery,
    target        : selectedDid,
    messageParams : { filter: { protocol: protocolDefinition.protocol } },
  });

  if (queryMessage.reply.status.code !== 200) {
    throw new Error(`Could not fetch protocol: ${queryMessage.reply.status.detail}`);
  }

  const isInstalledLocally = queryMessage.reply.entries !== undefined
    && queryMessage.reply.entries.length > 0;

  if (isInstalledLocally) {
    // Already installed locally. The wallet's pre-call `prepareProtocol`
    // is responsible for fanning the protocol out to every owner DWN
    // endpoint; sync delivers any missing copies eventually. Skipping the
    // remote send here turns this hot path into a single local DB read
    // (~10 ms) instead of a sequential per-endpoint network round-trip
    // with retries — the latter could take minutes if any endpoint was
    // slow or unreachable.
    logger.log(`Protocol already installed locally: ${protocolDefinition.protocol}`);
    return;
  }

  // Safety fallback — protocol is missing locally, so the caller did not
  // pre-install. Configure it locally (with encryption derivation if any
  // type requires it) so the agent can sign/encrypt grants, then push to
  // every owner DWN endpoint in parallel with a short per-request budget.
  logger.log(`Protocol not installed, configuring locally: ${protocolDefinition.protocol}`);
  const needsEncryption = Object.values(protocolDefinition.types ?? {})
    .some((type: any) => type?.encryptionRequired === true);

  const { reply: configureReply, message: configureMessage } = await agent.processDwnRequest({
    author        : selectedDid,
    target        : selectedDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: protocolDefinition },
    encryption    : needsEncryption || undefined,
  });

  if (configureReply.status.code !== 202 && configureReply.status.code !== 409) {
    throw new Error(`Could not configure protocol locally: ${configureReply.status.detail}`);
  }

  let dwnEndpointUrls: string[] = [];
  try {
    dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
  } catch {
    // Endpoint resolution failure — protocol stays local-only until sync.
  }

  if (dwnEndpointUrls.length === 0) {
    return;
  }

  // Best-effort remote fan-out with bounded concurrency and a per-request
  // abort signal. Failures are tolerated (sync delivers eventually).
  await mapConcurrentSettled(
    dwnEndpointUrls,
    CONNECT_FANOUT_CONCURRENCY,
    (dwnUrl) => agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : selectedDid,
      message   : configureMessage!,
      signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
    }),
  );
}

// ---------------------------------------------------------------------------
// Full wallet-side flow (provider submits response)
// ---------------------------------------------------------------------------

/**
 * Executes the full wallet-side (provider) flow:
 * 1. Uses a requester-supplied delegate DID, or creates one when omitted
 * 2. Installs requested protocols
 * 3. Creates permission grants
 * 4. Builds, signs, and encrypts the response
 * 5. POSTs the encrypted response to the callback URL
 *
 * @param selectedDid - The provider's DID that is granting access.
 * @param connectRequest - The decoded connect request from the app.
 * @param pin - The PIN for response encryption AAD (required for remote flows).
 * @param agent - The agent instance for DWN operations.
 */
async function submitConnectResponse(
  selectedDid: string,
  connectRequest: EnboxConnectRequest,
  pin: string | undefined,
  agent: EnboxPlatformAgent
): Promise<void> {
  const submitStart = nowMs();
  const numProtocols = connectRequest.permissionRequests.length;
  const numScopes = connectRequest.permissionRequests.reduce(
    (sum, req) => sum + req.permissionScopes.length,
    0,
  );
  // Tracked across the try/finally so the aggregate `submitConnectResponse.total`
  // log emits on both success and failure paths — operators bisecting wall-time
  // from wallet debug logs need the total even when a phase throws.
  let sessionGrantCount = 0;
  let outcome: 'ok' | 'fail' = 'ok';
  logger.log(
    `${CONNECT_PERF_LOG_PREFIX} submitConnectResponse.start `
    + `(protocols=${numProtocols}, scopes=${numScopes})`,
  );

  try {
    const sessionTtlSeconds = resolveRequestedSessionTtlSeconds(connectRequest.requestedSessionTtlSeconds);
    const preSuppliedDelegateDid = resolvePreSuppliedDelegateDid(connectRequest.delegateDid);

    let delegatePortableDid: PortableDid | undefined;
    let delegateRootPrivateKey: PrivateKeyJwk | undefined;
    let responseBearerDid: BearerDid;
    let grantedDelegateDid: string;

    if (preSuppliedDelegateDid !== undefined) {
      grantedDelegateDid = preSuppliedDelegateDid;
      responseBearerDid = await timed(`${CONNECT_PERF_LOG_PREFIX} responseDid.create`, () => DidJwk.create());
    } else {
      const delegateBearerDid = await timed(`${CONNECT_PERF_LOG_PREFIX} delegateDid.create`, () => DidJwk.create());
      delegatePortableDid = await delegateBearerDid.export();

      // Add X25519 key derived from the delegate's Ed25519 key.
      // did:jwk only supports one verification method, but DWN encryption
      // requires X25519 for key agreement. Including the derived X25519
      // private key in the PortableDid ensures the delegate agent's KMS
      // has both keys after import. The Ed25519→X25519 conversion is a
      // standard cryptographic operation (RFC 8032 / libsodium).
      const delegateEdPrivateKey = delegatePortableDid.privateKeys![0];
      delegateRootPrivateKey = await Ed25519.convertPrivateKeyToX25519({
        privateKey: delegateEdPrivateKey,
      }) as PrivateKeyJwk;
      delegatePortableDid.privateKeys!.push(delegateRootPrivateKey);
      responseBearerDid = delegateBearerDid;
      grantedDelegateDid = delegateBearerDid.uri;
    }

    validatePermissionRequestProtocolUris(connectRequest.permissionRequests);

    const preSuppliedDelegateRootPublicKey = preSuppliedDelegateDid !== undefined &&
      connectRequest.permissionRequests.some(permissionRequestHasEncryptedReadScopes)
      ? (await timed(
        `${CONNECT_PERF_LOG_PREFIX} delegateDid.encryptionKey.resolve`,
        () => getEncryptionKeyInfo(agent, grantedDelegateDid),
      )).publicKeyJwk
      : undefined;

    const connectSession = createConnectSessionMetadata({
      appName        : connectRequest.appName,
      appIcon        : connectRequest.appIcon,
      ttlSeconds     : sessionTtlSeconds,
      clientMetadata : connectRequest.clientMetadata,
      transport      : 'relay',
    });

    const grantSetup = await timed(
      `${CONNECT_PERF_LOG_PREFIX} permissionGrants.fanout (protocols=${numProtocols})`,
      async () => {
        await Promise.all(connectRequest.permissionRequests.map(
          ({ protocolDefinition }) => prepareProtocol(selectedDid, agent, protocolDefinition)
        ));

        const permissionScopes = connectRequest.permissionRequests.flatMap((request) => request.permissionScopes);
        const createdGrants = await EnboxConnectProtocol.createPermissionGrants(
          selectedDid,
          grantedDelegateDid,
          agent,
          permissionScopes,
          { connectSession },
        );

        let grantOffset = 0;
        const requestsWithGrants = connectRequest.permissionRequests.map((permissionRequest) => {
          const nextGrantOffset = grantOffset + permissionRequest.permissionScopes.length;
          const grants = createdGrants.slice(grantOffset, nextGrantOffset);
          grantOffset = nextGrantOffset;
          return { grants, permissionRequest };
        });

        const durableGrantKeyRecords = (await Promise.all(requestsWithGrants.map(
          async ({ grants, permissionRequest }) => {
            const { protocolDefinition, permissionScopes: requestScopes } = permissionRequest;
            const hasEncryptedTypes = hasEncryptedProtocolTypes(protocolDefinition);
            const hasEncryptedReadScopes = hasEncryptedTypes && requestScopes.some(isConnectReadScope);
            if (!hasEncryptedReadScopes) {
              return [];
            }

            return EnboxConnectProtocol.createGrantKeyRecordsForGrants({
              agent,
              ownerDid   : selectedDid,
              granteeDid : grantedDelegateDid,
              ...(delegateRootPrivateKey !== undefined
                ? { granteeRootPrivateKey: delegateRootPrivateKey }
                : { granteeRootPublicKey: preSuppliedDelegateRootPublicKey }),
              grantMessages       : grants,
              protocolDefinitions : [protocolDefinition],
            });
          }
        ))).flat();

        // Revocation grants are appended later; preserve the grant creator's
        // returned array as the previous per-protocol flattening did.
        return { delegateGrants: [...createdGrants], durableGrantKeyRecords };
      },
    );
    const { delegateGrants, durableGrantKeyRecords } = grantSetup;

    await timed(
      `${CONNECT_PERF_LOG_PREFIX} grantKeys.fanout (n=${durableGrantKeyRecords.length})`,
      () => fanOutDataEncodedRecords(selectedDid, agent, durableGrantKeyRecords),
    );

    // Create per-grant contextId-scoped revocation grants.
    // Each revocation grant authorizes the delegate to write a revocation
    // ONLY for the specific session grant it corresponds to.
    const permissionsApi = new AgentPermissionsApi({ agent });
    const sessionRevocations: { grantId: string; revocationGrantId: string }[] = [];
    let revGrantEndpoints: string[] = [];
    try {
      revGrantEndpoints = await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
    } catch {
      // Endpoint resolution failure — revocation grants will be local-only until sync.
    }

    // Snapshot the current length — revocation grants are appended to delegateGrants
    // below, but we must NOT iterate over them (they are meta-grants, not session grants).
    sessionGrantCount = delegateGrants.length;

    // Create all revocation grants locally with bounded concurrency.
    // createGrant is local-only (storage + signing) so it's cheap, but we still
    // cap parallelism to avoid head-of-line blocking when sessionGrantCount is
    // large (e.g. dapp requesting many scopes at once).
    // Revocation grants share the same hard expiry but do not duplicate
    // connectSession display metadata; session grouping should use the
    // user-facing permission grants.
    const revGrantResults = await timed(
      `${CONNECT_PERF_LOG_PREFIX} revocationGrants.create (n=${sessionGrantCount})`,
      () => mapConcurrent(
        delegateGrants.slice(0, sessionGrantCount),
        CONNECT_FANOUT_CONCURRENCY,
        (grantMessage) =>
          permissionsApi.createGrant({
            delegated : true,
            store     : true,
            grantedTo : grantedDelegateDid,
            scope     : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              protocol  : PermissionsProtocol.uri,
              contextId : grantMessage.recordId,
            },
            dateExpires : connectSession.expiresAt,
            author      : selectedDid,
          }).then((revGrant) => ({ grantMessage, revGrant })),
      ),
    );

    // Fan out every revocation grant to every owner DWN endpoint with a single
    // global concurrency cap so that (grants × endpoints) cannot blow up. This
    // is best-effort (sync delivers eventually) so individual failures are
    // tolerated by `mapConcurrentSettled`.
    const revSendTasks = revGrantResults.flatMap(({ grantMessage, revGrant }) => {
      sessionRevocations.push({
        grantId           : grantMessage.recordId,
        revocationGrantId : revGrant.message.recordId,
      });

      const { encodedData: revEncoded, ...revRawMessage } = revGrant.message;
      const revData = Uint8Array.from(Convert.base64Url(revEncoded).toUint8Array());

      // Include the revocation grant in the delegate grants for distribution.
      delegateGrants.push(revGrant.message);

      return revGrantEndpoints.map((dwnUrl) => ({ revRawMessage, revData, dwnUrl }));
    });

    if (revSendTasks.length > 0) {
      await timed(
        `${CONNECT_PERF_LOG_PREFIX} revocationGrants.fanout (sends=${revSendTasks.length}, endpoints=${revGrantEndpoints.length})`,
        () => mapConcurrentSettled(
          revSendTasks,
          CONNECT_FANOUT_CONCURRENCY,
          ({ revRawMessage, revData, dwnUrl }) =>
            agent.rpc.sendDwnRequest({
              dwnUrl,
              targetDid : selectedDid,
              message   : revRawMessage,
              data      : new Blob([revData]),
              signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
            }),
        ),
      );
    }

    const responseObject = await timed(
      `${CONNECT_PERF_LOG_PREFIX} response.build`,
      () => EnboxConnectProtocol.createConnectResponse({
        providerDid        : selectedDid,
        delegateDid        : grantedDelegateDid,
        aud                : connectRequest.clientDid,
        nonce              : connectRequest.nonce,
        delegateGrants,
        delegatePortableDid,
        sessionRevocations : sessionRevocations.length > 0 ? sessionRevocations : undefined,
      }),
    );

    const responseObjectJwt = await timed(
      `${CONNECT_PERF_LOG_PREFIX} response.sign`,
      () => EnboxConnectProtocol.signJwt({
        did  : responseBearerDid,
        data : responseObject,
      }),
    );

    const clientDid = await timed(
      `${CONNECT_PERF_LOG_PREFIX} clientDid.resolve`,
      () => DidJwk.resolve(connectRequest.clientDid),
    );

    const sharedKey = await timed(
      `${CONNECT_PERF_LOG_PREFIX} response.deriveSharedKey`,
      () => EnboxConnectProtocol.deriveSharedKey(
        responseBearerDid,
        clientDid?.didDocument!,
      ),
    );

    const encryptedResponse = await timed(
      `${CONNECT_PERF_LOG_PREFIX} response.encrypt`,
      () => EnboxConnectProtocol.encryptResponse({
        jwt                  : responseObjectJwt,
        encryptionKey        : sharedKey,
        delegatePublicKeyJwk : responseBearerDid.document.verificationMethod![0].publicKeyJwk!,
        pin,
      }),
    );

    const formEncodedRequest = new URLSearchParams({
      id_token : encryptedResponse,
      state    : connectRequest.state,
    }).toString();

    await timed(
      `${CONNECT_PERF_LOG_PREFIX} response.callbackPost`,
      async () => {
        const response = await fetch(connectRequest.callbackUrl, {
          body    : formEncodedRequest,
          method  : 'POST',
          headers : {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          // NOTE: delegate grants have already been written/fanned out by this
          // point, so callers may observe partial owner-side state when the
          // callback server rejects the final response delivery.
          throw new Error(`Connect: callback POST failed with HTTP ${response.status}.`);
        }

        return response;
      },
    );
  } catch (err) {
    outcome = 'fail';
    throw err;
  } finally {
    const totalElapsed = nowMs() - submitStart;
    logger.log(
      `${CONNECT_PERF_LOG_PREFIX} submitConnectResponse.total ${outcome} in ${totalElapsed.toFixed(1)}ms `
      + `(protocols=${numProtocols}, scopes=${numScopes}, sessionGrants=${sessionGrantCount})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

export const EnboxConnectProtocol = {
  buildConnectUrl,
  buildWalletConnectUri,
  parseWalletConnectUri,
  signJwt,
  verifyJwt,
  assertConnectRequest,
  assertConnectResponse,
  encryptRequest,
  decryptRequest,
  encryptResponse,
  decryptResponse,
  deriveSharedKey,
  createConnectRequest,
  getConnectRequest,
  createConnectResponse,
  createConnectSessionMetadata,
  createPermissionGrants,
  createGrantKeyRecordsForGrants: createGrantKeyRecordsForGrantsFn,
  submitConnectResponse,
};
