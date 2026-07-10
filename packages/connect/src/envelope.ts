/**
 * Sealed envelope operations for the connect handshake.
 *
 * Every connect payload transits as a signed JWT sealed inside a Compact JWE
 * (`cty: 'JWT'`), so both directions are signed AND encrypted on every
 * channel:
 *
 * - **Request** (`typ: 'enbox-connect-req'`): `alg: 'dir'` with the single-use
 *   fragment key on relay/QR/deep-link channels, or `alg: 'ECDH-ES'` to the
 *   wallet's beacon ephemeral key with `apv = b64u(walletOrigin)` on popup
 *   channels. Content encryption is XChaCha20-Poly1305 (`enc: 'XC20P'`).
 * - **Response** (`typ: 'enbox-connect-res'`): `alg: 'ECDH-ES'` to the
 *   request's fresh X25519 `responseKey` with `apu = b64u(state)`; relay
 *   channels additionally strengthen the CEK with a user-verified PIN that
 *   never transits (wrong PIN fails closed with an AEAD tag failure).
 *
 * Every open operation passes mandatory algorithm allow-lists to the JWE
 * engine and performs value checks (origin binding, aud, nonce echo, state
 * echo, expiry window) before the payload is trusted.
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';
import type { Jwk } from '@enbox/crypto';
import type { ConnectRequest, ConnectRequestDecryption, ConnectRequestEncryption, ConnectResponse } from './types.js';

import { Convert } from '@enbox/common';
import { isPortableDid } from '@enbox/dids';
import { CompactJwe, isOkpPublicJwk, XChaCha20Poly1305 } from '@enbox/crypto';

import { signJwt, verifyJwt } from './jwt.js';

/** JWE `typ` header value identifying a sealed connect request. */
export const CONNECT_REQUEST_JWE_TYP = 'enbox-connect-req';

/** JWE `typ` header value identifying a sealed connect response. */
export const CONNECT_RESPONSE_JWE_TYP = 'enbox-connect-res';

/**
 * Clock-skew allowance, in seconds, applied when validating the `iat`
 * timestamp of a connect response.
 */
const CONNECT_RESPONSE_MAX_CLOCK_SKEW_SECONDS = 60;

/** Byte length required of the single-use symmetric request key (XC20P). */
export const REQUEST_KEY_BYTE_LENGTH = 32;

// ─── Field-level validation helpers ─────────────────────────────────────
//
// The connect-request / connect-response assertions below describe their
// expected shape declaratively in terms of these primitive checks. Each
// helper throws a consistent `Connect: <context> — \`<field>\` <reason>`
// message on mismatch, so per-field error formatting is centralized here
// rather than duplicated at every call site.

/**
 * Throws a shape-validation error during connect payload assertion.
 *
 * Deliberately throws plain `Error` rather than `TypeError`: boundary
 * validation failures must propagate through the same `try/catch` paths as
 * every other connect-flow error (JWE tag failure, JWT signature failure,
 * transport failure) without `catch` blocks special-casing a `TypeError`
 * subclass.
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

function requireStringArray(payload: Record<string, unknown>, field: string, context: string): void {
  const value = payload[field];
  if (!Array.isArray(value) || !value.every((item): boolean => typeof item === 'string')) {
    fail(context, field, 'must be a string[]');
  }
}

function requireOptionalString(payload: Record<string, unknown>, field: string, context: string): void {
  if (payload[field] !== undefined && typeof payload[field] !== 'string') {
    fail(context, field, 'must be a string when present');
  }
}

function requireOptionalNumber(payload: Record<string, unknown>, field: string, context: string): void {
  if (payload[field] !== undefined && typeof payload[field] !== 'number') {
    fail(context, field, 'must be a number when present');
  }
}

function requireOptionalObject(payload: Record<string, unknown>, field: string, context: string): void {
  const value = payload[field];
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    fail(context, field, 'must be an object when present');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns whether `value` is a public (no `d`) X25519 OKP JWK. */
function isX25519PublicJwk(value: unknown): value is Jwk {
  return isOkpPublicJwk(value) && value.crv === 'X25519';
}

/**
 * Asserts that `value` is a public (no `d`) X25519 OKP JWK.
 *
 * Reusable at channel boundaries that receive an ephemeral public key from a
 * remote party (e.g. parsing a popup wallet's `loaded` beacon).
 */
export function assertX25519PublicJwk(value: unknown): asserts value is Jwk {
  if (!isX25519PublicJwk(value)) {
    throw new Error('Connect: value must be an X25519 public JWK without private key material.');
  }
}

/** Validates the `responseKey` field: a public (no `d`) X25519 OKP JWK. */
function requireResponseKey(payload: Record<string, unknown>, context: string): void {
  if (!isX25519PublicJwk(payload.responseKey)) {
    fail(context, 'responseKey', 'must be an X25519 public JWK');
  }
}

/** Validates the `reply` field against the {@link ConnectRequest} reply union. */
function requireReplyDescriptor(payload: Record<string, unknown>, context: string): void {
  const value = payload.reply;
  if (!isPlainObject(value)) { fail(context, 'reply', 'must be an object'); }

  if (value.mode === 'direct_post') {
    if (typeof value.callbackUrl !== 'string') { fail(context, 'reply.callbackUrl', 'must be a string'); }
    return;
  }

  if (value.mode !== 'post_message') {
    fail(context, 'reply.mode', 'must be "direct_post" or "post_message"');
  }
}

/** Validates the `sessionRevocations` field: an array of grant/revocation ID pairs. */
function requireSessionRevocations(payload: Record<string, unknown>, context: string): void {
  const value = payload.sessionRevocations;
  if (!Array.isArray(value)) { fail(context, 'sessionRevocations', 'must be an array'); }

  const isValidEntry = (entry: unknown): boolean =>
    isPlainObject(entry) && typeof entry.grantId === 'string' && typeof entry.revocationGrantId === 'string';
  if (!value.every(isValidEntry)) {
    fail(context, 'sessionRevocations', 'entries must be { grantId: string, revocationGrantId: string } objects');
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
 * Runtime assertion that a verified JWT payload has the shape of a
 * {@link ConnectRequest}. Applied by {@link openRequest} immediately after
 * signature verification, before the payload is returned to the wallet.
 */
export function assertConnectRequest(payload: Record<string, unknown>): asserts payload is ConnectRequest {
  const ctx = 'invalid connect request';
  requireString(payload, 'clientDid', ctx);
  requireString(payload, 'appName', ctx);
  requireOptionalString(payload, 'appIcon', ctx);
  requireOptionalObject(payload, 'clientMetadata', ctx);
  requireArray(payload, 'permissionRequests', ctx);
  requireOptionalNumber(payload, 'requestedSessionTtlSeconds', ctx);
  requireOptionalString(payload, 'delegateDid', ctx);
  requireStringArray(payload, 'supportedDidMethods', ctx);
  requireString(payload, 'nonce', ctx);
  requireString(payload, 'state', ctx);
  requireResponseKey(payload, ctx);
  requireReplyDescriptor(payload, ctx);
}

/**
 * Runtime assertion that a verified JWT payload has the shape of a
 * {@link ConnectResponse}. Applied by {@link openResponse} immediately after
 * signature verification, before the value checks run.
 */
export function assertConnectResponse(payload: Record<string, unknown>): asserts payload is ConnectResponse {
  const ctx = 'invalid connect response';
  requireString(payload, 'providerDid', ctx);
  requireString(payload, 'delegateDid', ctx);
  requireString(payload, 'aud', ctx);
  requireNumber(payload, 'iat', ctx);
  requireNumber(payload, 'exp', ctx);
  requireString(payload, 'nonce', ctx);
  requireString(payload, 'state', ctx);
  requireArray(payload, 'delegateGrants', ctx);
  if (payload.delegatePortableDid !== undefined && !isPortableDid(payload.delegatePortableDid)) {
    fail(ctx, 'delegatePortableDid', 'must be a portable DID when present');
  }
  requireSessionRevocations(payload, ctx);
}

// ─── Envelope internals ─────────────────────────────────────────────────

/** Converts a raw single-use request key to an XC20P content-encryption JWK. */
async function requestKeyToJwk(requestKey: Uint8Array): Promise<Jwk> {
  if (requestKey.length !== REQUEST_KEY_BYTE_LENGTH) {
    throw new Error(`Connect: request encryption key must be ${REQUEST_KEY_BYTE_LENGTH} bytes.`);
  }
  return await XChaCha20Poly1305.bytesToPrivateKey({ privateKeyBytes: requestKey });
}

/** Verifies the decrypted JWE Protected Header carries the expected `typ` and `cty` values. */
function assertEnvelopeHeader(protectedHeader: Record<string, unknown>, expectedTyp: string): void {
  if (protectedHeader.typ !== expectedTyp) {
    throw new Error(`Connect: unexpected JWE "typ" header value; expected "${expectedTyp}".`);
  }
  if (protectedHeader.cty !== 'JWT') {
    throw new Error('Connect: unexpected JWE "cty" header value; expected "JWT".');
  }
}

// ─── Seal / open operations ─────────────────────────────────────────────

/**
 * Signs a {@link ConnectRequest} as a JWT with the client DID and seals it as
 * a Compact JWE for the channel described by `encryption`.
 *
 * Relay channels use `alg: 'dir'` with the single-use fragment key; popup
 * channels use `alg: 'ECDH-ES'` to the wallet's beacon ephemeral key with the
 * wallet origin bound into the integrity-protected `apv` header.
 *
 * @param params - The sealing parameters.
 * @param params.request - The connect request payload.
 * @param params.signer - The client's ephemeral `did:jwk`; must match `request.clientDid`.
 * @param params.encryption - The channel-specific encryption input.
 * @returns A promise resolving to the sealed request as a Compact JWE string.
 */
export async function sealRequest({ request, signer, encryption }: {
  request: ConnectRequest;
  signer: BearerDid;
  encryption: ConnectRequestEncryption;
}): Promise<string> {
  if (signer.uri !== request.clientDid) {
    throw new Error('Connect: request must be signed by the `clientDid` identifier.');
  }

  const jwt = await signJwt({ did: signer, data: request });

  const { alg, key, extraHeader } = encryption.mode === 'dir'
    ? {
      alg         : 'dir',
      key         : await requestKeyToJwk(encryption.requestKey),
      extraHeader : {},
    }
    : {
      alg         : 'ECDH-ES',
      key         : { mode: 'ecdh-es' as const, peerPublicKey: encryption.walletEpk },
      extraHeader : { apv: Convert.string(encryption.walletOrigin).toBase64Url() },
    };

  return await CompactJwe.encrypt({
    plaintext       : Convert.string(jwt).toUint8Array(),
    protectedHeader : { alg, ...extraHeader, cty: 'JWT', enc: 'XC20P', typ: CONNECT_REQUEST_JWE_TYP },
    key,
  });
}

/**
 * Opens a sealed connect request on the wallet side: decrypts the Compact JWE
 * with a channel-pinned algorithm allow-list, verifies the envelope header
 * (`typ`/`cty` and, on popup channels, the `apv` origin binding), verifies
 * the JWT signature, and asserts the payload shape.
 *
 * The JWT signer is value-checked against the payload's `clientDid` so a
 * request cannot claim an identifier its signer does not control.
 *
 * @param params - The opening parameters.
 * @param params.jwe - The sealed request as a Compact JWE string.
 * @param params.decryption - The channel-specific decryption input.
 * @returns A promise resolving to the validated {@link ConnectRequest}.
 */
export async function openRequest({ jwe, decryption }: {
  jwe: string;
  decryption: ConnectRequestDecryption;
}): Promise<ConnectRequest> {
  const { key, allowedAlgs } = decryption.mode === 'dir'
    ? { key: await requestKeyToJwk(decryption.requestKey), allowedAlgs: ['dir' as const] }
    : { key: { mode: 'ecdh-es' as const, privateKey: decryption.recipientPrivateKey }, allowedAlgs: ['ECDH-ES' as const] };

  const { plaintext, protectedHeader } = await CompactJwe.decrypt({
    jwe,
    key,
    options: { allowedAlgs, allowedEncs: ['XC20P'] },
  });

  assertEnvelopeHeader(protectedHeader, CONNECT_REQUEST_JWE_TYP);

  if (decryption.mode === 'ecdh-es') {
    const expectedApv = Convert.string(decryption.walletOrigin).toBase64Url();
    if (protectedHeader.apv !== expectedApv) {
      throw new Error('Connect: request JWE "apv" header does not match this wallet origin.');
    }
  }

  const jwt = Convert.uint8Array(plaintext).toString();
  const { payload, signerDid } = await verifyJwt({ jwt });
  assertConnectRequest(payload);

  if (signerDid !== payload.clientDid) {
    throw new Error('Connect: request JWT signer does not match `clientDid`.');
  }

  return payload;
}

/**
 * Signs a {@link ConnectResponse} as a JWT with the wallet's response signer
 * and seals it as a Compact JWE to the request's fresh X25519 `responseKey`
 * via ECDH-ES, binding the request state into the integrity-protected `apu`
 * header.
 *
 * On relay channels the caller passes the user-verified `pin`, which
 * strengthens the derived CEK through an HKDF wrapper without ever
 * transiting; a recipient using the wrong PIN fails closed with an AEAD
 * authentication tag failure.
 *
 * @param params - The sealing parameters.
 * @param params.response - The connect response payload.
 * @param params.signer - The wallet's response signing `did:jwk`.
 * @param params.responseKey - The request's X25519 public `responseKey` JWK.
 * @param params.pin - Optional PIN for relay channels.
 * @returns A promise resolving to the sealed response as a Compact JWE string.
 */
export async function sealResponse({ response, signer, responseKey, pin }: {
  response: ConnectResponse;
  signer: BearerDid;
  responseKey: Jwk;
  pin?: string;
}): Promise<string> {
  const jwt = await signJwt({ did: signer, data: response });

  return await CompactJwe.encrypt({
    plaintext       : Convert.string(jwt).toUint8Array(),
    protectedHeader : {
      alg : 'ECDH-ES',
      apu : Convert.string(response.state).toBase64Url(),
      cty : 'JWT',
      enc : 'XC20P',
      typ : CONNECT_RESPONSE_JWE_TYP,
    },
    key: { mode: 'ecdh-es', peerPublicKey: responseKey, pin },
  });
}

/**
 * Opens a sealed connect response on the app side: decrypts the Compact JWE
 * with the client's X25519 response key (ECDH-ES only, XC20P only), verifies
 * the envelope header and `apu` state binding, verifies the JWT signature,
 * asserts the payload shape, and then enforces the mandatory value checks —
 * `aud` must equal the client DID, the request `nonce` and `state` must be
 * echoed exactly, and the `iat`/`exp` window must cover the current time.
 *
 * @param params - The opening parameters.
 * @param params.jwe - The sealed response as a Compact JWE string.
 * @param params.recipientPrivateKey - The client's fresh X25519 private response key.
 * @param params.expected - The request values the response must echo.
 * @param params.pin - The user-entered PIN on relay channels; must match the sealing PIN.
 * @returns A promise resolving to the validated {@link ConnectResponse}.
 */
export async function openResponse({ jwe, recipientPrivateKey, expected, pin }: {
  jwe: string;
  recipientPrivateKey: Jwk;
  expected: { clientDid: string; nonce: string; state: string };
  pin?: string;
}): Promise<ConnectResponse> {
  const { plaintext, protectedHeader } = await CompactJwe.decrypt({
    jwe,
    key     : { mode: 'ecdh-es', privateKey: recipientPrivateKey, pin },
    options : { allowedAlgs: ['ECDH-ES'], allowedEncs: ['XC20P'] },
  });

  assertEnvelopeHeader(protectedHeader, CONNECT_RESPONSE_JWE_TYP);

  const expectedApu = Convert.string(expected.state).toBase64Url();
  if (protectedHeader.apu !== expectedApu) {
    throw new Error('Connect: response JWE "apu" header does not match the request state.');
  }

  const jwt = Convert.uint8Array(plaintext).toString();
  const { payload } = await verifyJwt({ jwt });
  assertConnectResponse(payload);

  if (payload.aud !== expected.clientDid) {
    throw new Error('Connect: response `aud` does not match the client DID.');
  }
  if (payload.nonce !== expected.nonce) {
    throw new Error('Connect: response `nonce` does not echo the request nonce.');
  }
  if (payload.state !== expected.state) {
    throw new Error('Connect: response `state` does not echo the request state.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp <= payload.iat) {
    throw new Error('Connect: response `exp` must be later than `iat`.');
  }
  if (payload.iat > nowSeconds + CONNECT_RESPONSE_MAX_CLOCK_SKEW_SECONDS) {
    throw new Error('Connect: response `iat` is in the future.');
  }
  if (nowSeconds >= payload.exp) {
    throw new Error('Connect: response has expired.');
  }

  return payload;
}
