import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Multicodec } from '../../src/multicodec.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

/** The pre-registered codecs in the Multicodec class. */
const registeredCodecs = [
  { name: 'ed25519-pub', code: 0xed },
  { name: 'ed25519-priv', code: 0x1300 },
  { name: 'x25519-pub', code: 0xec },
  { name: 'x25519-priv', code: 0x1302 },
  { name: 'secp256k1-pub', code: 0xe7 },
  { name: 'secp256k1-priv', code: 0x1301 },
];

describe('Multicodec — fuzz', () => {

  describe('addPrefix / removePrefix roundtrip', () => {
    it('should return the original data and correct code/name for any registered codec', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...registeredCodecs),
          fc.uint8Array({ minLength: 0, maxLength: 256 }),
          (codec, data) => {
            const prefixed = Multicodec.addPrefix({ code: codec.code, data });
            const result = Multicodec.removePrefix({ prefixedData: prefixed });

            expect(result.code).toBe(codec.code);
            expect(result.name).toBe(codec.name);
            expect(result.data).toEqual(data);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getCodeFromData consistency', () => {
    it('should extract the same code that was used to prefix', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...registeredCodecs),
          fc.uint8Array({ minLength: 0, maxLength: 128 }),
          (codec, data) => {
            const prefixed = Multicodec.addPrefix({ code: codec.code, data });
            const extractedCode = Multicodec.getCodeFromData({ prefixedData: prefixed });
            expect(extractedCode).toBe(codec.code);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('prefixed data length', () => {
    it('should be original data length plus the varint prefix length', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...registeredCodecs),
          fc.uint8Array({ minLength: 0, maxLength: 256 }),
          (codec, data) => {
            const prefixed = Multicodec.addPrefix({ code: codec.code, data });
            // varint encoding: codes < 128 use 1 byte, codes < 16384 use 2 bytes
            const varintLength = codec.code < 128 ? 1 : codec.code < 16384 ? 2 : 3;
            expect(prefixed.length).toBe(data.length + varintLength);
          }
        ),
        { numRuns }
      );
    });
  });
});
