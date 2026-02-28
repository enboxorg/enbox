import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { HdKey } from '../../src/utils/hd-key.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('HdKey — fuzz', () => {

  /**
   * Generate a valid 32-byte key for use as base key material.
   */
  const arbPrivateKey = fc.uint8Array({ minLength: 32, maxLength: 32 });

  /**
   * A non-empty derivation path segment (no empty strings allowed).
   */
  const arbSegment = fc.string({ minLength: 1, maxLength: 20 });

  /**
   * A valid derivation path (1–5 non-empty segments).
   */
  const arbPath = fc.array(arbSegment, { minLength: 1, maxLength: 5 });

  describe('derivePrivateKeyBytes — determinism', () => {
    it('should produce identical output for identical inputs', async () => {
      await fc.assert(
        fc.asyncProperty(arbPrivateKey, arbPath, async (key, path) => {
          const result1 = await HdKey.derivePrivateKeyBytes(key, path);
          const result2 = await HdKey.derivePrivateKeyBytes(key, path);
          expect(Encoder.bytesToBase64Url(result1)).toBe(Encoder.bytesToBase64Url(result2));
        }),
        { numRuns }
      );
    });
  });

  describe('derivePrivateKeyBytes — output size', () => {
    it('should always produce a 32-byte derived key', async () => {
      await fc.assert(
        fc.asyncProperty(arbPrivateKey, arbPath, async (key, path) => {
          const result = await HdKey.derivePrivateKeyBytes(key, path);
          expect(result.byteLength).toBe(32);
        }),
        { numRuns }
      );
    });
  });

  describe('derivePrivateKeyBytes — path order sensitivity', () => {
    it('should produce different keys for reversed non-palindrome paths', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbPrivateKey,
          fc.array(arbSegment, { minLength: 2, maxLength: 5 }).filter((segs) => {
            // ensure path is NOT a palindrome so reversing changes it
            const reversed = [...segs].reverse();
            return segs.some((s, i) => s !== reversed[i]);
          }),
          async (key, path) => {
            const forward = await HdKey.derivePrivateKeyBytes(key, path);
            const reversed = await HdKey.derivePrivateKeyBytes(key, [...path].reverse());
            // different path order should produce different key (with overwhelming probability)
            const forwardB64 = Encoder.bytesToBase64Url(forward);
            const reversedB64 = Encoder.bytesToBase64Url(reversed);
            expect(forwardB64).not.toBe(reversedB64);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('derivePrivateKeyBytes — incremental derivation equivalence', () => {
    it('should produce the same key whether derived all at once or incrementally', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbPrivateKey,
          fc.array(arbSegment, { minLength: 2, maxLength: 5 }),
          fc.integer({ min: 1 }).chain((splitCandidate) =>
            fc.constant(splitCandidate)
          ),
          async (key, path, splitCandidate) => {
            // Split the path at an arbitrary point
            const splitIndex = (splitCandidate % (path.length - 1)) + 1;
            const prefix = path.slice(0, splitIndex);
            const suffix = path.slice(splitIndex);

            // Derive all at once
            const allAtOnce = await HdKey.derivePrivateKeyBytes(key, path);

            // Derive incrementally: first prefix, then suffix from intermediate key
            const intermediate = await HdKey.derivePrivateKeyBytes(key, prefix);
            const incremental = await HdKey.derivePrivateKeyBytes(intermediate, suffix);

            expect(Encoder.bytesToBase64Url(allAtOnce)).toBe(Encoder.bytesToBase64Url(incremental));
          }
        ),
        { numRuns }
      );
    });
  });

  describe('derivePrivateKeyBytes — empty segment rejection', () => {
    it('should throw HdKeyDerivationPathInvalid when any segment is empty', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbPrivateKey,
          fc.array(fc.string({ maxLength: 10 }), { minLength: 1, maxLength: 5 }).filter((segs) =>
            segs.some((s) => s === '')
          ),
          async (key, pathWithEmpty) => {
            await expect(HdKey.derivePrivateKeyBytes(key, pathWithEmpty)).rejects.toThrow(
              DwnErrorCode.HdKeyDerivationPathInvalid
            );
          }
        ),
        { numRuns }
      );
    });
  });
});
