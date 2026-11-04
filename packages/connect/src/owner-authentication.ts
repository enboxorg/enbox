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

/** Safe fixed categories; neither signed payloads nor identity/key values appear in the message. */
export class ConnectAuthenticationError extends Error {
  public constructor(public readonly code: ConnectAuthenticationFailure) {
    super(`Connect authentication failed: ${code}.`);
    this.name = 'ConnectAuthenticationError';
  }
}

/**
 * Service-owned atomic consumption keyed by (audience, challenge), or the one
 * OAuth transaction that owns that challenge. Subject/requestDigest are checked
 * binding facts, never extra key partitions. Do not key by proof/signature:
 * another owner or another valid signature must not consume a challenge twice.
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
  assertAuthenticationRequest(request);
  const encoded = new TextEncoder().encode(canonical(request));
  if (encoded.byteLength > CONNECT_AUTHENTICATION_MAX_REQUEST_BYTES) { throw new ConnectAuthenticationError('invalid-request'); }
  return Convert.uint8Array(await Sha256.digest({ data: encoded })).toBase64Url();
}

/** Authentication-only requests never carry a delegated permission or credential request. */
export function assertConnectAuthenticationRequest(request: ConnectRequest): void {
  assertAuthenticationRequest(request);
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
  const signer = await owner.getSigner({ methodId: method.id });
  if (signer.algorithm !== algorithm || absoluteMethodId(signer.keyId, subject) !== method.id) {
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
 * The service must durably consume the transaction: supply replayStore here,
 * or consume it atomically with account/code issuance after this returns.
 */
export async function verifyOwnerAuthenticationProof({ proof, request, providerDid, resolver, now, replayStore }: {
  proof: string;
  request: ConnectRequest;
  providerDid: string;
  resolver?: ConnectAuthenticationResolver;
  now?: number;
  replayStore?: ConnectAuthenticationReplayStore;
}): Promise<VerifiedConnectAuthentication> {
  const requestDigest = await connectAuthenticationRequestDigest(request);
  assertProvider(request, providerDid);
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
  const authentication = request.authentication as ConnectAuthenticationParams;
  if (payload.iss !== providerDid || payload.sub !== providerDid || payload.aud !== authentication.audience ||
      payload.nonce !== authentication.challenge || payload.request_hash !== requestDigest || payload.purpose !== PURPOSE) {
    throw new ConnectAuthenticationError('context-mismatch');
  }
  const checkedAt = now ?? Math.floor(Date.now() / 1_000);
  assertNow(checkedAt);
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat < 0 || payload.exp <= payload.iat ||
      payload.exp - payload.iat > CONNECT_AUTHENTICATION_MAX_AGE_SECONDS ||
      payload.iat > checkedAt + CLOCK_SKEW_SECONDS || checkedAt >= payload.exp) {
    throw new ConnectAuthenticationError('expired-proof');
  }
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
  return verified;
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

function assertAuthenticationRequest(request: ConnectRequest): void {
  assertConnectAuthenticationParams(request.authentication);
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
  if (document.id !== subject || !Array.isArray(document.authentication) || document.authentication.length === 0 ||
      document.authentication.length > 64 || (document.verificationMethod?.length ?? 0) > 64) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
  const methods = document.authentication.map(reference => {
    if (typeof reference !== 'string') { return reference; }
    const id = absoluteMethodId(reference, subject);
    const matching = document.verificationMethod?.filter(method => absoluteMethodId(method.id, subject) === id) ?? [];
    if (matching.length !== 1) { throw new ConnectAuthenticationError('unsupported-key'); }
    return matching[0];
  });
  const selectedId = selected === undefined ? absoluteMethodId(methods[0].id, subject) : absoluteMethodId(selected, subject);
  const matching = methods.filter(method => absoluteMethodId(method.id, subject) === selectedId);
  if (matching.length !== 1 || !selectedId.startsWith(`${subject}#`) || selectedId.length === subject.length + 1 ||
      matching[0].controller !== subject) {
    throw new ConnectAuthenticationError('unsupported-key');
  }
  signingAlgorithm(matching[0].publicKeyJwk);
  return { ...matching[0], id: selectedId };
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
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) { throw new ConnectAuthenticationError('invalid-request'); }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { return JSON.stringify(value); }
  if (typeof value === 'number' && Number.isFinite(value)) { return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`; }
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
