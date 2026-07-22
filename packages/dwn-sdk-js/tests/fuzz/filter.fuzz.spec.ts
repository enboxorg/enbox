import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { equalFilter, filter, keyValues, oneOfFilter, rangeFilter } from './arbitraries/filter.arbitrary.js';
import { FilterSelector, FilterUtility, isSubtreeFilter } from '../../src/utils/filter.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('FilterUtility — fuzz', () => {

  const pathSegment = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    { minLength: 1, maxLength: 20 }
  ).map((characters) => characters.join(''));

  describe('matchFilter — empty filter matches everything', () => {
    it('should return true for any keyValues when filter is empty', () => {
      fc.assert(
        fc.property(keyValues(), (kv) => {
          const result = FilterUtility.matchFilter(kv, {});
          expect(result).toBe(true);
        }),
        { numRuns }
      );
    });
  });

  describe('matchFilter — crash resistance', () => {
    it('should not crash on arbitrary filter and keyValues combinations', () => {
      fc.assert(
        fc.property(keyValues(), filter(), (kv, f) => {
          // Should return a boolean without crashing
          const result = FilterUtility.matchFilter(kv, f);
          expect(typeof result).toBe('boolean');
        }),
        { numRuns }
      );
    });
  });

  describe('matchAnyFilter — empty array matches everything', () => {
    it('should return true when the filter array is empty', () => {
      fc.assert(
        fc.property(keyValues(), (kv) => {
          const result = FilterUtility.matchAnyFilter(kv, []);
          expect(result).toBe(true);
        }),
        { numRuns }
      );
    });
  });

  describe('matchFilter — equal filter consistency', () => {
    it('should match when the indexed value equals the filter value', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }),
          equalFilter(),
          (key, value) => {
            const kv = { [key]: value } as Record<string, string | number | boolean>;
            const f = { [key]: value };
            expect(FilterUtility.matchFilter(kv, f)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('matchFilter — oneOf filter contains value', () => {
    it('should match when the indexed value is in the OneOfFilter array', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }),
          oneOfFilter(),
          (key, values) => {
            // Use the first value from the OneOf array as the indexed value
            const indexValue = values[0];
            const kv = { [key]: indexValue } as Record<string, string | number | boolean>;
            const f = { [key]: values };
            expect(FilterUtility.matchFilter(kv, f)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('matchFilter — range filter within bounds', () => {
    it('should match when a numeric value falls within the range', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.integer({ min: -500, max: 500 }),
          (key, value) => {
            // Create a range that definitely includes the value
            const f = { [key]: { gte: value - 1, lt: value + 2 } };
            const kv = { [key]: value };
            expect(FilterUtility.matchFilter(kv, f)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('matchFilter — missing key returns false', () => {
    it('should return false when the filter references a key not in keyValues', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }),
          equalFilter(),
          (key, value) => {
            // Empty keyValues, so any filter property should fail
            const kv = {};
            const f = { [key]: value };
            expect(FilterUtility.matchFilter(kv, f)).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('constructPrefixFilterAsRangeFilter — prefix match property', () => {
    it('should match strings that start with the prefix', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 0, maxLength: 20 }),
          (prefix, suffix) => {
            const rangeFilterResult = FilterUtility.constructPrefixFilterAsRangeFilter(prefix);
            const value = prefix + suffix;

            // The value should be >= prefix and < prefix + \uffff
            expect(value >= rangeFilterResult.gte!).toBe(true);
            expect(value < rangeFilterResult.lt!).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('matchesSubtree — segment boundary property', () => {
    it('should match exact paths and descendants without matching prefix siblings', () => {
      fc.assert(
        fc.property(pathSegment, pathSegment, pathSegment, (root, branch, suffix) => {
          const subtree = `${root}/${branch}`;

          expect(FilterUtility.matchesSubtree(subtree, subtree)).toBe(true);
          expect(FilterUtility.matchesSubtree(subtree, `${subtree}/${suffix}`)).toBe(true);
          expect(FilterUtility.matchesSubtree(subtree, `${subtree}/${suffix}/grandchild`)).toBe(true);

          expect(FilterUtility.matchesSubtree(subtree, `${subtree}-${suffix}`)).toBe(false);
          expect(FilterUtility.matchesSubtree(subtree, `${subtree}.${suffix}`)).toBe(false);
          expect(FilterUtility.matchesSubtree(subtree, `${subtree}${suffix}`)).toBe(false);
        }),
        { numRuns }
      );
    });
  });

  describe('filter value classification — mutual exclusivity', () => {
    it('should classify each filter value into exactly one category', () => {
      fc.assert(
        fc.property(
          fc.oneof(equalFilter(), rangeFilter(), oneOfFilter(), pathSegment.map((subtree) => ({ subtree }))),
          (filterValue) => {
            const isEqual = FilterUtility.isEqualFilter(filterValue);
            const isRange = FilterUtility.isRangeFilter(filterValue);
            const isOneOf = FilterUtility.isOneOfFilter(filterValue);
            const isSubtree = isSubtreeFilter(filterValue);

            // Exactly one should be true
            const trueCount = [isEqual, isRange, isOneOf, isSubtree].filter(Boolean).length;
            expect(trueCount).toBe(1);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('convertRangeCriterion — consistency', () => {
    it('should produce a valid RangeFilter or undefined for any input', () => {
      fc.assert(
        fc.property(
          fc.record({
            from : fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
            to   : fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
          }),
          (criterion) => {
            const result = FilterUtility.convertRangeCriterion(criterion);
            if (criterion.from === undefined && criterion.to === undefined) {
              expect(result).toBeUndefined();
            } else {
              expect(result).toBeDefined();
              if (criterion.from !== undefined) {
                expect(result!.gte).toBe(criterion.from);
              }
              if (criterion.to !== undefined) {
                expect(result!.lt).toBe(criterion.to);
              }
            }
          }
        ),
        { numRuns }
      );
    });
  });
});

describe('FilterSelector — fuzz', () => {

  describe('reduceFilter — returns a subset', () => {
    it('should return a filter with at most 1 property', () => {
      fc.assert(
        fc.property(filter(), (f) => {
          const reduced = FilterSelector.reduceFilter(f);
          const reducedKeys = Object.keys(reduced);

          // If input had 0 or 1 keys, reduced should be the same
          const inputKeys = Object.keys(f);
          if (inputKeys.length <= 1) {
            expect(reduced).toEqual(f);
          } else {
            // Otherwise, reduced should have exactly 1 key
            expect(reducedKeys).toHaveLength(1);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('reduceFilter — reduced key is from original filter', () => {
    it('should select a key that exists in the original filter', () => {
      fc.assert(
        fc.property(filter(), (f) => {
          const reduced = FilterSelector.reduceFilter(f);
          const reducedKeys = Object.keys(reduced);
          const originalKeys = Object.keys(f);

          for (const key of reducedKeys) {
            expect(originalKeys).toContain(key);
          }
        }),
        { numRuns }
      );
    });
  });
});
