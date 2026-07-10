/**
 * JWT signing and verification for connect envelope payloads.
 *
 * Connect payloads are signed as EdDSA JWTs by short-lived `did:jwk`
 * identifiers. Verification is pinned to the `did:jwk` method: the `kid`
 * header must reference a `did:jwk` verification method, so key resolution is
 * a pure local computation with no network I/O and no resolver ambiguity.
 *
 * @module
 */

import type { BearerDid } from '@enbox/dids';
import type { JoseHeaderParams } from '@enbox/crypto';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { EdDsaAlgorithm } from '@enbox/crypto';

/** Result of verifying a connect JWT. */
export type VerifyJwtResult = {
  /**
   * The parsed JWT payload as an untyped object.
   *
   * The type is intentionally `Record<string, unknown>` rather than a
   * caller-supplied generic — a JWT payload is bytes from a remote party, and
   * its shape cannot be soundly asserted without runtime validation. Callers
   * must apply `assertConnectRequest` / `assertConnectResponse` (or their own
   * type guard) to narrow the payload before accessing fields.
   */
  payload: Record<string, unknown>;

  /** The DID URI extracted from the verified `kid` header (the signer's DID). */
  signerDid: string;
};

/**
 * Signs an object as an EdDSA JWT using the DID's first verification method.
 *
 * `data` is constrained to `object` so callers don't have to widen typed
 * payload shapes (e.g. `ConnectResponse`) to `Record<string, unknown>` at the
 * call site — `Convert.object(data)` stringifies whatever JSON-serializable
 * shape is passed.
 *
 * @param params - The signing parameters.
 * @param params.did - The `did:jwk` bearer DID whose key signs the JWT.
 * @param params.data - The JSON-serializable payload to sign.
 * @returns A promise resolving to the compact JWT string.
 */
export async function signJwt({ did, data }: {
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
 * Verifies an EdDSA JWT signature using the `did:jwk` DID in the `kid`
 * header, returning the parsed payload and the signer's DID URI.
 *
 * Verification is pinned to `did:jwk`: any other DID method in `kid` is
 * rejected before resolution, and resolution itself is the local `did:jwk`
 * decoding — no network I/O.
 *
 * @param params - The verification parameters.
 * @param params.jwt - The compact JWT string to verify.
 * @returns A promise resolving to the parsed payload and signer DID.
 * @throws Error if the JWT is malformed, uses an unexpected algorithm, the
 *         `kid` is missing or not a `did:jwk`, or the signature is invalid.
 */
export async function verifyJwt({ jwt }: { jwt: string }): Promise<VerifyJwtResult> {
  const { 0: headerB64U, 1: payloadB64U, 2: signatureB64U, length } = jwt.split('.');

  if (length !== 3 || !headerB64U || !payloadB64U || !signatureB64U) {
    throw new Error('Connect: JWT verification failed — JWT must have 3 parts.');
  }

  let header: JoseHeaderParams & { alg?: string };
  try {
    header = Convert.base64Url(headerB64U).toObject();
  } catch {
    throw new Error('Connect: JWT verification failed — malformed JWT header.');
  }

  if (header.alg !== 'EdDSA') {
    throw new Error('Connect: JWT verification failed — "alg" must be "EdDSA".');
  }

  if (!header.kid) {
    throw new Error('Connect: JWT missing required "kid" header value.');
  }

  const signerDid = header.kid.split('#')[0];
  if (!signerDid.startsWith('did:jwk:')) {
    throw new Error('Connect: JWT verification failed — "kid" must reference a did:jwk verification method.');
  }

  const { didDocument } = await DidJwk.resolve(signerDid);

  if (!didDocument) {
    throw new Error('Connect: JWT verification failed — could not resolve DID.');
  }

  const { publicKeyJwk } = didDocument.verificationMethod?.find(
    (method): boolean => method.id === header.kid
  ) ?? {};

  if (!publicKeyJwk) {
    throw new Error('Connect: JWT verification failed — public key not found in DID document.');
  }

  const edDsa = new EdDsaAlgorithm();
  const isValid = await edDsa.verify({
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

  return { payload: decoded as Record<string, unknown>, signerDid };
}
