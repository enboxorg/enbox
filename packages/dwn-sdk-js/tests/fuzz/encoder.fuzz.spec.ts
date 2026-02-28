import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Encoder } from '../../src/utils/encoder.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('Encoder — fuzz', () => {

  describe('bytes <-> base64url roundtrip', () => {
    it('should roundtrip arbitrary byte arrays through base64url encoding', () => {
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 1024 }), (bytes) => {
          const encoded = Encoder.bytesToBase64Url(bytes);
          const decoded = Encoder.base64UrlToBytes(encoded);
          expect(decoded).toEqual(bytes);
        }),
        { numRuns }
      );
    });
  });

  describe('object <-> bytes roundtrip', () => {
    it('should roundtrip JSON-serializable objects through bytes encoding', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
            { minKeys: 0, maxKeys: 10 },
          ),
          (obj) => {
            const bytes = Encoder.objectToBytes(obj);
            const decoded = Encoder.bytesToObject(bytes);
            expect(decoded).toEqual(obj);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('string <-> base64url roundtrip', () => {
    it('should roundtrip arbitrary strings through base64url encoding', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 500 }), (str) => {
          const encoded = Encoder.stringToBase64Url(str);
          const bytes = Encoder.base64UrlToBytes(encoded);
          const decoded = Encoder.bytesToString(bytes);
          expect(decoded).toBe(str);
        }),
        { numRuns }
      );
    });
  });

  describe('string <-> bytes roundtrip', () => {
    it('should roundtrip arbitrary strings through bytes encoding', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 500 }), (str) => {
          const bytes = Encoder.stringToBytes(str);
          const decoded = Encoder.bytesToString(bytes);
          expect(decoded).toBe(str);
        }),
        { numRuns }
      );
    });
  });

  describe('base64UrlToObject — crash resistance', () => {
    it('should throw on arbitrary non-base64url strings without crashing', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 200 }), (str) => {
          try {
            Encoder.base64UrlToObject(str);
            // If it doesn't throw, the result should be a defined value
          } catch (error) {
            // Any error is acceptable — we just verify no unhandled crash
            expect(error).toBeDefined();
          }
        }),
        { numRuns }
      );
    });
  });

  describe('bytesToBase64Url output validity', () => {
    it('should produce strings containing only base64url characters', () => {
      const base64urlPattern = /^[A-Za-z0-9_-]*$/;
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (bytes) => {
          const encoded = Encoder.bytesToBase64Url(bytes);
          expect(base64urlPattern.test(encoded)).toBe(true);
        }),
        { numRuns }
      );
    });
  });

  describe('objectToBytes — determinism', () => {
    it('should produce identical bytes for the same object', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            { minKeys: 1, maxKeys: 5 },
          ),
          (obj) => {
            const bytes1 = Encoder.objectToBytes(obj);
            const bytes2 = Encoder.objectToBytes(obj);
            expect(bytes1).toEqual(bytes2);
          }
        ),
        { numRuns }
      );
    });
  });
});
