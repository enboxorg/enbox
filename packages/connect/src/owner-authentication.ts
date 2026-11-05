import type { Jwk } from '@enbox/crypto';
import type { BearerDid, DidDocument, DidResolver, DidVerificationMethod } from '@enbox/dids';
import type { ConnectAuthenticationParams, ConnectRequest, VerifiedConnectAuthentication } from './types.js';

import { Convert } from '@enbox/common';
import { Did, DidDht, DidJwk, UniversalResolver } from '@enbox/dids';
import { Ed25519, isOkpPublicJwk, isPublicJwk, Secp256k1, Secp256r1, Sha256 } from '@enbox/crypto';

export const CONNECT_OWNER_AUTHENTICATION_TYP = 'enbox-connect-owner-authentication+jwt';
export const CONNECT_AUTHENTICATION_MAX_AGE_SECONDS = 300;
export const CONNECT_AUTHENTICATION_MAX_REQUEST_BYTES = 262_144;
const MAX_PROOF_BYTES = 16_384;
const CLOCK_SKEW_SECONDS = 30;
const PURPOSE = 'enbox-connect-authentication';
type SigningAlgorithm = 'EdDSA' | 'ES256K' | 'ES256';

export type ConnectAuthenticationFailure =
  | 'invalid-request' | 'invalid-proof' | 'unsupported-key' | 'invalid-signature'
  | 'context-mismatch' | 'expired-proof' | 'did-resolution' | 'replayed-proof';

/** Fixed public messages; an optional cause is for local diagnostics and may contain private details. */
export class ConnectAuthenticationError extends Error {
  public constructor(public readonly code: ConnectAuthenticationFailure, options?: ErrorOptions) {
    super(`Connect authentication failed: ${code}.`, options);
    this.name = 'ConnectAuthenticationError';
  }
}

/**
 * Service-owned atomic consumption keyed by (audience, challenge), or the one
 * OAuth transaction that owns that challenge. Subject/requestDigest are checked
 * binding facts, never extra key partitions. Do not key by proof/signature:
 * another owner or another valid signature must not consume a challenge twice.
 * Return false for a challenge the service never issued, an expired or consumed
 * transaction, or a binding that differs from the stored transaction context.
 * A set that accepts every previously unseen challenge is not sufficient.
 */
export interface ConnectAuthenticationReplayStore {
  consume(binding: Pick<VerifiedConnectAuthentication,
    'audience' | 'challenge' | 'subject' | 'requestDigest' | 'expiresAt'>): Promise<boolean>;
}

export type ConnectAuthenticationResolver = Pick<DidResolver, 'resolve'>;

/** Validate the small, versioned authentication extension independently of delegation. */
export function assertConnectAuthenticationParams(value: unknown): asserts value is ConnectAuthenticationParams {
  const input = object(value);
  if (!input || !exactKeys(input, ['version', 'audience', 'challenge']) || input.version !== 1 ||
      typeof input.audience !== 'string' || input.audience.length > 2_048 ||
      typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/u.test(input.challenge)) {
    throw new ConnectAuthenticationError('invalid-request');
  }
  try {
    const audience = new URL(input.audience);
    if (audience.protocol !== 'https:' || audience.username !== '' || audience.password !== '' ||
        audience.hash !== '' || audience.search !== '' ||
        (audience.href !== input.audience && audience.origin !== input.audience)) {
      throw new ConnectAuthenticationError('invalid-request');
    }
  } catch { throw new ConnectAuthenticationError('invalid-request'); }
}

/** The proof covers the original full request, before any transport display-metadata overrides. */
export async function connectAuthenticationRequestDigest(request: ConnectRequest): Promise<string> {
  assertConnectRequestAuthentication(request);
  const encoded = new TextEncoder().encode(canonical(request));
  return Convert.uint8Array(await Sha256.digest({ data: encoded })).toBase64Url();
}

/** Authentication-only requests never carry a delegated permission or credential request. */
export function assertConnectAuthenticationRequest(request: ConnectRequest): void {
  assertConnectRequestAuthentication(request);
  if (request.requestType !== 'authenticate') { throw new ConnectAuthenticationError('invalid-request'); }
}

export type PreparedOwnerAuthenticationProof = Readonly<{
  /** Mint once the approved operation is ready; proof lifetime starts here, not during preflight. */
  sign(options?: { now?: number }): Promise<string>;
}>;

/** Snapshot the full request and validate its owner authentication key before any permission side effects. */
export async function prepareOwnerAuthenticationProof({ request, owner, methodId }: {
  request: ConnectRequest;
  owner: BearerDid;
  methodId?: string;
}): Promise<PreparedOwnerAuthenticationProof> {
  const snapshot = structuredClone(request);
  const subject = owner.uri;
  const document = structuredClone(owner.document);
  const requestDigest = await connectAuthenticationRequestDigest(snapshot);
  assertProvider(snapshot, subject);
  const method = authenticationMethod(document, subject, methodId);
  const algorithm = signingAlgorithm(method.publicKeyJwk);
  assertLiveSigningMethod(owner.document, subject, method);
  let signer: Awaited<ReturnType<BearerDid['getSigner']>>;
  try {
    signer = await owner.getSigner({ methodId: method.id });
  } catch (cause) { throw new ConnectAuthenticationError('unsupported-key', { cause }); }
  assertLiveSigningMethod(owner.document, subject, method);
  if (signer.algorithm !== algorithm || typeof signer.keyId !== 'string' || absoluteMethodId(signer.keyId, subject) !== method.id) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
  const authentication = snapshot.authentication as ConnectAuthenticationParams;
  return Object.freeze({
    async sign(options?: { now?: number }): Promise<string> {
      const issuedAt = options?.now ?? Math.floor(Date.now() / 1_000);
      assertNow(issuedAt);
      const header = encode({ alg: algorithm, kid: method.id, typ: CONNECT_OWNER_AUTHENTICATION_TYP });
      const payload = encode({
        iss          : subject, sub          : subject, aud          : authentication.audience,
        nonce        : authentication.challenge, request_hash : requestDigest, purpose      : PURPOSE,
        iat          : issuedAt, exp          : issuedAt + CONNECT_AUTHENTICATION_MAX_AGE_SECONDS,
      });
      const signature = await signer.sign({ data: new TextEncoder().encode(`${header}.${payload}`) });
      return `${header}.${payload}.${Convert.uint8Array(signature).toBase64Url()}`;
    },
  });
}

/** Sign with an owner authentication method through its KMS; never export an owner key. */
export async function createOwnerAuthenticationProof(options: {
  request: ConnectRequest;
  owner: BearerDid;
  methodId?: string;
  /** Unix seconds. Omit to use the current time. */
  now?: number;
}): Promise<string> {
  return (await prepareOwnerAuthenticationProof(options)).sign({ now: options.now });
}

/**
 * Verify an owner proof against this exact request, independently of the outer
 * ephemeral Connect signer. Default DID resolution has no persistent cache.
 * `expected` must come from the service's configured audience and its own
 * outstanding transaction; `request` must be that transaction's stored request.
 * Deriving these values from client-supplied input does not establish trust.
 * The service must durably consume the transaction: supply replayStore here,
 * or consume it atomically with account/code issuance after this returns.
 */
export async function verifyOwnerAuthenticationProof({ proof, request, expected, providerDid, resolver, now, replayStore }: {
  proof: string;
  request: ConnectRequest;
  expected: Readonly<Pick<ConnectAuthenticationParams, 'audience' | 'challenge'>>;
  providerDid: string;
  resolver?: ConnectAuthenticationResolver;
  now?: number;
  replayStore?: ConnectAuthenticationReplayStore;
}): Promise<VerifiedConnectAuthentication> {
  // Keep every checked and returned binding on the same caller-independent
  // context, including while an asynchronous resolver or replay store runs.
  const snapshot = snapshotVerificationRequest(request, expected);
  const requestDigest = await connectAuthenticationRequestDigest(snapshot);
  assertProvider(snapshot, providerDid);
  if (typeof proof !== 'string' || proof.length > MAX_PROOF_BYTES) { throw new ConnectAuthenticationError('invalid-proof'); }
  const parts = proof.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) {
    throw new ConnectAuthenticationError('invalid-proof');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decode(encodedHeader);
  const payload = decode(encodedPayload);
  if (!exactKeys(header, ['alg', 'kid', 'typ']) || header.typ !== CONNECT_OWNER_AUTHENTICATION_TYP ||
      typeof header.kid !== 'string' || header.kid.length > 2_048 ||
      !['EdDSA', 'ES256K', 'ES256'].includes(header.alg as string) ||
      !exactKeys(payload, ['iss', 'sub', 'aud', 'nonce', 'request_hash', 'purpose', 'iat', 'exp'])) {
    throw new ConnectAuthenticationError('invalid-proof');
  }
  const authentication = snapshot.authentication as ConnectAuthenticationParams;
  if (payload.iss !== providerDid || payload.sub !== providerDid || payload.aud !== authentication.audience ||
      payload.nonce !== authentication.challenge || payload.request_hash !== requestDigest || payload.purpose !== PURPOSE) {
    throw new ConnectAuthenticationError('context-mismatch');
  }
  assertProofTimeWindow(payload, now ?? Math.floor(Date.now() / 1_000));
  let document: DidDocument;
  try {
    const result = await (resolver ?? new UniversalResolver({ didResolvers: [DidDht, DidJwk] })).resolve(providerDid);
    if (!result.didDocument || result.didResolutionMetadata.error !== undefined || result.didDocumentMetadata.deactivated === true) {
      throw new ConnectAuthenticationError('did-resolution');
    }
    document = result.didDocument;
  } catch { throw new ConnectAuthenticationError('did-resolution'); }
  const method = authenticationMethod(document, providerDid, header.kid);
  const algorithm = signingAlgorithm(method.publicKeyJwk);
  if (algorithm !== header.alg) { throw new ConnectAuthenticationError('unsupported-key'); }
  const key = method.publicKeyJwk as Jwk;
  await verifyProofSignature(key, algorithm, encodedHeader, encodedPayload, encodedSignature);
  // A proof valid on arrival may expire while resolving its DID or checking
  // the signature. Do not consume a challenge for an already-expired proof.
  assertProofTimeWindow(payload, now ?? Math.floor(Date.now() / 1_000));
  const verified = Object.freeze({
    proof, subject   : providerDid, audience  : authentication.audience, challenge : authentication.challenge,
    requestDigest, issuedAt  : payload.iat, expiresAt : payload.exp, methodId  : method.id,
  });
  if (replayStore !== undefined && !await replayStore.consume({
    audience      : verified.audience, challenge     : verified.challenge, subject       : verified.subject,
    requestDigest : verified.requestDigest, expiresAt     : verified.expiresAt,
  })) {
    throw new ConnectAuthenticationError('replayed-proof');
  }
  // Replay stores can also be asynchronous. A late completion fails closed;
  // it does not undo a challenge the store already consumed.
  assertProofTimeWindow(payload, now ?? Math.floor(Date.now() / 1_000));
  return verified;
}

/** Capture the independent service expectation before cloning potentially caller-owned request data. */
function snapshotVerificationRequest(
  request: ConnectRequest,
  expected: Readonly<Pick<ConnectAuthenticationParams, 'audience' | 'challenge'>>,
): ConnectRequest {
  const expectedAuthentication = { version: 1, audience: expected?.audience, challenge: expected?.challenge };
  assertConnectAuthenticationParams(expectedAuthentication);
  const snapshot = structuredClone(request);
  assertConnectAuthenticationParams(snapshot?.authentication);
  if (snapshot.authentication.audience !== expectedAuthentication.audience ||
      snapshot.authentication.challenge !== expectedAuthentication.challenge) {
    throw new ConnectAuthenticationError('context-mismatch');
  }
  return snapshot;
}

function assertProofTimeWindow(
  payload: Record<string, unknown>,
  checkedAt: number,
): asserts payload is Record<string, unknown> & { iat: number; exp: number } {
  assertNow(checkedAt);
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat < 0 || payload.exp <= payload.iat ||
      payload.exp - payload.iat > CONNECT_AUTHENTICATION_MAX_AGE_SECONDS ||
      payload.iat > checkedAt + CLOCK_SKEW_SECONDS || checkedAt >= payload.exp) {
    throw new ConnectAuthenticationError('expired-proof');
  }
}

async function verifyProofSignature(
  key: Jwk,
  algorithm: SigningAlgorithm,
  encodedHeader: string,
  encodedPayload: string,
  encodedSignature: string,
): Promise<void> {
  let valid: boolean;
  try {
    const signature = Convert.base64Url(encodedSignature).toUint8Array();
    if (signature.byteLength !== 64) { throw new ConnectAuthenticationError('invalid-signature'); }
    const params = { key, signature, data: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`) };
    switch (algorithm) {
      case 'EdDSA':
        valid = await Ed25519.verify(params);
        break;
      case 'ES256K':
        valid = await Secp256k1.verify(params);
        break;
      case 'ES256':
        valid = await Secp256r1.verify(params);
        break;
    }
  } catch { throw new ConnectAuthenticationError('invalid-signature'); }
  if (!valid) { throw new ConnectAuthenticationError('invalid-signature'); }
}

/** Validate the complete JSON context of combined and authentication-only requests before consent. */
export function assertConnectRequestAuthentication(request: ConnectRequest): void {
  if (!object(request)) { throw new ConnectAuthenticationError('invalid-request'); }
  assertConnectAuthenticationParams(request.authentication);
  if (typeof request.clientDid !== 'string' || typeof request.nonce !== 'string' || typeof request.state !== 'string') {
    throw new ConnectAuthenticationError('invalid-request');
  }
  const client = Did.parse(request.clientDid);
  if (client?.uri !== request.clientDid || client?.method !== 'jwk' || client.path || client.query || client.fragment ||
      typeof request.appName !== 'string' || request.appName.length === 0 || request.appName.length > 256 ||
      !/^[A-Za-z0-9_-]{22,128}$/u.test(request.nonce) || !/^[A-Za-z0-9_-]{22,128}$/u.test(request.state) ||
      !Array.isArray(request.permissionRequests) || request.permissionRequests.length > 32 ||
      !Array.isArray(request.supportedDidMethods) || request.supportedDidMethods.length === 0 || request.supportedDidMethods.length > 8 ||
      new Set(request.supportedDidMethods).size !== request.supportedDidMethods.length ||
      request.supportedDidMethods.some(method => typeof method !== 'string' || !/^did:[a-z0-9]+$/u.test(method)) ||
      !isOkpPublicJwk(request.responseKey) || request.responseKey.crv !== 'X25519' ||
      !request.reply || !['post_message', 'direct_post'].includes(request.reply.mode)) {
    throw new ConnectAuthenticationError('invalid-request');
  }
  if (request.reply.mode === 'direct_post' && (typeof request.reply.callbackUrl !== 'string' ||
      request.reply.callbackUrl.length === 0 || request.reply.callbackUrl.length > 2_048)) {
    throw new ConnectAuthenticationError('invalid-request');
  }
  if (request.requestType !== undefined && !['connect', 'refresh', 'authenticate'].includes(request.requestType)) {
    throw new ConnectAuthenticationError('invalid-request');
  }
  if (request.requestType === 'authenticate' && (request.permissionRequests.length !== 0 ||
      request.delegateDid !== undefined || request.requestedSessionTtlSeconds !== undefined)) {
    throw new ConnectAuthenticationError('invalid-request');
  }
  if (request.requestType === 'refresh' && request.delegateDid === undefined) {
    throw new ConnectAuthenticationError('invalid-request');
  }
  if (new TextEncoder().encode(canonical(request)).byteLength > CONNECT_AUTHENTICATION_MAX_REQUEST_BYTES) {
    throw new ConnectAuthenticationError('invalid-request');
  }
}

function assertProvider(request: ConnectRequest, providerDid: string): void {
  const parsed = Did.parse(providerDid);
  if (parsed?.uri !== providerDid || parsed?.method === undefined || providerDid.length > 2_048 || parsed.path || parsed.query || parsed.fragment ||
      providerDid === request.clientDid || providerDid === request.delegateDid ||
      !request.supportedDidMethods.includes(`did:${parsed.method}`) ||
      (request.expectedProviderDid !== undefined && request.expectedProviderDid !== providerDid)) {
    throw new ConnectAuthenticationError('context-mismatch');
  }
}

function authenticationMethod(document: DidDocument, subject: string, selected?: string): DidVerificationMethod {
  if (!object(document) || document.id !== subject || !Array.isArray(document.authentication) || document.authentication.length === 0 ||
      document.authentication.length > 64 ||
      (document.verificationMethod !== undefined && (!Array.isArray(document.verificationMethod) || document.verificationMethod.length > 64)) ||
      (selected !== undefined && typeof selected !== 'string')) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
  const methods = document.verificationMethod ?? [];
  if (Array.from(document.authentication).some(reference => typeof reference !== 'string' && !validMethod(reference)) ||
      Array.from(methods).some(method => !validMethod(method))) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
  const first = document.authentication[0];
  const selectedId = absoluteMethodId(selected ?? (typeof first === 'string' ? first : first.id), subject);
  const matching = document.authentication.filter(reference =>
    absoluteMethodId(typeof reference === 'string' ? reference : reference.id, subject) === selectedId);
  if (matching.length !== 1 || !selectedId.startsWith(`${subject}#`) || selectedId.length === subject.length + 1) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
  const selectedReference = matching[0];
  const resolved = typeof selectedReference === 'string'
    ? methods.filter(method => absoluteMethodId(method.id, subject) === selectedId) : [selectedReference];
  if (resolved.length !== 1 || resolved[0].controller !== subject) { throw new ConnectAuthenticationError('unsupported-key'); }
  signingAlgorithm(resolved[0].publicKeyJwk);
  return { ...resolved[0], id: selectedId };
}

function validMethod(value: unknown): value is DidVerificationMethod {
  return Boolean(object(value) && typeof (value as DidVerificationMethod).id === 'string');
}

/** BearerDid signs from verificationMethod, including when authentication embeds the same method. */
function assertLiveSigningMethod(document: DidDocument, subject: string, approved: DidVerificationMethod): void {
  const live = authenticationMethod(document, subject, approved.id);
  const matching = document.verificationMethod?.filter(method => absoluteMethodId(method.id, subject) === approved.id) ?? [];
  if (matching.length !== 1 || matching[0].controller !== subject || !sameSigningKey(live.publicKeyJwk, approved.publicKeyJwk) ||
      !sameSigningKey(matching[0].publicKeyJwk, approved.publicKeyJwk)) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
}

function sameSigningKey(left: Jwk | undefined, right: Jwk | undefined): boolean {
  const leftAlgorithm = signingAlgorithm(left);
  const rightAlgorithm = signingAlgorithm(right);
  return leftAlgorithm === rightAlgorithm && left!.kty === right!.kty && left!.crv === right!.crv &&
    left!.x === right!.x && left!.y === right!.y;
}

function absoluteMethodId(value: string, subject: string): string {
  return value.startsWith('#') ? `${subject}${value}` : value;
}

function signingAlgorithm(key: Jwk | undefined): SigningAlgorithm {
  if (!isPublicJwk(key)) { throw new ConnectAuthenticationError('unsupported-key'); }
  let algorithm: SigningAlgorithm | undefined;
  if (key.kty === 'OKP' && key.crv === 'Ed25519') {
    algorithm = 'EdDSA';
  } else if (key.kty === 'EC' && key.crv === 'secp256k1') {
    algorithm = 'ES256K';
  } else if (key.kty === 'EC' && key.crv === 'P-256') {
    algorithm = 'ES256';
  }
  if (algorithm === undefined || (key.alg !== undefined && key.alg !== algorithm)) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
  return algorithm;
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - CONNECT_AUTHENTICATION_MAX_AGE_SECONDS) {
    throw new ConnectAuthenticationError('expired-proof');
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) { throw new ConnectAuthenticationError('invalid-request'); }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { return JSON.stringify(value); }
  if (typeof value === 'number' && Number.isFinite(value)) { return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${Array.from(value, item => canonical(item, depth + 1)).join(',')}]`; }
  if (object(value)) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).filter(key => record[key] !== undefined).sort(compareCodeUnits)
      .map(key => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`);
    return `{${entries.join(',')}}`;
  }
  throw new ConnectAuthenticationError('invalid-request');
}

/** Preserve the v1 wire format's UTF-16 code-unit order, independently of locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) { return -1; }
  if (left > right) { return 1; }
  return 0;
}

function encode(value: unknown): string {
  return Convert.string(canonical(value)).toBase64Url();
}

function decode(value: string): Record<string, unknown> {
  try {
    const parsed = object(Convert.base64Url(value).toObject());
    if (!parsed) { throw new ConnectAuthenticationError('invalid-proof'); }
    return parsed;
  } catch { throw new ConnectAuthenticationError('invalid-proof'); }
}
