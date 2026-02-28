import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { ConcatKdf } from '../../src/primitives/concat-kdf.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('ConcatKdf — fuzz', () => {

  /**
   * Arbitrary for a valid shared secret (16–64 bytes).
   */
  const arbSharedSecret = fc.uint8Array({ minLength: 16, maxLength: 64 });

  /**
   * Arbitrary for a non-empty algorithm ID string.
   */
  const arbAlgorithmId = fc.constantFrom('A128GCM', 'A192GCM', 'A256GCM', 'A128CBC-HS256', 'A256CBC-HS512');

  /**
   * Arbitrary for party info strings.
   */
  const arbPartyInfo = fc.string({ minLength: 1, maxLength: 30 });

  /**
   * Key data length — must be <= 256 bits (single SHA-256 round).
   */
  const arbKeyDataLen = fc.constantFrom(128, 192, 256);

  describe('determinism', () => {
    it('should produce identical derived keys for identical inputs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSharedSecret, arbAlgorithmId, arbPartyInfo, arbPartyInfo, arbKeyDataLen,
          async (sharedSecret, algorithmId, partyU, partyV, keyDataLen) => {
            const params = {
              sharedSecret,
              keyDataLen,
              fixedInfo: { algorithmId, partyUInfo: partyU, partyVInfo: partyV, suppPubInfo: keyDataLen },
            };
            const key1 = await ConcatKdf.deriveKey(params);
            const key2 = await ConcatKdf.deriveKey(params);
            expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('output length', () => {
    it('should produce a key of exactly keyDataLen / 8 bytes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSharedSecret, arbAlgorithmId, arbPartyInfo, arbPartyInfo, arbKeyDataLen,
          async (sharedSecret, algorithmId, partyU, partyV, keyDataLen) => {
            const key = await ConcatKdf.deriveKey({
              sharedSecret,
              keyDataLen,
              fixedInfo: { algorithmId, partyUInfo: partyU, partyVInfo: partyV, suppPubInfo: keyDataLen },
            });
            expect(key.byteLength).toBe(keyDataLen / 8);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('different inputs produce different keys', () => {
    it('should produce different keys when sharedSecret differs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSharedSecret, arbSharedSecret, arbAlgorithmId, arbPartyInfo, arbPartyInfo, arbKeyDataLen,
          async (secret1, secret2, algorithmId, partyU, partyV, keyDataLen) => {
            // Skip if secrets are identical
            if (Buffer.from(secret1).equals(Buffer.from(secret2))) {
              return;
            }

            const fixedInfo = { algorithmId, partyUInfo: partyU, partyVInfo: partyV, suppPubInfo: keyDataLen };
            const key1 = await ConcatKdf.deriveKey({ sharedSecret: secret1, keyDataLen, fixedInfo });
            const key2 = await ConcatKdf.deriveKey({ sharedSecret: secret2, keyDataLen, fixedInfo });
            expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('different algorithmId produces different keys', () => {
    it('should produce different keys when algorithmId differs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSharedSecret, arbPartyInfo, arbPartyInfo, arbKeyDataLen,
          async (sharedSecret, partyU, partyV, keyDataLen) => {
            const key1 = await ConcatKdf.deriveKey({
              sharedSecret,
              keyDataLen,
              fixedInfo: { algorithmId: 'A128GCM', partyUInfo: partyU, partyVInfo: partyV, suppPubInfo: keyDataLen },
            });
            const key2 = await ConcatKdf.deriveKey({
              sharedSecret,
              keyDataLen,
              fixedInfo: { algorithmId: 'A256GCM', partyUInfo: partyU, partyVInfo: partyV, suppPubInfo: keyDataLen },
            });
            expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });
});
