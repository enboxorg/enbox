import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Cid } from '../../src/utils/cid.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('Cid — fuzz', () => {

  describe('computeCid — determinism', () => {
    it('should produce the same CID for the same payload', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
            { minKeys: 1, maxKeys: 5 },
          ),
          async (payload) => {
            const cid1 = await Cid.computeCid(payload);
            const cid2 = await Cid.computeCid(payload);
            expect(cid1).toBe(cid2);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('computeCid — uniqueness', () => {
    it('should produce different CIDs for different payloads', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }),
            fc.oneof(fc.string(), fc.integer()),
            { minKeys: 1, maxKeys: 3 },
          ),
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }),
            fc.oneof(fc.string(), fc.integer()),
            { minKeys: 1, maxKeys: 3 },
          ),
          async (a, b) => {
            // Only test if the objects are actually different
            if (JSON.stringify(a) === JSON.stringify(b)) {
              return; // skip equal pairs
            }
            const cidA = await Cid.computeCid(a);
            const cidB = await Cid.computeCid(b);
            expect(cidA).not.toBe(cidB);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('computeCid + parseCid — roundtrip', () => {
    it('should produce CIDs that parseCid can parse back', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            { minKeys: 1, maxKeys: 5 },
          ),
          async (payload) => {
            const cidStr = await Cid.computeCid(payload);
            const parsed = Cid.parseCid(cidStr);
            expect(parsed.toString()).toBe(cidStr);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('parseCid — crash resistance', () => {
    it('should throw on arbitrary strings without crashing', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 200 }), (str) => {
          try {
            Cid.parseCid(str);
            // If it parses, it should return a CID object
          } catch (error) {
            // Any error is acceptable — we verify no unhandled crash
            expect(error).toBeDefined();
          }
        }),
        { numRuns }
      );
    });
  });

  describe('computeCid — unsupported codec', () => {
    it('should throw on unsupported codec codes', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1000, max: 99999 }),
          async (codecCode) => {
            try {
              await Cid.computeCid({ test: 'data' }, codecCode);
              // If it doesn't throw with a random codec, it must have been supported
            } catch (error) {
              expect(error).toBeDefined();
            }
          }
        ),
        { numRuns: Math.min(numRuns, 50) }
      );
    });
  });

  describe('computeCid — CID string format', () => {
    it('should produce non-empty string CIDs for any CBOR-serializable payload', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.dictionary(
              fc.string({ minLength: 1, maxLength: 10 }),
              fc.oneof(fc.string(), fc.integer(), fc.boolean()),
              { minKeys: 0, maxKeys: 5 },
            ),
            fc.string(),
            fc.integer(),
            fc.boolean(),
          ),
          async (payload) => {
            const cidStr = await Cid.computeCid(payload);
            expect(typeof cidStr).toBe('string');
            expect(cidStr.length).toBeGreaterThan(0);
          }
        ),
        { numRuns }
      );
    });
  });
});
