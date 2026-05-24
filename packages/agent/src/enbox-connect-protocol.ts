/**
 * Enbox Connect Protocol
 *
 * A capability delegation protocol for DWN access. Enables apps to request
 * scoped permission grants from a wallet (provider), receiving a delegate DID
 * with the granted permissions.
 *
 * Two transport modes:
 * - Local (`dwn://connect`): same-device, direct HTTP against the local DWN
 * - Remote (`enbox://connect`): cross-device, relay-mediated with QR/deep link
 *
 * The protocol uses JWTs for signing, JWE (XChaCha20-Poly1305) for encryption,
 * and ECDH (Ed25519 → X25519 + HKDF) for key agreement.
 */

import type { DerivedPrivateJwk } from '@enbox/dwn-sdk-js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { PrivateKeyJwk } from '@enbox/crypto';
import type { RequireOnly } from '@enbox/common';
import type { DidDocument, PortableDid } from '@enbox/dids';
import type { DwnDataEncodedRecordsWriteMessage, DwnPermissionScope, DwnProtocolDefinition, DwnRecordsPermissionScope } from './types/dwn.js';

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
 * A scope-aware decryption key delivered to delegates during the connect flow.
 *
 * Two scope kinds:
 *
 * - **`protocol`** — protocol-wide key at depth `[ProtocolPath, protocolUri]`.
 *   Can derive leaf keys for any type path within the protocol.
 *   Issued when the grant covers the entire protocol (no `protocolPath`).
 *
 * - **`protocolPath`** — exact-path key at depth
 *   `[ProtocolPath, protocolUri, ...pathSegments]`.
 *   Can only decrypt records at that exact path — not siblings or descendants.
 *   Issued when the grant is narrowed to a specific `protocolPath`.
 *
 * Common conditions (both kinds):
 * 1. The protocol has `encryptionRequired: true` types (single-party only)
 * 2. The delegate has at least one read-like scope (Read/Query/Subscribe)
 * 3. The protocol does NOT use multi-party / role-based access patterns
 *
 * Out of scope (fail closed):
 * - `contextId`-scoped encrypted delegate reads
 * - multi-party / ProtocolContext encrypted delegate reads
 */
export type DelegateDecryptionKey =
  | {
    /** The protocol URI this key is scoped to. */
    protocol: string;
    /** Protocol-wide decryption scope. */
    scope: { kind: 'protocol' };
    /** The derived private key material for ProtocolPath decryption. */
    derivedPrivateKey: DerivedPrivateJwk;
  }
  | {
    /** The protocol URI this key is scoped to. */
    protocol: string;
    /** Exact-path decryption scope — siblings and descendants are NOT accessible. */
    scope: { kind: 'protocolPath'; protocolPath: string; match: 'exact' };
    /** The derived private key material for ProtocolPath decryption. */
    derivedPrivateKey: DerivedPrivateJwk;
  };

/**
 * A context-scoped decryption key for a multi-party encrypted protocol.
 *
 * Delivered to delegates during the connect flow so they can decrypt
 * ProtocolContext-encrypted records without the owner's root X25519 key.
 *
 * Each key is scoped to one rootContextId — it unlocks all records within
 * that context domain but cannot access other contexts in the protocol.
 *
 * Delivered only when:
 * 1. The protocol has multi-party access patterns (detected by `isMultiPartyContext`)
 * 2. The delegate has a protocol-wide read-like scope (no protocolPath/contextId)
 * 3. The protocol has `encryptionRequired: true` types
 */
export type DelegateContextKey = {
  /** The protocol URI this key belongs to. */
  protocol: string;
  /** The root context ID this key unlocks. */
  contextId: string;
  /** The derived private key at `[ProtocolContext, rootContextId]`. */
  derivedPrivateKey: DerivedPrivateJwk;
};

import type {
  JoseHeaderParams,
  Jwk } from '@enbox/crypto';

import { type BearerDid, DidJwk } from '@enbox/dids';
import { concatenateUrl, Convert, logger } from '@enbox/common';
import {
  CryptoUtils,
  Ed25519,
  EdDsaAlgorithm,
  Hkdf,
  X25519,
  XChaCha20Poly1305,
} from '@enbox/crypto';
import { DwnInterfaceName, DwnMethodName, HdKey, KeyDerivationScheme, PermissionsProtocol } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnInterface } from './types/dwn.js';
import { getEncryptionKeyInfo } from './dwn-encryption.js';
import { isMultiPartyContext } from './protocol-utils.js';
import { isRecordPermissionScope } from './dwn-api.js';
import { KeyDeliveryProtocolDefinition } from './store-data-protocols.js';
import { mapConcurrent, mapConcurrentSettled } from './utils.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Maximum number of in-flight DWN-endpoint sends issued by the connect flow
 * (permission grants + revocation grants). Caps total concurrency across all
 * `(grant, endpoint)` pairs so that a request with many permissions and/or a
 * tenant with many DWN endpoints cannot stampede the network. Tuned to be
 * generous enough to hide endpoint latency while staying well under typical
 * per-host browser connection limits and server-side rate limits.
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
 * Sync delivers any missed copies eventually, so aborting fast is safe:
 * the connect-flow fan-outs are best-effort and tolerate per-task failure.
 */
const CONNECT_REQUEST_TIMEOUT_MS = 10_000;

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

  /** The newly created delegate DID identifier. */
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

  /** The delegate DID's full portable form, including private keys. */
  delegatePortableDid: PortableDid;

  /**
   * Scope-aware decryption keys for encrypted protocols.
   *
   * Derived only for read-like permission scopes (Read/Query/Subscribe) on
   * protocols with `encryptionRequired: true` types. Write-only delegates
   * receive no decryption keys.
   */
  delegateDecryptionKeys?: DelegateDecryptionKey[];

  /**
   * Context-scoped decryption keys for multi-party encrypted protocols.
   *
   * Derived at connect time for each existing rootContextId in multi-party
   * protocols where the delegate has a protocol-wide read-like scope.
   * Each key is scoped to `[ProtocolContext, rootContextId]` and can decrypt
   * all records within that context domain.
   *
   * Contexts created after connect are delivered automatically by
   * `postWriteKeyDelivery()` when the owner creates a new multi-party root
   * record on the same agent instance (same-process delivery).
   * Cross-device delivery is a documented follow-up.
   */
  delegateContextKeys?: DelegateContextKey[];

  /**
   * Protocol URIs that have multi-party encrypted access patterns.
   *
   * Delivered even when no contexts exist yet (cold-start), so the
   * delegate's agent can register for future context key delivery.
   */
  delegateMultiPartyProtocols?: string[];

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

function requireArray(payload: Record<string, unknown>, field: string, context: string): void {
  if (!Array.isArray(payload[field])) { fail(context, field, 'must be an array'); }
}

function requireObject(payload: Record<string, unknown>, field: string, context: string): void {
  const value = payload[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(context, field, 'must be an object');
  }
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
  requireObject(payload, 'delegatePortableDid', ctx);
  requireOptionalArray(payload, 'delegateDecryptionKeys', ctx);
  requireOptionalArray(payload, 'delegateContextKeys', ctx);
  requireOptionalArray(payload, 'delegateMultiPartyProtocols', ctx);
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
    'providerDid' | 'delegateDid' | 'aud' | 'delegateGrants' | 'delegatePortableDid'
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

function shouldUseDelegatePermission(scope: DwnPermissionScope): boolean {
  if (isRecordPermissionScope(scope)) {
    return true;
  } else if (scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Configure) {
    return true;
  }
  return false;
}

/**
 * Creates permission grants that assign the requested scopes to a delegate DID.
 */
async function createPermissionGrants(
  selectedDid: string,
  delegateBearerDid: BearerDid,
  agent: EnboxPlatformAgent,
  scopes: DwnPermissionScope[],
  delegateKeyDeliveryData?: { rootKeyId: string; publicKeyJwk: Record<string, any> },
): Promise<DwnDataEncodedRecordsWriteMessage[]> {
  const permissionsApi = new AgentPermissionsApi({ agent });

  logger.log(`Creating permission grants for ${scopes.length} scopes...`);
  const permissionGrants = await Promise.all(
    scopes.map((scope) => {
      const delegated = shouldUseDelegatePermission(scope);

      // Attach delegate key-delivery tags to read-like grants so the
      // owner can encrypt future contextKey records to the delegate.
      const readMethods = new Set([
        DwnMethodName.Read, DwnMethodName.Query, DwnMethodName.Subscribe,
      ]);
      const isReadLike = isRecordPermissionScope(scope)
        && readMethods.has(scope.method as DwnMethodName);
      const delegateKeyDelivery = (isReadLike && delegateKeyDeliveryData) ? delegateKeyDeliveryData : undefined;

      return permissionsApi.createGrant({
        delegated,
        store       : true,
        grantedTo   : delegateBearerDid.uri,
        scope,
        dateExpires : '2040-06-25T16:09:16.693356Z', // TODO: make dateExpires configurable
        author      : selectedDid,
        delegateKeyDelivery,
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

  // Flatten (grant, endpoint) tuples into a single list of sends so that one
  // global concurrency cap governs total in-flight requests during the
  // connect flow — important when either dimension grows large.
  const sendTasks = permissionGrants.flatMap((grant, grantIndex) => {
    const { encodedData, ...rawMessage } = grant.message;
    const data = Convert.base64Url(encodedData).toUint8Array();
    return dwnEndpointUrls.map((dwnUrl) => ({ grantIndex, dwnUrl, rawMessage, data }));
  });

  const settled = await mapConcurrentSettled(
    sendTasks,
    CONNECT_FANOUT_CONCURRENCY,
    async ({ grantIndex, dwnUrl, rawMessage, data }) => {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : selectedDid,
        message   : rawMessage,
        data      : new Blob([data as BlobPart]),
        signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
      });
      return { grantIndex, dwnUrl, reply };
    },
  );

  // Aggregate results back per grant: each grant must have at least one
  // endpoint accept it (status 202 or 409 — already-stored is acceptable).
  const successPerGrant = new Array<boolean>(permissionGrants.length).fill(false);
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error(`Grant send to ${sendTasks[i].dwnUrl} failed: ${reason}`);
      continue;
    }
    const { grantIndex, dwnUrl, reply } = result.value;
    if (reply.status.code === 202 || reply.status.code === 409) {
      successPerGrant[grantIndex] = true;
    } else {
      logger.error(`Grant send to ${dwnUrl} returned ${reply.status.code}: ${reply.status.detail}`);
    }
  }

  for (let g = 0; g < permissionGrants.length; g++) {
    if (!successPerGrant[g]) {
      logger.error(`Error during batch-send of permission grants: grant ${g} reached no DWN endpoint.`);
      throw new Error('Could not send permission grant to any DWN endpoint.');
    }
  }

  return permissionGrants.map((g) => g.message);
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
 * so the agent injects `$encryption` keys derived from the owner's X25519
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

/**
 * Derives the minimal set of decryption keys implied by read-like permission
 * scopes for a single-party encrypted protocol.
 *
 * Rules:
 *   - Only Records.Read / Records.Query / Records.Subscribe scopes contribute.
 *   - Write / Delete / Count scopes produce no decryption keys.
 *   - If any unrestricted (no `protocolPath`) read scope exists, one
 *     protocol-wide key is emitted and narrower keys are dropped.
 *   - Otherwise one exact-path key is emitted per unique `protocolPath`.
 *   - Scopes with `contextId` cause a fail-closed error.
 *   - Multi-party protocols cause a fail-closed error.
 *
 * @param agent - The platform agent (must hold the owner's KMS keys)
 * @param ownerDid - The DID of the protocol owner
 * @param protocolUri - The protocol URI
 * @param scopes - The permission scopes for this protocol
 * @param protocolDefinition - The protocol definition (for multi-party detection)
 * @returns An array of `DelegateDecryptionKey` (may be empty)
 */
async function deriveScopedDecryptionKeys(
  agent: EnboxPlatformAgent,
  ownerDid: string,
  protocolUri: string,
  scopes: DwnPermissionScope[],
  protocolDefinition: DwnProtocolDefinition,
): Promise<DelegateDecryptionKey[]> {
  const readMethods = new Set([
    DwnMethodName.Read, DwnMethodName.Query, DwnMethodName.Subscribe,
  ]);

  // Collect read-like scopes only. `isRecordPermissionScope` narrows to
  // `DwnRecordsPermissionScope`, which declares `protocolPath?: string`
  // and `contextId?: string` — no `as any` needed for those reads below.
  const readScopes = scopes.filter(
    (s): s is DwnRecordsPermissionScope =>
      isRecordPermissionScope(s) && readMethods.has(s.method),
  );

  if (readScopes.length === 0) {
    return []; // write/delete only → no decryption keys
  }

  // Fail closed: reject contextId-scoped encrypted reads.
  for (const scope of readScopes) {
    if (scope.contextId) {
      throw new Error(
        `Encrypted delegate access scoped by contextId is not supported ` +
        `yet; use protocol-wide permissions for protocol '${protocolUri}'.`,
      );
    }
  }

  // Defense-in-depth: reject if any root is multi-party.
  // The caller should have already routed multi-party protocols to
  // deriveContextKeysForDelegate instead.
  const { multiParty } = classifyProtocolRoots(protocolDefinition);
  if (multiParty.length > 0) {
    throw new Error(
      `deriveScopedDecryptionKeys called for protocol with multi-party ` +
      `roots [${multiParty.join(', ')}]. Use deriveContextKeysForDelegate ` +
      `for multi-party protocols.`,
    );
  }

  // Check if any scope is protocol-wide (no protocolPath).
  const hasProtocolWideRead = readScopes.some((s) => !s.protocolPath);

  const { keyId, keyUri } = await getEncryptionKeyInfo(agent, ownerDid);

  // If any unrestricted read scope exists, emit one protocol-wide key
  // and skip narrower keys (the protocol-wide key subsumes them).
  if (hasProtocolWideRead) {
    const derivationPath = [KeyDerivationScheme.ProtocolPath, protocolUri];
    const derivedBytes = await agent.keyManager.derivePrivateKeyBytes({
      keyUri, derivationPath,
    });
    const derivedJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedBytes });

    return [{
      protocol          : protocolUri,
      scope             : { kind: 'protocol' },
      derivedPrivateKey : {
        rootKeyId         : keyId,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivationPath,
        derivedPrivateKey : derivedJwk as PrivateKeyJwk,
      },
    }];
  }

  // All read scopes are protocolPath-scoped.
  // Emit one exact-path key per unique protocolPath.
  const uniquePaths = new Set<string>();
  for (const scope of readScopes) {
    if (scope.protocolPath) { uniquePaths.add(scope.protocolPath); }
  }

  const keys: DelegateDecryptionKey[] = [];
  for (const protocolPath of uniquePaths) {
    const pathSegments = protocolPath.split('/');
    const derivationPath = [KeyDerivationScheme.ProtocolPath, protocolUri, ...pathSegments];
    const derivedBytes = await agent.keyManager.derivePrivateKeyBytes({
      keyUri, derivationPath,
    });
    const derivedJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedBytes });

    keys.push({
      protocol          : protocolUri,
      scope             : { kind: 'protocolPath', protocolPath, match: 'exact' },
      derivedPrivateKey : {
        rootKeyId         : keyId,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivationPath,
        derivedPrivateKey : derivedJwk as PrivateKeyJwk,
      },
    });
  }

  return keys;
}

/**
 * Detects whether a protocol definition has any root-level type whose subtree
 * triggers multi-party semantics. Delegates to the canonical
 * `isMultiPartyContext()` from `protocol-utils.ts` which checks:
 *
 *   - `$role: true` descendants in the subtree
 *   - Relational `who`/`of` `$actions` rules that grant `read` access
 *
 * These patterns cause the DWN agent to use ProtocolContext encryption at
 * write time, which is not supported in delegate sessions yet.
 */
/**
 * Classifies root-level types in a protocol definition into multi-party
 * and single-party buckets. Used to detect mixed protocols that cannot
 * be safely modeled with a single key type.
 */
function classifyProtocolRoots(
  definition: DwnProtocolDefinition,
): { multiParty: string[]; singleParty: string[] } {
  const structure = definition.structure;
  if (!structure) { return { multiParty: [], singleParty: [] }; }

  const multiParty: string[] = [];
  const singleParty: string[] = [];

  for (const rootTypeName of Object.keys(structure)) {
    if (rootTypeName.startsWith('$')) { continue; }
    if (isMultiPartyContext(definition, rootTypeName)) {
      multiParty.push(rootTypeName);
    } else {
      singleParty.push(rootTypeName);
    }
  }

  return { multiParty, singleParty };
}

/**
 * Derives per-context decryption keys for a delegate's access to a multi-party
 * encrypted protocol. Queries the owner's DWN for all root-level records
 * (thread roots, etc.) and derives a `[ProtocolContext, rootContextId]` key
 * for each.
 *
 * Validates scopes first — only protocol-wide read-like scopes are accepted.
 * `protocolPath`-scoped and `contextId`-scoped reads throw (not yet supported).
 * Write-only scopes return empty (no decryption keys needed).
 *
 * @param agent - The platform agent (must hold the owner's KMS keys)
 * @param ownerDid - The DID of the protocol owner
 * @param protocolDefinition - The protocol definition
 * @param scopes - The permission scopes for this protocol
 * @returns An array of `DelegateContextKey` (may be empty)
 */
async function deriveContextKeysForDelegate(
  agent: EnboxPlatformAgent,
  ownerDid: string,
  protocolDefinition: DwnProtocolDefinition,
  scopes: DwnPermissionScope[],
): Promise<DelegateContextKey[]> {
  const readMethods = new Set([
    DwnMethodName.Read, DwnMethodName.Query, DwnMethodName.Subscribe,
  ]);

  // `isRecordPermissionScope` narrows to `DwnRecordsPermissionScope`,
  // which declares `protocolPath?: string` and `contextId?: string` —
  // no `as any` needed for the field reads below.
  const readScopes = scopes.filter(
    (s): s is DwnRecordsPermissionScope =>
      isRecordPermissionScope(s) && readMethods.has(s.method),
  );

  if (readScopes.length === 0) {
    return []; // write-only → no context keys
  }

  // Fail closed: reject contextId-scoped reads.
  for (const scope of readScopes) {
    if (scope.contextId) {
      throw new Error(
        `Encrypted delegate access scoped by contextId is not supported ` +
        `yet; use protocol-wide permissions for protocol ` +
        `'${protocolDefinition.protocol}'.`,
      );
    }
  }

  // Fail closed: reject protocolPath-scoped reads on multi-party protocols.
  for (const scope of readScopes) {
    if (scope.protocolPath) {
      throw new Error(
        `Encrypted delegate access scoped by protocolPath on multi-party ` +
        `protocols is not supported yet; use protocol-wide permissions for ` +
        `protocol '${protocolDefinition.protocol}'.`,
      );
    }
  }

  // All read scopes are protocol-wide. Derive context keys for each
  // existing root-level context in the protocol.
  const { keyId, keyUri } = await getEncryptionKeyInfo(agent, ownerDid);
  const protocolUri = protocolDefinition.protocol;

  // Find root-level types (non-$ keys in structure).
  const rootTypes = Object.keys(protocolDefinition.structure ?? {})
    .filter((k) => !k.startsWith('$'));

  const contextKeys: DelegateContextKey[] = [];
  const seenContextIds = new Set<string>();

  for (const rootType of rootTypes) {
    // Query all root records for this type.
    const { reply } = await agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: protocolUri, protocolPath: rootType },
      },
    });

    for (const entry of reply.entries ?? []) {
      const rootContextId = entry.contextId?.split('/')[0] ?? entry.recordId;

      if (!rootContextId || seenContextIds.has(rootContextId)) { continue; }
      seenContextIds.add(rootContextId);

      const derivationPath = [KeyDerivationScheme.ProtocolContext, rootContextId];
      const derivedBytes = await agent.keyManager.derivePrivateKeyBytes({
        keyUri, derivationPath,
      });
      const derivedJwk = await X25519.bytesToPrivateKey({
        privateKeyBytes: derivedBytes,
      });

      contextKeys.push({
        protocol          : protocolUri,
        contextId         : rootContextId,
        derivedPrivateKey : {
          rootKeyId         : keyId,
          derivationScheme  : KeyDerivationScheme.ProtocolContext,
          derivationPath,
          derivedPrivateKey : derivedJwk as PrivateKeyJwk,
        },
      });
    }
  }

  return contextKeys;
}

// ---------------------------------------------------------------------------
// Full wallet-side flow (provider submits response)
// ---------------------------------------------------------------------------

/**
 * Executes the full wallet-side (provider) flow:
 * 1. Creates a delegate DID
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
  const delegateBearerDid = await DidJwk.create();
  const delegatePortableDid = await delegateBearerDid.export();

  // Add X25519 key derived from the delegate's Ed25519 key.
  // did:jwk only supports one verification method, but DWN encryption
  // requires X25519 for key agreement. Including the derived X25519
  // private key in the PortableDid ensures the delegate agent's KMS
  // has both keys after import. The Ed25519→X25519 conversion is a
  // standard cryptographic operation (RFC 8032 / libsodium).
  const delegateEdPrivateKey = delegatePortableDid.privateKeys![0];
  const delegateX25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
    privateKey: delegateEdPrivateKey,
  });
  delegatePortableDid.privateKeys!.push(delegateX25519PrivateKey);

  // Derive the delegate's key-delivery ProtocolPath leaf public key.
  // This is the pre-derived key that the owner will use later when writing
  // contextKey records addressed to this delegate. The owner cannot derive
  // this from the delegate's root public key alone (HKDF needs the private
  // key), so we compute it now while we have temporary access to the
  // delegate's private key material.
  const delegateX25519PrivateKeyBytes = await X25519.privateKeyToBytes({
    privateKey: delegateX25519PrivateKey,
  });
  const keyDeliveryDerivationPath = [
    KeyDerivationScheme.ProtocolPath,
    KeyDeliveryProtocolDefinition.protocol,
    'contextKey',
  ];
  const delegateLeafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(
    delegateX25519PrivateKeyBytes, keyDeliveryDerivationPath,
  );
  const delegateLeafPrivateKeyJwk = await X25519.bytesToPrivateKey({
    privateKeyBytes: delegateLeafPrivateKeyBytes,
  });
  const delegateKeyDeliveryLeafPublicKey = await X25519.getPublicKey({
    key: delegateLeafPrivateKeyJwk,
  });

  // The rootKeyId is the delegate's keyAgreement VM id (e.g. `did:jwk:...#0`).
  // For did:jwk this is the Ed25519 VM, but getEncryptionKeyInfo() also returns
  // this same id after Ed25519→X25519 conversion. The DWN SDK matches the JWE
  // `kid` header against the KeyDecrypter's `rootKeyId`, so both sides must use
  // the same id — which they do because both derive from verificationMethod.id
  // of the keyAgreement relationship.
  const delegateKeyAgreementVmId = delegateBearerDid.document.verificationMethod![0].id;
  const delegateKeyDeliveryData = {
    rootKeyId    : delegateKeyAgreementVmId,
    publicKeyJwk : delegateKeyDeliveryLeafPublicKey,
  };

  // Derive scope-aware decryption keys for encrypted protocols.
  // Single-party: ProtocolPath keys (protocol-wide or exact-path).
  // Multi-party: ProtocolContext keys (per rootContextId).
  // Write-only delegates receive no decryption capability.
  const delegateDecryptionKeys: DelegateDecryptionKey[] = [];
  const delegateContextKeys: DelegateContextKey[] = [];
  const delegateMultiPartyProtocols: string[] = [];

  const delegateGrantPromises = connectRequest.permissionRequests.map(
    async (permissionRequest) => {
      const { protocolDefinition, permissionScopes } = permissionRequest;

      const grantsMatchProtocolUri = permissionScopes.every(
        scope => 'protocol' in scope && scope.protocol === protocolDefinition.protocol
      );
      if (!grantsMatchProtocolUri) {
        throw new Error('All permission scopes must match the protocol URI they are provided with.');
      }

      await prepareProtocol(selectedDid, agent, protocolDefinition);

      const hasEncryptedTypes = Object.values(protocolDefinition.types ?? {})
        .some((type: any) => type?.encryptionRequired === true);

      if (hasEncryptedTypes) {
        const { multiParty, singleParty } = classifyProtocolRoots(protocolDefinition);

        if (multiParty.length > 0 && singleParty.length > 0) {
          // Mixed protocol: some roots are multi-party, others single-party.
          // We cannot safely model this with either key type alone.
          throw new Error(
            `Encrypted delegate access for protocols with mixed single-party ` +
            `and multi-party roots is not supported yet. ` +
            `Protocol '${protocolDefinition.protocol}' has multi-party roots ` +
            `[${multiParty.join(', ')}] and single-party roots ` +
            `[${singleParty.join(', ')}].`,
          );
        }

        if (multiParty.length > 0) {
          // Pure multi-party: derive per-context keys for existing contexts.
          // Unsupported scope shapes (protocolPath, contextId) throw.
          const ctxKeys = await deriveContextKeysForDelegate(
            agent, selectedDid, protocolDefinition, permissionScopes,
          );
          delegateContextKeys.push(...ctxKeys);

          // Only register the protocol for post-connect delivery if the
          // delegate has at least one read-like scope. Write-only delegates
          // must NOT receive context keys — they have no decryption need.
          const readMethods = new Set([
            DwnMethodName.Read, DwnMethodName.Query, DwnMethodName.Subscribe,
          ]);
          const hasReadLikeScope = permissionScopes.some(
            (s): boolean => isRecordPermissionScope(s) && readMethods.has(s.method as DwnMethodName),
          );
          if (hasReadLikeScope) {
            delegateMultiPartyProtocols.push(protocolDefinition.protocol);
          }
        } else {
          // Pure single-party: derive ProtocolPath keys.
          // Unsupported scope shapes (contextId) throw.
          const keys = await deriveScopedDecryptionKeys(
            agent, selectedDid, protocolDefinition.protocol,
            permissionScopes, protocolDefinition,
          );
          delegateDecryptionKeys.push(...keys);
        }
      }

      return EnboxConnectProtocol.createPermissionGrants(
        selectedDid,
        delegateBearerDid,
        agent,
        permissionScopes,
        delegateKeyDeliveryData,
      );
    }
  );

  const delegateGrants = (await Promise.all(delegateGrantPromises)).flat();

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
  const sessionGrantCount = delegateGrants.length;

  // Phase 1: create all revocation grants locally with bounded concurrency.
  // createGrant is local-only (storage + signing) so it's cheap, but we still
  // cap parallelism to avoid head-of-line blocking when sessionGrantCount is
  // large (e.g. dapp requesting many scopes at once).
  const revGrantResults = await mapConcurrent(
    delegateGrants.slice(0, sessionGrantCount),
    CONNECT_FANOUT_CONCURRENCY,
    (grantMessage) =>
      permissionsApi.createGrant({
        delegated : true,
        store     : true,
        grantedTo : delegateBearerDid.uri,
        scope     : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : PermissionsProtocol.uri,
          contextId : grantMessage.recordId,
        },
        dateExpires : '2040-06-25T16:09:16.693356Z',
        author      : selectedDid,
      }).then((revGrant) => ({ grantMessage, revGrant })),
  );

  // Phase 2: fan out every revocation grant to every owner DWN endpoint with
  // a single global concurrency cap so that (grants × endpoints) cannot blow
  // up. This is best-effort (sync delivers eventually) so individual failures
  // are tolerated by `mapConcurrentSettled`.
  const revSendTasks = revGrantResults.flatMap(({ grantMessage, revGrant }) => {
    sessionRevocations.push({
      grantId           : grantMessage.recordId,
      revocationGrantId : revGrant.message.recordId,
    });

    const { encodedData: revEncoded, ...revRawMessage } = revGrant.message;
    const revData = Convert.base64Url(revEncoded).toUint8Array();

    // Include the revocation grant in the delegate grants for distribution.
    delegateGrants.push(revGrant.message);

    return revGrantEndpoints.map((dwnUrl) => ({ revRawMessage, revData, dwnUrl }));
  });

  if (revSendTasks.length > 0) {
    await mapConcurrentSettled(
      revSendTasks,
      CONNECT_FANOUT_CONCURRENCY,
      ({ revRawMessage, revData, dwnUrl }) =>
        agent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid : selectedDid,
          message   : revRawMessage,
          data      : new Blob([revData as BlobPart]),
          signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
        }),
    );
  }

  logger.log('Building connect response...');
  const responseObject = await EnboxConnectProtocol.createConnectResponse({
    providerDid                 : selectedDid,
    delegateDid                 : delegateBearerDid.uri,
    aud                         : connectRequest.clientDid,
    nonce                       : connectRequest.nonce,
    delegateGrants,
    delegatePortableDid,
    delegateDecryptionKeys      : delegateDecryptionKeys.length > 0 ? delegateDecryptionKeys : undefined,
    delegateContextKeys         : delegateContextKeys.length > 0 ? delegateContextKeys : undefined,
    delegateMultiPartyProtocols : delegateMultiPartyProtocols.length > 0 ? delegateMultiPartyProtocols : undefined,
    sessionRevocations          : sessionRevocations.length > 0 ? sessionRevocations : undefined,
  });

  logger.log('Signing connect response...');
  const responseObjectJwt = await EnboxConnectProtocol.signJwt({
    did  : delegateBearerDid,
    data : responseObject,
  });

  const clientDid = await DidJwk.resolve(connectRequest.clientDid);

  const sharedKey = await EnboxConnectProtocol.deriveSharedKey(
    delegateBearerDid,
    clientDid?.didDocument!
  );

  logger.log('Encrypting connect response...');
  const encryptedResponse = await EnboxConnectProtocol.encryptResponse({
    jwt                  : responseObjectJwt,
    encryptionKey        : sharedKey,
    delegatePublicKeyJwk : delegateBearerDid.document.verificationMethod![0].publicKeyJwk!,
    pin,
  });

  const formEncodedRequest = new URLSearchParams({
    id_token : encryptedResponse,
    state    : connectRequest.state,
  }).toString();

  logger.log(`Sending connect response to: ${connectRequest.callbackUrl}`);
  await fetch(connectRequest.callbackUrl, {
    body    : formEncodedRequest,
    method  : 'POST',
    headers : {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    signal: AbortSignal.timeout(30_000),
  });
}

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

export const EnboxConnectProtocol = {
  buildConnectUrl,
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
  createPermissionGrants,
  submitConnectResponse,
  deriveScopedDecryptionKeys,
  deriveContextKeysForDelegate,
  classifyProtocolRoots,
};
