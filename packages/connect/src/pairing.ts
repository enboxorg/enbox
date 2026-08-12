/**
 * Cryptographic primitives for the Enbox Connect v3 pairing ceremony.
 *
 * Both peers commit to a fresh X25519 public key and nonce before either
 * reveal is released. The resulting shared secret is domain-separated with
 * HKDF for comparison-code display and authenticated confirmation frames.
 * Signed request, decision, and response frames use ECDH-ES directly.
 *
 * @module
 */

import type { Jwk } from '@enbox/crypto';

import { canonicalJsonStringify, Convert } from '@enbox/common';
import { CryptoUtils, Hkdf, Sha256, X25519 } from '@enbox/crypto';

/** Wire protocol version for the transcript-confirmed pairing ceremony. */
export const CONNECT_PROTOCOL_VERSION = 3 as const;

/** Number of bytes in every pairing reveal nonce and X25519 public key. */
export const CONNECT_PAIRING_VALUE_BYTE_LENGTH = 32;

/** Number of decimal digits displayed for human transcript comparison. */
export const CONNECT_VERIFICATION_CODE_DIGITS = 6;

const KEY_COMMITMENT_DOMAIN = 'enbox-connect-v3:key-commitment';
const KEY_DERIVATION_DOMAIN = 'enbox/connect/v3';

/** Fixed-purpose keys derived from a pairing's X25519 shared secret. */
export type ConnectPairingKeyPurpose =
  | 'verification-code'
  | 'confirmation-mac';

/** Public X25519 key and nonce opened after the peer has committed. */
export type ConnectPairingReveal = {
  /** Raw 32-byte X25519 public key, base64url encoded without padding. */
  publicKey: string;

  /** Fresh 32-byte random nonce, base64url encoded without padding. */
  nonce: string;
};

/** Locally held key material for one side of a pairing. */
export type ConnectPairingKey = {
  /** SHA-256 commitment published before either side reveals. */
  commitment: string;

  /** Private X25519 JWK. This value must never leave its originating process. */
  privateKey: Jwk;

  /** Public reveal sent only after both commitments exist. */
  reveal: ConnectPairingReveal;
};

/** Canonical public context committed into every v3 transcript. */
export type ConnectPairingContext = {
  /** Protocol version. */
  version: typeof CONNECT_PROTOCOL_VERSION;

  /** Relay-issued opaque identifier for this single pairing attempt. */
  pairingId: string;

  /** Exact canonical HTTPS origin of the relay carrying opaque frames. */
  relayOrigin: string;

  /** Exact canonical HTTPS origin of the selected wallet. */
  walletOrigin: string;

  /** Client commitment recorded when the pairing is created. */
  clientCommitment: string;

  /** Wallet commitment recorded when the pairing is claimed. */
  walletCommitment: string;

  /** Client reveal validated against `clientCommitment`. */
  clientReveal: ConnectPairingReveal;

  /** Wallet reveal validated against `walletCommitment`. */
  walletReveal: ConnectPairingReveal;
};

/** Inputs whose canonical hash authenticates requester confirmation. */
export type ConnectPairingTranscript = {
  /** Protocol version. */
  version: typeof CONNECT_PROTOCOL_VERSION;

  /** Commit-before-reveal key-agreement context. */
  pairing: ConnectPairingContext;

  /** Hash of the exact signed request payload. */
  requestHash: string;

  /** Digest of the exact ordered permission request list. */
  permissionDigest: string;

  /** Requester-owned delegate DID that signed the request. */
  delegateDid: string;

  /** Preferred session TTL covered by the signed request, when supplied. */
  requestedSessionTtlSeconds?: number;

  /** Reply mode covered by the signed request. */
  reply: { mode: 'pairing' };

  /** Hash of the wallet's exact signed approval intent. */
  decisionHash: string;

  /** Per-pair ephemeral did:jwk that signed the approval intent. */
  walletDid: string;

  /** Selected wallet profile DID carried by the approval intent. */
  providerDid: string;
};

/** Confirmation frame sent by the client after human comparison. */
export type ConnectPairingConfirmation = {
  /** Protocol version. */
  version: typeof CONNECT_PROTOCOL_VERSION;

  /** Frame discriminator. */
  type: 'confirmation';

  /** Pairing this confirmation belongs to. */
  pairingId: string;

  /** Hash of the full comparison transcript. */
  transcriptHash: string;

  /** Whether the human reported that both displays match. */
  accepted: boolean;

  /** HMAC-SHA-256 over every other frame field. */
  mac: string;
};

/** Creates a fresh X25519 key, nonce, and their domain-separated commitment. */
export async function createConnectPairingKey(): Promise<ConnectPairingKey> {
  const privateKey = await X25519.generateKey();
  if (typeof privateKey.x !== 'string') {
    throw new Error('Connect: generated X25519 key is missing its public key.');
  }
  const reveal: ConnectPairingReveal = {
    publicKey : privateKey.x,
    nonce     : Convert.uint8Array(CryptoUtils.randomBytes(CONNECT_PAIRING_VALUE_BYTE_LENGTH)).toBase64Url(),
  };

  return {
    commitment: await computeConnectPairingCommitment(reveal),
    privateKey,
    reveal,
  };
}

/** Computes the canonical SHA-256 commitment for a pairing reveal. */
export async function computeConnectPairingCommitment(reveal: ConnectPairingReveal): Promise<string> {
  assertConnectPairingReveal(reveal);
  const preimage = `${KEY_COMMITMENT_DOMAIN}\0${reveal.publicKey}\0${reveal.nonce}`;
  return await sha256Base64Url(Convert.string(preimage).toUint8Array());
}

/** Fails closed unless `reveal` opens the expected commitment. */
export async function verifyConnectPairingCommitment({ commitment, reveal }: {
  commitment: string;
  reveal: ConnectPairingReveal;
}): Promise<void> {
  const expected = decodeCanonical32ByteBase64Url(commitment, 'commitment');
  const actual = Convert.base64Url(await computeConnectPairingCommitment(reveal)).toUint8Array();
  if (!constantTimeEqual(expected, actual)) {
    throw new Error('Connect: pairing reveal does not match its commitment.');
  }
}

/** Validates both commit/reveal pairs and the canonical v3 pairing context. */
export async function verifyConnectPairingContext(context: ConnectPairingContext): Promise<void> {
  if (context.version !== CONNECT_PROTOCOL_VERSION) {
    throw new Error(`Connect: unsupported pairing protocol version '${String(context.version)}'.`);
  }
  if (typeof context.pairingId !== 'string' || context.pairingId.length === 0) {
    throw new Error('Connect: pairing ID must be a non-empty string.');
  }
  assertCanonicalHttpsOrigin(context.relayOrigin, 'relay origin');
  assertCanonicalHttpsOrigin(context.walletOrigin, 'wallet origin');

  await Promise.all([
    verifyConnectPairingCommitment({ commitment: context.clientCommitment, reveal: context.clientReveal }),
    verifyConnectPairingCommitment({ commitment: context.walletCommitment, reveal: context.walletReveal }),
  ]);
}

/** Returns the SHA-256 hash of a JSON-compatible value in canonical key order. */
export async function hashConnectPayload(value: unknown): Promise<string> {
  return await sha256Base64Url(Convert.string(canonicalJsonStringify(value)).toUint8Array());
}

/** Returns the canonical hash of a full pairing comparison transcript. */
export async function hashConnectPairingTranscript(transcript: ConnectPairingTranscript): Promise<string> {
  await verifyConnectPairingContext(transcript.pairing);
  return await hashConnectPayload(transcript);
}

/**
 * Derives one domain-separated 256-bit key from the committed X25519 exchange.
 *
 * `bindingHash` is the canonical hash for the derived key's exact purpose.
 * Pairing encryption continues to use the kernel's ECDH-ES JWE envelope;
 * this HKDF is deliberately limited to SAS and authenticated control frames.
 */
export async function deriveConnectPairingKey({ privateKey, peerReveal, bindingHash, purpose }: {
  privateKey: Jwk;
  peerReveal: ConnectPairingReveal;
  bindingHash: string;
  purpose: ConnectPairingKeyPurpose;
}): Promise<Uint8Array> {
  assertConnectPairingReveal(peerReveal);
  const salt = decodeCanonical32ByteBase64Url(bindingHash, 'binding hash');
  const peerPublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: peerReveal.publicKey };
  const sharedSecret = await X25519.sharedSecret({ privateKeyA: privateKey, publicKeyB: peerPublicKey });

  if (sharedSecret.every((byte): boolean => byte === 0)) {
    throw new Error('Connect: X25519 pairing produced an invalid all-zero shared secret.');
  }

  return await Hkdf.deriveKeyBytes({
    baseKeyBytes : sharedSecret,
    hash         : 'SHA-256',
    salt,
    info         : `${KEY_DERIVATION_DOMAIN}/${purpose}`,
    length       : 256,
  });
}

/** Derives the six-digit human comparison code from the committed pairing context. */
export async function deriveConnectVerificationCode({ privateKey, peerReveal, pairingHash }: {
  privateKey: Jwk;
  peerReveal: ConnectPairingReveal;
  pairingHash: string;
}): Promise<string> {
  const bytes = await deriveConnectPairingKey({
    privateKey,
    peerReveal,
    bindingHash : pairingHash,
    purpose     : 'verification-code',
  });
  const value = (((bytes[0] << 24) >>> 0) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(value % (10 ** CONNECT_VERIFICATION_CODE_DIGITS)).padStart(CONNECT_VERIFICATION_CODE_DIGITS, '0');
}

/** Creates a MACed accept/reject frame for the comparison transcript. */
export async function createConnectPairingConfirmation({
  privateKey,
  peerReveal,
  pairingId,
  transcriptHash,
  accepted,
}: {
  privateKey: Jwk;
  peerReveal: ConnectPairingReveal;
  pairingId: string;
  transcriptHash: string;
  accepted: boolean;
}): Promise<ConnectPairingConfirmation> {
  const unsigned = {
    version : CONNECT_PROTOCOL_VERSION,
    type    : 'confirmation' as const,
    pairingId,
    transcriptHash,
    accepted,
  };
  const mac = await createFrameMac({ privateKey, peerReveal, transcriptHash, purpose: 'confirmation-mac', unsigned });
  return { ...unsigned, mac };
}

/** Verifies a comparison confirmation and returns its authenticated decision. */
export async function verifyConnectPairingConfirmation({
  frame,
  privateKey,
  peerReveal,
  expectedPairingId,
  expectedTranscriptHash,
}: {
  frame: ConnectPairingConfirmation;
  privateKey: Jwk;
  peerReveal: ConnectPairingReveal;
  expectedPairingId: string;
  expectedTranscriptHash: string;
}): Promise<boolean> {
  assertConfirmationShape(frame);
  if (frame.pairingId !== expectedPairingId || frame.transcriptHash !== expectedTranscriptHash) {
    throw new Error('Connect: pairing confirmation does not match this transcript.');
  }

  const { mac, ...unsigned } = frame;
  await verifyFrameMac({
    privateKey,
    peerReveal,
    transcriptHash : expectedTranscriptHash,
    purpose        : 'confirmation-mac',
    unsigned,
    mac,
  });
  return frame.accepted;
}

/** Runtime validation for a public pairing reveal. */
export function assertConnectPairingReveal(value: unknown): asserts value is ConnectPairingReveal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Connect: pairing reveal must be an object.');
  }
  const reveal = value as Record<string, unknown>;
  if (typeof reveal.publicKey !== 'string' || typeof reveal.nonce !== 'string') {
    throw new Error('Connect: pairing reveal must contain string `publicKey` and `nonce` values.');
  }
  decodeCanonical32ByteBase64Url(reveal.publicKey, 'pairing public key');
  decodeCanonical32ByteBase64Url(reveal.nonce, 'pairing nonce');
}

async function createFrameMac({ privateKey, peerReveal, transcriptHash, purpose, unsigned }: {
  privateKey: Jwk;
  peerReveal: ConnectPairingReveal;
  transcriptHash: string;
  purpose: 'confirmation-mac';
  unsigned: object;
}): Promise<string> {
  const key = await deriveConnectPairingKey({ privateKey, peerReveal, bindingHash: transcriptHash, purpose });
  const data = Convert.string(canonicalJsonStringify(unsigned)).toUint8Array();
  return Convert.uint8Array(await hmacSha256(key, data)).toBase64Url();
}

async function verifyFrameMac({ privateKey, peerReveal, transcriptHash, purpose, unsigned, mac }: {
  privateKey: Jwk;
  peerReveal: ConnectPairingReveal;
  transcriptHash: string;
  purpose: 'confirmation-mac';
  unsigned: object;
  mac: string;
}): Promise<void> {
  const expected = Convert.base64Url(await createFrameMac({
    privateKey,
    peerReveal,
    transcriptHash,
    purpose,
    unsigned,
  })).toUint8Array();
  const actual = decodeCanonical32ByteBase64Url(mac, 'frame MAC');
  if (!constantTimeEqual(expected, actual)) {
    throw new Error('Connect: pairing frame authentication failed.');
  }
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource));
}

async function sha256Base64Url(data: Uint8Array): Promise<string> {
  return Convert.uint8Array(await Sha256.digest({ data })).toBase64Url();
}

function decodeCanonical32ByteBase64Url(value: string, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`Connect: ${field} must be canonical base64url for exactly 32 bytes.`);
  }

  const bytes = Convert.base64Url(value).toUint8Array();
  if (
    bytes.length !== CONNECT_PAIRING_VALUE_BYTE_LENGTH
    || Convert.uint8Array(bytes).toBase64Url() !== value
  ) {
    throw new Error(`Connect: ${field} must be canonical base64url for exactly 32 bytes.`);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function assertConfirmationShape(frame: ConnectPairingConfirmation): void {
  if (
    frame.version !== CONNECT_PROTOCOL_VERSION
    || frame.type !== 'confirmation'
    || typeof frame.pairingId !== 'string'
    || typeof frame.transcriptHash !== 'string'
    || typeof frame.accepted !== 'boolean'
    || typeof frame.mac !== 'string'
  ) {
    throw new Error('Connect: invalid pairing confirmation frame.');
  }
  decodeCanonical32ByteBase64Url(frame.transcriptHash, 'transcript hash');
}

function assertCanonicalHttpsOrigin(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Connect: ${label} must be a canonical HTTPS origin.`);
  }
  const isLoopbackHttp = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if ((url.protocol !== 'https:' && !isLoopbackHttp) || url.origin !== value) {
    throw new Error(`Connect: ${label} must be a canonical HTTPS origin or an HTTP loopback origin.`);
  }
}
