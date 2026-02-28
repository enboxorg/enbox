import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { canonicalize } from '../../src/jose/utils.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('canonicalize (JCS / RFC 8785) — fuzz', () => {

  describe('idempotency', () => {
    it('should produce the same result when re-parsed and re-canonicalized', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
            { minKeys: 0, maxKeys: 6 },
          ),
          (obj) => {
            const first = canonicalize(obj);
            const reparsed = JSON.parse(first);
            const second = canonicalize(reparsed);
            expect(second).toBe(first);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('key order independence', () => {
    it('should produce identical output for objects with same keys in different order', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 8 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
            { minKeys: 2, maxKeys: 6 },
          ),
          (obj) => {
            // Create a copy with reversed key order
            const keys = Object.keys(obj);
            const reversed: Record<string, unknown> = {};
            for (let i = keys.length - 1; i >= 0; i--) {
              reversed[keys[i]] = obj[keys[i]];
            }

            expect(canonicalize(reversed)).toBe(canonicalize(obj));
          }
        ),
        { numRuns }
      );
    });
  });

  describe('output is valid JSON', () => {
    it('should always produce parseable JSON', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 8 }),
            fc.oneof(
              fc.string(),
              fc.integer(),
              fc.boolean(),
              fc.constant(null),
              fc.array(fc.oneof(fc.string(), fc.integer()), { minLength: 0, maxLength: 3 }),
            ),
            { minKeys: 0, maxKeys: 5 },
          ),
          (obj) => {
            const result = canonicalize(obj);
            expect(() => JSON.parse(result)).not.toThrow();
          }
        ),
        { numRuns }
      );
    });
  });

  describe('array preservation', () => {
    it('should not reorder array elements', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer(), { minLength: 1, maxLength: 10 }),
          (arr) => {
            const obj = { items: arr };
            const result = JSON.parse(canonicalize(obj));
            expect(result.items).toEqual(arr);
          }
        ),
        { numRuns }
      );
    });
  });
});
