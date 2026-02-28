/**
 * fast-check arbitraries for generating Filter and KeyValues structures
 * used by FilterUtility.
 */
import type { Arbitrary } from 'fast-check';
import type { EqualFilter, Filter, KeyValues, OneOfFilter, RangeFilter } from '../../../src/types/query-types.js';

import fc from 'fast-check';

/**
 * Generates an EqualFilter value (string, number, or boolean).
 */
export function equalFilter(): Arbitrary<EqualFilter> {
  return fc.oneof(
    fc.string({ minLength: 0, maxLength: 50 }),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean(),
  );
}

/**
 * Generates a OneOfFilter (array of EqualFilter values).
 */
export function oneOfFilter(): Arbitrary<OneOfFilter> {
  return fc.array(equalFilter(), { minLength: 1, maxLength: 5 });
}

/**
 * Generates a RangeFilter with consistent types (either all strings or all numbers).
 */
export function rangeFilter(): Arbitrary<RangeFilter> {
  return fc.oneof(
    // String range
    fc.record({
      gte : fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
      lt  : fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
    }).filter((f) => f.gte !== undefined || f.lt !== undefined) as Arbitrary<RangeFilter>,
    // Number range
    fc.record({
      gte : fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
      lt  : fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
    }).filter((f) => f.gte !== undefined || f.lt !== undefined) as Arbitrary<RangeFilter>,
    // gt/lte variants
    fc.record({
      gt  : fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
      lte : fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
    }).filter((f) => f.gt !== undefined || f.lte !== undefined) as Arbitrary<RangeFilter>,
  );
}

/** Property names commonly used as filter keys in DWN. */
const filterPropertyNames = [
  'recordId', 'attester', 'parentId', 'recipient', 'contextId',
  'author', 'protocolPath', 'schema', 'protocol', 'dataFormat',
  'dateCreated', 'datePublished', 'dateUpdated',
];

/**
 * Generates a Filter object with 1-4 properties, each containing an equal, range, or OneOf filter.
 */
export function filter(): Arbitrary<Filter> {
  return fc.dictionary(
    fc.constantFrom(...filterPropertyNames),
    fc.oneof(
      equalFilter(),
      oneOfFilter(),
      rangeFilter(),
    ),
    { minKeys: 1, maxKeys: 4 },
  );
}

/**
 * Generates KeyValues (indexed values for a record).
 */
export function keyValues(): Arbitrary<KeyValues> {
  return fc.dictionary(
    fc.constantFrom(...filterPropertyNames),
    fc.oneof(
      fc.string({ minLength: 0, maxLength: 50 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.boolean(),
      fc.array(fc.string({ minLength: 0, maxLength: 20 }), { minLength: 1, maxLength: 3 }),
      fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 3 }),
    ),
    { minKeys: 1, maxKeys: 6 },
  );
}
