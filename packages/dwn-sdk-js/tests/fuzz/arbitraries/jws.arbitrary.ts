/**
 * fast-check arbitraries for generating JWS (JSON Web Signature) structures.
 */
import type { Arbitrary } from 'fast-check';
import type { GeneralJws, SignatureEntry } from '../../../src/types/jws-types.js';

import fc from 'fast-check';

/**
 * Generates a base64url-encoded string (valid base64url alphabet: A-Z, a-z, 0-9, -, _).
 * Uses fc.base64String and replaces non-url-safe chars, since fc.stringOf does not exist in v4.
 */
export function base64UrlString(opts: { minLength?: number; maxLength?: number } = {}): Arbitrary<string> {
  const { minLength = 1, maxLength = 100 } = opts;
  return fc.base64String({ minLength, maxLength })
    .map((s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''));
}

/**
 * Generates a single JWS signature entry with random but structurally valid base64url fields.
 */
export function signatureEntry(): Arbitrary<SignatureEntry> {
  return fc.record({
    protected : base64UrlString({ minLength: 4, maxLength: 200 }),
    signature : base64UrlString({ minLength: 4, maxLength: 200 }),
  });
}

/**
 * Generates a GeneralJws with a random payload and 1-3 signature entries.
 */
export function generalJws(): Arbitrary<GeneralJws> {
  return fc.record({
    payload    : base64UrlString({ minLength: 4, maxLength: 500 }),
    signatures : fc.array(signatureEntry(), { minLength: 1, maxLength: 3 }),
  });
}

/**
 * Generates a GeneralJws-like object with potentially missing or malformed fields.
 */
export function malformedJws(): Arbitrary<Record<string, unknown>> {
  return fc.oneof(
    // Missing payload
    fc.record({
      signatures: fc.array(signatureEntry(), { minLength: 1, maxLength: 2 }),
    }),
    // Missing signatures
    fc.record({
      payload: base64UrlString(),
    }),
    // Empty signatures array
    fc.record({
      payload    : base64UrlString(),
      signatures : fc.constant([]),
    }),
    // Payload is not base64url
    fc.record({
      payload    : fc.string(),
      signatures : fc.array(signatureEntry(), { minLength: 1, maxLength: 2 }),
    }),
    // Completely random object
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
      { minKeys: 0, maxKeys: 5 },
    ),
  );
}
