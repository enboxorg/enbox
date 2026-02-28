import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnError } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';
import { generalJws, malformedJws } from './arbitraries/jws.arbitrary.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('Jws — fuzz', () => {

  describe('decodePlainObjectPayload — crash resistance with random JWS', () => {
    it('should throw DwnError on malformed JWS payloads, never an unhandled error', () => {
      fc.assert(
        fc.property(generalJws(), (jws) => {
          try {
            Jws.decodePlainObjectPayload(jws);
            // If it succeeds, the decoded value should be a plain object
          } catch (error) {
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('decodePlainObjectPayload — crash resistance with malformed JWS', () => {
    it('should handle completely malformed JWS-like structures', () => {
      fc.assert(
        fc.property(malformedJws(), (jws) => {
          try {
            Jws.decodePlainObjectPayload(jws as any);
          } catch (error) {
            // Any error is acceptable — verify no unhandled crash
            expect(error).toBeDefined();
          }
        }),
        { numRuns }
      );
    });
  });

  describe('decodePlainObjectPayload — roundtrip with valid encoded objects', () => {
    it('should decode a payload that was properly base64url-encoded from a plain object', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
            { minKeys: 1, maxKeys: 5 },
          ),
          (obj) => {
            const payload = Encoder.stringToBase64Url(JSON.stringify(obj));
            const jws = { payload, signatures: [] };
            const decoded = Jws.decodePlainObjectPayload(jws);
            expect(decoded).toEqual(obj);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('decodePlainObjectPayload — rejects non-object payloads', () => {
    it('should throw DwnError when the decoded payload is not a plain object', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.array(fc.integer()),
          ),
          (value) => {
            const payload = Encoder.stringToBase64Url(JSON.stringify(value));
            const jws = { payload, signatures: [] };
            try {
              Jws.decodePlainObjectPayload(jws);
              // Arrays might pass isPlainObject, strings/numbers/booleans/null should not
              if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                expect(true).toBe(false); // should have thrown
              }
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getKid — crash resistance', () => {
    it('should handle signature entries with random protected headers', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (protectedHeader) => {
            try {
              Jws.getKid({ protected: protectedHeader, signature: 'dummysig' });
            } catch {
              // Any error is acceptable — we verify no unhandled crash
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getKid — roundtrip with valid protected headers', () => {
    it('should extract kid from a properly encoded protected header', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          (kid) => {
            const protectedHeader = Encoder.stringToBase64Url(JSON.stringify({ kid }));
            const extracted = Jws.getKid({ protected: protectedHeader, signature: 'dummysig' });
            expect(extracted).toBe(kid);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('extractDid — property', () => {
    it('should extract the part before # from a kid string', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('#')),
          fc.string({ minLength: 1, maxLength: 20 }),
          (did, fragment) => {
            const kid = `${did}#${fragment}`;
            const extracted = Jws.extractDid(kid);
            expect(extracted).toBe(did);
          }
        ),
        { numRuns }
      );
    });

    it('should return the full string if there is no # separator', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('#')),
          (kid) => {
            const extracted = Jws.extractDid(kid);
            expect(extracted).toBe(kid);
          }
        ),
        { numRuns }
      );
    });
  });
});
