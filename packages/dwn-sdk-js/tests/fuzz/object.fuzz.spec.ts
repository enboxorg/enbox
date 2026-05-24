import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { isEmptyObject, removeEmptyObjects, removeUndefinedProperties } from '@enbox/common';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

/**
 * Generates nested objects with a mix of primitives, undefined values, and empty objects.
 * Excludes null in nested positions — the production code's recursive helpers
 * (`removeUndefinedProperties`, `removeEmptyObjects`) call `Object.keys()` on
 * values where `typeof value === 'object'`, which includes `null` and would throw.
 * Real DWN messages use `undefined` (not `null`) for absent properties.
 */
function nestedObject(): fc.Arbitrary<Record<string, unknown>> {
  const leaf = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(undefined),
    fc.constant({}),
  );
  return fc.dictionary(
    fc.string({ minLength: 1, maxLength: 10 }),
    fc.oneof(
      leaf,
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 8 }),
        leaf,
        { minKeys: 0, maxKeys: 3 },
      ),
    ),
    { minKeys: 0, maxKeys: 5 },
  );
}

/** Check that no property in the (possibly nested) object is undefined. */
function hasNoUndefined(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) { return false; }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (!hasNoUndefined(obj[key] as Record<string, unknown>)) { return false; }
    }
  }
  return true;
}

describe('Object utilities — fuzz', () => {

  describe('isEmptyObject', () => {
    it('should return false for all primitives', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.float(),
            fc.boolean(),
            fc.constant(undefined),
          ),
          (value) => {
            expect(isEmptyObject(value)).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('removeUndefinedProperties — idempotency', () => {
    it('should produce the same result when applied twice', () => {
      fc.assert(
        fc.property(
          nestedObject(),
          (obj) => {
            const clone1 = structuredClone(obj);
            const clone2 = structuredClone(obj);

            removeUndefinedProperties(clone1);
            removeUndefinedProperties(clone2);
            removeUndefinedProperties(clone2); // second pass

            expect(clone2).toEqual(clone1);
          }
        ),
        { numRuns }
      );
    });

    it('should leave no undefined properties after one pass', () => {
      fc.assert(
        fc.property(
          nestedObject(),
          (obj) => {
            removeUndefinedProperties(obj);
            expect(hasNoUndefined(obj)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('removeEmptyObjects — idempotency', () => {
    it('should produce the same result when applied twice', () => {
      fc.assert(
        fc.property(
          nestedObject(),
          (obj) => {
            const clone1 = structuredClone(obj);
            const clone2 = structuredClone(obj);

            removeEmptyObjects(clone1);
            removeEmptyObjects(clone2);
            removeEmptyObjects(clone2); // second pass

            expect(clone2).toEqual(clone1);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('removeUndefinedProperties then removeEmptyObjects — clean result', () => {
    it('should leave an object with no undefined properties and no empty objects', () => {
      fc.assert(
        fc.property(
          nestedObject(),
          (obj) => {
            removeUndefinedProperties(obj);
            removeEmptyObjects(obj);

            // After both passes: no undefined, no empty objects
            expect(hasNoUndefined(obj)).toBe(true);
            for (const key of Object.keys(obj)) {
              expect(isEmptyObject(obj[key])).toBe(false);
            }
          }
        ),
        { numRuns }
      );
    });
  });
});
