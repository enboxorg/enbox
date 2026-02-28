import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { computeJwkThumbprint } from '../../src/jose/jwk.js';

import type { Jwk } from '../../src/jose/jwk.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('computeJwkThumbprint — fuzz', () => {

  /**
   * Arbitrary for an EC (secp256k1) public JWK with valid-shaped x/y values.
   */
  const arbEcJwk = fc.record({
    kty : fc.constant('EC' as const),
    crv : fc.constantFrom('secp256k1', 'P-256', 'P-384'),
    x   : fc.base64String({ minLength: 20, maxLength: 50 }),
    y   : fc.base64String({ minLength: 20, maxLength: 50 }),
  });

  /**
   * Arbitrary for an OKP (Ed25519/X25519) public JWK.
   */
  const arbOkpJwk = fc.record({
    kty : fc.constant('OKP' as const),
    crv : fc.constantFrom('Ed25519', 'X25519'),
    x   : fc.base64String({ minLength: 20, maxLength: 50 }),
  });

  /**
   * Arbitrary for an oct symmetric JWK.
   */
  const arbOctJwk = fc.record({
    kty : fc.constant('oct' as const),
    k   : fc.base64String({ minLength: 20, maxLength: 50 }),
  });

  const arbAnyJwk = fc.oneof(arbEcJwk, arbOkpJwk, arbOctJwk);

  describe('determinism', () => {
    it('should produce the same thumbprint for the same key', async () => {
      await fc.assert(
        fc.asyncProperty(arbAnyJwk, async (jwk) => {
          const t1 = await computeJwkThumbprint({ jwk: jwk as Jwk });
          const t2 = await computeJwkThumbprint({ jwk: jwk as Jwk });
          expect(t1).toBe(t2);
        }),
        { numRuns }
      );
    });
  });

  describe('optional property independence', () => {
    it('should produce the same thumbprint regardless of optional properties', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAnyJwk,
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.constantFrom('sig', 'enc'),
          fc.constantFrom('sign', 'verify', 'encrypt', 'decrypt'),
          async (baseJwk, kid, use, keyOp) => {
            const jwkPlain = { ...baseJwk } as Jwk;
            const jwkWithOptionals = {
              ...baseJwk,
              kid,
              use,
              key_ops : [keyOp],
              alg     : 'ES256K',
            } as Jwk;

            const t1 = await computeJwkThumbprint({ jwk: jwkPlain });
            const t2 = await computeJwkThumbprint({ jwk: jwkWithOptionals });
            expect(t1).toBe(t2);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('key type isolation — different required members produce different thumbprints', () => {
    it('should produce different thumbprints for different key material', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.base64String({ minLength: 20, maxLength: 50 }),
          fc.base64String({ minLength: 20, maxLength: 50 }),
          async (x1, x2) => {
            // Skip if the x values are identical
            if (x1 === x2) {
              return;
            }

            const jwk1: Jwk = { kty: 'OKP', crv: 'Ed25519', x: x1 };
            const jwk2: Jwk = { kty: 'OKP', crv: 'Ed25519', x: x2 };
            const t1 = await computeJwkThumbprint({ jwk: jwk1 });
            const t2 = await computeJwkThumbprint({ jwk: jwk2 });
            expect(t1).not.toBe(t2);
          }
        ),
        { numRuns }
      );
    });
  });
});
