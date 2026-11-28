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
 *   channels additionally bind the wallet's pre-approval handshake key
 *   (`walletEpk.x`) into `apv` so an untrusted relay cannot split-view a
 *   different handshake key.
 *
 * Every open operation passes mandatory algorithm allow-lists to the JWE
 * engine and performs value checks (origin binding, aud, nonce echo, state
 * echo, expiry window) before the payload is trusted.
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';
import type { Jwk } from '@enbox/crypto';
import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { ConnectAuthenticationResponse, ConnectPermissionRequest, ConnectRequest, ConnectRequestDecryption, ConnectRequestEncryption, ConnectResponse } from './types.js';

import { Convert } from '@enbox/common';
import { isPortableDid } from '@enbox/dids';
import { CompactJwe, isX25519PublicJwk, XChaCha20Poly1305 } from '@enbox/crypto';
import { ModulesConfigure, validatePermissionScope } from '@enbox/dwn-sdk-js';

import { assertConnectAuthenticationRequest, assertConnectRequestAuthentication } from './owner-authentication.js';
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

/** Byte length required of the redirect response fragment secret (256 bits). */
export const RESPONSE_SECRET_BYTE_LENGTH = 32;

/** Maximum length in characters permitted for a connect `redirectUri`. */
const MAX_REDIRECT_URI_LENGTH = 2_048;

/** Loopback hosts allowed to use `http:` for local development redirect URIs. */
const LOCAL_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

function requireOptionalConnectRequestType(payload: Record<string, unknown>, context: string): void {
  const value = payload.requestType;
  if (value !== undefined && value !== 'connect' && value !== 'refresh' && value !== 'authenticate') {
    fail(context, 'requestType', 'must be "connect", "refresh", or "authenticate" when present');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * Validates a connect `redirectUri`: must be an `https:` URL (or `http:` on
 * loopback for local development), with NO credentials, NO query string
 * (`url.search === ''`, preventing open-redirector chains and RFC 9700
 * fragment reattachment), and NO existing fragment (`url.hash === ''`).
 */
export function assertValidRedirectUri(value: unknown, context = 'invalid connect request'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) {
    fail(context, 'reply.redirectUri', 'must be a non-empty URL string (max 2048 chars)');
  }
  if (/\s/.test(value)) {
    fail(context, 'reply.redirectUri', 'must not contain whitespace');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(context, 'reply.redirectUri', 'must be a valid URL');
  }
  const isLocalHttp = parsed.protocol === 'http:' && LOCAL_REDIRECT_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    fail(context, 'reply.redirectUri', 'must use HTTPS (or http on localhost)');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail(context, 'reply.redirectUri', 'must not contain credentials');
  }
  if (parsed.search !== '' || value.includes('?')) {
    fail(context, 'reply.redirectUri', 'must not contain a query string');
  }
  if (parsed.hash !== '' || value.includes('#')) {
    fail(context, 'reply.redirectUri', 'must not contain a fragment');
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

  if (value.mode === 'redirect') {
    if (typeof value.callbackUrl !== 'string' || value.callbackUrl.length === 0 || value.callbackUrl.length > MAX_REDIRECT_URI_LENGTH) {
      fail(context, 'reply.callbackUrl', 'must be a non-empty string');
    }
    assertValidRedirectUri(value.redirectUri, context);
    return;
  }

  if (value.mode !== 'post_message') {
    fail(context, 'reply.mode', 'must be "direct_post", "redirect", or "post_message"');
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
// of per-field requirements. Requests also validate their nested module
// definitions and permission scopes before consent or approval side effects.
// Permission grant authorization and portable DID validation remain with
// their downstream validators.

/** Validates the exact permission-request DTO and its authored definitions and scopes. */
export function assertConnectPermissionRequests(requests: unknown): asserts requests is ConnectPermissionRequest[] {
  const ctx = 'invalid connect request';
  if (!Array.isArray(requests)) {
    fail(ctx, 'permissionRequests', 'must be an array');
  }
  for (const [index, request] of requests.entries()) {
    const field = `permissionRequests[${index}]`;
    if (!isPlainObject(request)) {
      fail(ctx, field, 'must be an object');
    }
    const extraField = Object.keys(request).find(key => key !== 'moduleDefinition' && key !== 'permissionScopes');
    if (extraField !== undefined) {
      fail(ctx, `${field}.${extraField}`, 'is not allowed');
    }
    if (!isPlainObject(request.moduleDefinition)) {
      fail(ctx, `${field}.moduleDefinition`, 'must be an object');
    }
    ModulesConfigure.validateModuleDefinition(request.moduleDefinition as ModuleDefinition, { requireKeyAgreement: false });
    if (!Array.isArray(request.permissionScopes)) {
      fail(ctx, `${field}.permissionScopes`, 'must be an array');
    }
    for (const scope of request.permissionScopes) {
      validatePermissionScope(scope);
    }
  }
}

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
  requireOptionalString(payload, 'applicationId', ctx);
  requireOptionalObject(payload, 'clientMetadata', ctx);
  requireArray(payload, 'permissionRequests', ctx);
  requireOptionalNumber(payload, 'requestedSessionTtlSeconds', ctx);
  requireOptionalString(payload, 'delegateDid', ctx);
  requireOptionalConnectRequestType(payload, ctx);
  requireOptionalString(payload, 'expectedProviderDid', ctx);
  if (payload.requestType === 'refresh' && payload.delegateDid === undefined) {
    fail(ctx, 'delegateDid', 'is required when `requestType` is "refresh"');
  }
  requireStringArray(payload, 'supportedDidMethods', ctx);
  requireString(payload, 'nonce', ctx);
  requireString(payload, 'state', ctx);
  requireResponseKey(payload, ctx);
  requireReplyDescriptor(payload, ctx);
  const reply = payload.reply as ConnectRequest['reply'];
  if (reply.mode === 'redirect' && payload.delegateDid !== undefined && payload.requestType !== 'refresh') {
    fail(ctx, 'delegateDid', 'cannot be pre-supplied on a new "redirect" request');
  }
  if (payload.authentication !== undefined) { assertConnectRequestAuthentication(payload as ConnectRequest); }
  if (payload.requestType === 'authenticate') { assertConnectAuthenticationRequest(payload as ConnectRequest); }
  assertConnectPermissionRequests(payload.permissionRequests);
}

/**
 * Runtime assertion that a verified JWT payload has the shape of a
 * {@link ConnectResponse}. Applied by {@link openResponse} immediately after
 * signature verification, before the value checks run.
 */
export function assertConnectResponse(payload: Record<string, unknown>): asserts payload is ConnectResponse {
  const ctx = 'invalid connect response';
  if (payload.responseType !== undefined) { fail(ctx, 'responseType', 'is not a delegation response'); }
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
  requireOptionalString(payload, 'authenticationProof', ctx);
}

/** A distinct response variant prevents authentication-only completion from fabricating delegate credentials. */
export function assertConnectAuthenticationResponse(payload: Record<string, unknown>): asserts payload is ConnectAuthenticationResponse {
  const ctx = 'invalid authentication response';
  const keys = ['responseType', 'providerDid', 'aud', 'iat', 'exp', 'nonce', 'state', 'authenticationProof'];
  if (Object.keys(payload).length !== keys.length || !keys.every(key => Object.hasOwn(payload, key)) ||
      payload.responseType !== 'authentication') { fail(ctx, 'responseType', 'must identify only authentication fields'); }
  for (const key of ['providerDid', 'aud', 'nonce', 'state', 'authenticationProof']) { requireString(payload, key, ctx); }
  for (const key of ['iat', 'exp']) {
    requireNumber(payload, key, ctx);
    if (!Number.isSafeInteger(payload[key])) { fail(ctx, key, 'must be an integer'); }
  }
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
 * On relay channels the caller passes the wallet's pre-approval ephemeral
 * `handshakeKey` (`walletEpk`), binding `walletEpk.x` into the integrity-protected
 * `apv` header so an untrusted relay cannot substitute the handshake key.
 *
 * @param params - The sealing parameters.
 * @param params.response - The connect response payload.
 * @param params.signer - The wallet's response signing `did:jwk`.
 * @param params.responseKey - The request's X25519 public `responseKey` JWK.
 * @param params.handshakeKey - Optional wallet ephemeral X25519 public handshake key (`walletEpk`).
 * @returns A promise resolving to the sealed response as a Compact JWE string.
 */
export async function sealResponse({ response, signer, responseKey, handshakeKey, responseSecret }: {
  response: ConnectResponse;
  signer: BearerDid;
  responseKey: Jwk;
  handshakeKey?: Jwk;
  responseSecret?: Uint8Array;
}): Promise<string> {
  return sealResponseEnvelope({ response, signer, responseKey, handshakeKey, responseSecret });
}

/** Seal the authentication-only response with the same channel encryption, without delegation fields. */
export async function sealAuthenticationResponse(params: {
  response: ConnectAuthenticationResponse;
  signer: BearerDid;
  responseKey: Jwk;
  handshakeKey?: Jwk;
  responseSecret?: Uint8Array;
}): Promise<string> {
  assertConnectAuthenticationResponse(params.response);
  return sealResponseEnvelope(params);
}

function assertResponseSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== RESPONSE_SECRET_BYTE_LENGTH) {
    throw new Error(`Connect: response secret must be ${RESPONSE_SECRET_BYTE_LENGTH} bytes.`);
  }
}

async function sealResponseEnvelope({ response: inputResponse, signer, responseKey: inputResponseKey, handshakeKey, responseSecret }: {
  response: ConnectResponse | ConnectAuthenticationResponse;
  signer: BearerDid;
  responseKey: Jwk;
  handshakeKey?: Jwk;
  responseSecret?: Uint8Array;
}): Promise<string> {
  // Capture the agreed recipient and response before asynchronous KMS signing.
  const response = structuredClone(inputResponse);
  const responseKey = structuredClone(inputResponseKey);
  if (handshakeKey !== undefined && responseSecret !== undefined) {
    throw new Error('Connect: cannot combine `handshakeKey` and `responseSecret` on the same response.');
  }
  if (handshakeKey !== undefined) {
    assertX25519PublicJwk(handshakeKey);
  }
  if (responseSecret !== undefined) {
    assertResponseSecret(responseSecret);
  }
  const apv = handshakeKey === undefined ? undefined : handshakeKey.x as string;
  const jwt = await signJwt({ did: signer, data: response });

  return await CompactJwe.encrypt({
    plaintext       : Convert.string(jwt).toUint8Array(),
    protectedHeader : {
      alg : 'ECDH-ES',
      apu : Convert.string(response.state).toBase64Url(),
      ...(apv === undefined ? {} : { apv }),
      cty : 'JWT',
      enc : 'XC20P',
      typ : CONNECT_RESPONSE_JWE_TYP,
    },
    key: {
      mode          : 'ecdh-es',
      peerPublicKey : responseKey,
      ...(responseSecret === undefined ? {} : { secret: responseSecret }),
    },
  });
}

/**
 * Opens a sealed connect response on the app side: decrypts the Compact JWE
 * with the client's X25519 response key (ECDH-ES only, XC20P only), verifies
 * the envelope header and `apu` (plus optional `apv` handshake key or 256-bit
 * `responseSecret`) binding, verifies the JWT signature, asserts the payload
 * shape, and then enforces the mandatory value checks — `aud` must equal the
 * client DID, the request `nonce` and `state` must be echoed exactly, and the
 * `iat`/`exp` window must cover the current time.
 */
export type OpenConnectResponseOptions = {
  jwe: string;
  recipientPrivateKey: Jwk;
  expected: { clientDid: string; nonce: string; state: string; providerDid?: string; handshakeKey?: Jwk };
  responseSecret?: Uint8Array;
};

export async function openResponse(options: OpenConnectResponseOptions): Promise<ConnectResponse> {
  const payload = await openResponseEnvelope(options);
  assertConnectResponse(payload);
  assertResponseContext(payload, options.expected);
  return payload;
}

/** Open only the authentication variant. Owner proof verification is a separate mandatory client step. */
export async function openAuthenticationResponse(options: OpenConnectResponseOptions): Promise<ConnectAuthenticationResponse> {
  const payload = await openResponseEnvelope(options);
  assertConnectAuthenticationResponse(payload);
  assertResponseContext(payload, options.expected);
  return payload;
}

async function openResponseEnvelope({
  jwe,
  recipientPrivateKey,
  expected,
  responseSecret,
}: OpenConnectResponseOptions): Promise<Record<string, unknown>> {
  if (expected.handshakeKey !== undefined && responseSecret !== undefined) {
    throw new Error('Connect: cannot combine `handshakeKey` and `responseSecret` when opening a response.');
  }
  if (responseSecret !== undefined) {
    assertResponseSecret(responseSecret);
  }
  const { plaintext, protectedHeader } = await CompactJwe.decrypt({
    jwe,
    key: {
      mode       : 'ecdh-es',
      privateKey : recipientPrivateKey,
      ...(responseSecret === undefined ? {} : { secret: responseSecret }),
    },
    options: { allowedAlgs: ['ECDH-ES'], allowedEncs: ['XC20P'] },
  });

  assertEnvelopeHeader(protectedHeader, CONNECT_RESPONSE_JWE_TYP);

  const expectedApu = Convert.string(expected.state).toBase64Url();
  if (protectedHeader.apu !== expectedApu) {
    throw new Error('Connect: response JWE "apu" header does not match the request state.');
  }

  if (expected.handshakeKey !== undefined) {
    assertX25519PublicJwk(expected.handshakeKey);
    if (protectedHeader.apv !== expected.handshakeKey.x) {
      throw new Error('Connect: response JWE "apv" header does not match the verified handshake key.');
    }
  } else if (protectedHeader.apv !== undefined) {
    throw new Error('Connect: response JWE unexpectedly carried an "apv" header.');
  }

  const jwt = Convert.uint8Array(plaintext).toString();
  const { payload } = await verifyJwt({ jwt });
  return payload;
}

function assertResponseContext(payload: ConnectResponse | ConnectAuthenticationResponse, expected: OpenConnectResponseOptions['expected']): void {
  if (payload.aud !== expected.clientDid) {
    throw new Error('Connect: response `aud` does not match the client DID.');
  }
  if (payload.nonce !== expected.nonce) {
    throw new Error('Connect: response `nonce` does not echo the request nonce.');
  }
  if (payload.state !== expected.state) {
    throw new Error('Connect: response `state` does not echo the request state.');
  }
  if (expected.providerDid !== undefined && payload.providerDid !== expected.providerDid) {
    throw new Error('Connect: response `providerDid` does not match the expected wallet profile.');
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

}
