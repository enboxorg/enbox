import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Secp256k1 } from '../../src/utils/secp256k1.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('Secp256k1 — fuzz', () => {

  describe('publicKeyToJwk/publicJwkToBytes roundtrip', () => {
    it('should roundtrip compressed public key bytes through JWK and back', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          const { publicKey } = await Secp256k1.generateKeyPairRaw();
          const jwk = await Secp256k1.publicKeyToJwk(publicKey);
          const roundtripped = Secp256k1.publicJwkToBytes(jwk);
          // roundtripped is compressed (33 bytes), original publicKey is also compressed (33 bytes)
          expect(Buffer.from(roundtripped).equals(Buffer.from(publicKey))).toBe(true);
        }),
        { numRuns }
      );
    });
  });

  describe('privateKeyToJwk/privateJwkToBytes roundtrip', () => {
    it('should roundtrip private key bytes through JWK and back', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          const { privateKey } = await Secp256k1.generateKeyPairRaw();
          const jwk = await Secp256k1.privateKeyToJwk(privateKey);
          const roundtripped = Secp256k1.privateJwkToBytes(jwk);
          expect(Buffer.from(roundtripped).equals(Buffer.from(privateKey))).toBe(true);
        }),
        { numRuns }
      );
    });
  });

  describe('sign/verify consistency', () => {
    it('should verify a signature produced by the corresponding private key', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 256 }),
          async (content) => {
            const { publicJwk, privateJwk } = await Secp256k1.generateKeyPair();
            const signature = await Secp256k1.sign(content, privateJwk);
            const valid = await Secp256k1.verify(content, signature, publicJwk);
            expect(valid).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('sign/verify non-forgery', () => {
    it('should reject a signature when content is modified', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 256 }),
          fc.integer({ min: 0, max: 255 }),
          async (content, xorByte) => {
            const { publicJwk, privateJwk } = await Secp256k1.generateKeyPair();
            const signature = await Secp256k1.sign(content, privateJwk);

            // Flip a byte in the content
            const modified = new Uint8Array(content);
            const flipIndex = xorByte % modified.length;
            modified[flipIndex] = modified[flipIndex] ^ 0xff;

            // If the modified content happens to be identical (all 0xff flipped to 0x00 and vice versa),
            // skip this test case
            if (Buffer.from(modified).equals(Buffer.from(content))) {
              return;
            }

            const valid = await Secp256k1.verify(modified, signature, publicJwk);
            expect(valid).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('compressed/uncompressed equivalence', () => {
    it('should produce the same JWK x and y from both compressed and uncompressed public keys', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          // generateKeyPairRaw returns compressed, generateKeyPair uses uncompressed internally
          const { publicKey: compressedKey, privateKey } = await Secp256k1.generateKeyPairRaw();
          const jwkFromCompressed = await Secp256k1.publicKeyToJwk(compressedKey);

          // Get uncompressed form via getPublicKey with false
          const { secp256k1 } = await import('@noble/curves/secp256k1');
          const uncompressedKey = secp256k1.getPublicKey(privateKey, false);
          const jwkFromUncompressed = await Secp256k1.publicKeyToJwk(uncompressedKey);

          const compressedEc = jwkFromCompressed as { x: string; y?: string };
          const uncompressedEc = jwkFromUncompressed as { x: string; y?: string };
          expect(compressedEc.x).toBe(uncompressedEc.x);
          expect(compressedEc.y).toBe(uncompressedEc.y);
        }),
        { numRuns }
      );
    });
  });
});
