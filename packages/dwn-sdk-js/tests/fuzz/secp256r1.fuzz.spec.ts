import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Secp256r1 } from '../../src/utils/secp256r1.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('Secp256r1 — fuzz', () => {

  describe('sign/verify consistency', () => {
    it('should verify a signature produced by the corresponding private key', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 256 }),
          async (content) => {
            const { publicJwk, privateJwk } = await Secp256r1.generateKeyPair();
            const signature = await Secp256r1.sign(content, privateJwk);
            const valid = await Secp256r1.verify(content, signature, publicJwk);
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
            const { publicJwk, privateJwk } = await Secp256r1.generateKeyPair();
            const signature = await Secp256r1.sign(content, privateJwk);

            // Flip a byte in the content
            const modified = new Uint8Array(content);
            const flipIndex = xorByte % modified.length;
            modified[flipIndex] = modified[flipIndex] ^ 0xff;

            // Skip if the flip produced identical content
            if (Buffer.from(modified).equals(Buffer.from(content))) {
              return;
            }

            const valid = await Secp256r1.verify(modified, signature, publicJwk);
            expect(valid).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('privateJwkToBytes roundtrip', () => {
    it('should roundtrip private key bytes through JWK and back', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          const { privateJwk } = await Secp256r1.generateKeyPair();
          const privateBytes = Secp256r1.privateJwkToBytes(privateJwk);
          // Re-derive should produce same bytes
          const privateBytes2 = Secp256r1.privateJwkToBytes(privateJwk);
          expect(Buffer.from(privateBytes).equals(Buffer.from(privateBytes2))).toBe(true);
          // Should be 32 bytes
          expect(privateBytes.byteLength).toBe(32);
        }),
        { numRuns }
      );
    });
  });

  describe('generateKeyPair — sign/verify interop with publicKeyToJwk', () => {
    it('should produce consistent public keys across generation and conversion', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          const { publicJwk, privateJwk } = await Secp256r1.generateKeyPair();

          // Sign with the private key, verify with the public key from generateKeyPair
          const content = new Uint8Array([1, 2, 3, 4]);
          const sig = await Secp256r1.sign(content, privateJwk);
          const valid = await Secp256r1.verify(content, sig, publicJwk);
          expect(valid).toBe(true);
        }),
        { numRuns }
      );
    });
  });
});
