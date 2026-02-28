import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Convert } from '../../src/convert.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('Convert — fuzz', () => {

  describe('Uint8Array -> Base64Url -> Uint8Array roundtrip', () => {
    it('should return identical bytes', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 2048 }),
          (bytes) => {
            const encoded = Convert.uint8Array(bytes).toBase64Url();
            const decoded = Convert.base64Url(encoded).toUint8Array();
            expect(decoded).toEqual(bytes);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('Uint8Array -> Hex -> Uint8Array roundtrip', () => {
    it('should return identical bytes', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 2048 }),
          (bytes) => {
            const encoded = Convert.uint8Array(bytes).toHex();
            const decoded = Convert.hex(encoded).toUint8Array();
            expect(decoded).toEqual(bytes);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('Uint8Array -> Base58Btc -> Uint8Array roundtrip', () => {
    it('should return identical bytes', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 512 }),
          (bytes) => {
            const encoded = Convert.uint8Array(bytes).toBase58Btc();
            const decoded = Convert.base58Btc(encoded).toUint8Array();
            expect(decoded).toEqual(bytes);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('Uint8Array -> Base32Z -> Uint8Array roundtrip', () => {
    it('should return identical bytes', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 512 }),
          (bytes) => {
            const encoded = Convert.uint8Array(bytes).toBase32Z();
            const decoded = Convert.base32Z(encoded).toUint8Array();
            expect(decoded).toEqual(bytes);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('String -> Uint8Array -> String roundtrip', () => {
    it('should return identical strings', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 500 }),
          (str) => {
            const bytes = Convert.string(str).toUint8Array();
            const decoded = Convert.uint8Array(bytes).toString();
            expect(decoded).toBe(str);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('Object -> Base64Url -> Object roundtrip', () => {
    it('should return equivalent objects for JSON-serializable inputs', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
            { minKeys: 0, maxKeys: 5 },
          ),
          (obj) => {
            const encoded = Convert.object(obj).toBase64Url();
            const decoded = Convert.base64Url(encoded).toObject();
            expect(decoded).toEqual(obj);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('Hex encoding — always produces even-length lowercase hex', () => {
    it('should produce a string of length 2 * bytes.length', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 256 }),
          (bytes) => {
            const hex = Convert.uint8Array(bytes).toHex();
            expect(hex.length).toBe(bytes.length * 2);
            expect(hex).toMatch(/^[0-9a-f]*$/);
          }
        ),
        { numRuns }
      );
    });
  });
});
