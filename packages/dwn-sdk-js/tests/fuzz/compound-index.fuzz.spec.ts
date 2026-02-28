import type { CompoundIndexDefinition } from '../../src/store/index-level.js';
import type { Filter, KeyValues, QueryOptions } from '../../src/types/query-types.js';

import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { SortDirection } from '../../src/types/query-types.js';
import { buildCompoundKey, buildCompoundPrefix, COMPOUND_SEGMENT_SEPARATOR, selectCompoundIndex } from '../../src/store/index-level-compound.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

/**
 * The IndexLevel.encodeValue implementation for string values:
 * strings are left as-is in the real code. We use this simplified
 * version since we only generate string index values.
 */
function encodeValue(value: string | number | boolean): string {
  return String(value);
}

const DELIMITER = '\x00';

describe('Compound index — fuzz', () => {

  /**
   * Object.prototype property names that would collide with plain-object property lookups.
   */
  const prototypeNames = new Set(Object.getOwnPropertyNames(Object.prototype));

  /**
   * Arbitrary for a property name (no special chars that collide with separators,
   * no Object.prototype names like __proto__, toString, valueOf).
   */
  const arbPropName = fc.string({ minLength: 1, maxLength: 10 })
    .filter((s) => !s.includes('\x00') && !s.includes('\x01') && !s.includes('/') && !prototypeNames.has(s));

  /**
   * Arbitrary for a messageCid-like string.
   */
  const arbMessageCid = fc.stringMatching(/^[a-z0-9]{10,20}$/);

  describe('buildCompoundKey/buildCompoundPrefix consistency', () => {
    it('should produce a key that starts with the corresponding prefix', () => {
      fc.assert(
        fc.property(
          fc.array(arbPropName, { minLength: 1, maxLength: 4 })
            .filter((props) => new Set(props).size === props.length),
          arbPropName.filter((s) => s.length > 0),
          arbMessageCid,
          (properties, sortProperty, messageCid) => {
            // Ensure sortProperty is not in properties
            if (properties.includes(sortProperty)) {
              return;
            }

            const compoundIndex: CompoundIndexDefinition = {
              name: 'test',
              properties,
              sortProperty,
            };

            // Build indexes that satisfy all properties + sort
            const indexes: KeyValues = {};
            for (const prop of properties) {
              indexes[prop] = `val_${prop}`;
            }
            indexes[sortProperty] = 'sortval';

            // Also build a filter with the same equality values
            const filter: Filter = {};
            for (const prop of properties) {
              filter[prop] = `val_${prop}`;
            }

            const key = buildCompoundKey(messageCid, indexes, compoundIndex, encodeValue, DELIMITER);
            const prefix = buildCompoundPrefix(filter, compoundIndex, encodeValue);

            expect(key).toBeDefined();
            expect(prefix).toBeDefined();
            expect(key!.startsWith(prefix!)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('buildCompoundKey — returns undefined for missing properties', () => {
    it('should return undefined when a required property is missing from indexes', () => {
      fc.assert(
        fc.property(
          fc.array(arbPropName, { minLength: 2, maxLength: 4 })
            .filter((props) => new Set(props).size === props.length),
          arbPropName,
          arbMessageCid,
          fc.nat(),
          (properties, sortProperty, messageCid, dropSeed) => {
            if (properties.includes(sortProperty)) {
              return;
            }

            const compoundIndex: CompoundIndexDefinition = {
              name: 'test',
              properties,
              sortProperty,
            };

            // Build indexes but omit one required property
            const indexes: KeyValues = {};
            const dropIndex = dropSeed % properties.length;
            for (let i = 0; i < properties.length; i++) {
              if (i !== dropIndex) {
                indexes[properties[i]] = `val_${properties[i]}`;
              }
            }
            indexes[sortProperty] = 'sortval';

            const key = buildCompoundKey(messageCid, indexes, compoundIndex, encodeValue, DELIMITER);
            expect(key).toBeUndefined();
          }
        ),
        { numRuns }
      );
    });
  });

  describe('buildCompoundPrefix — returns undefined for non-equality filters', () => {
    it('should return undefined when a property has an object filter (range)', () => {
      fc.assert(
        fc.property(
          fc.array(arbPropName, { minLength: 1, maxLength: 3 })
            .filter((props) => new Set(props).size === props.length),
          arbPropName,
          fc.nat(),
          (properties, sortProperty, rangeSeed) => {
            if (properties.includes(sortProperty)) {
              return;
            }

            const compoundIndex: CompoundIndexDefinition = {
              name: 'test',
              properties,
              sortProperty,
            };

            // Set one property to an object (range filter) instead of equality
            const filter: Filter = {};
            const rangeIndex = rangeSeed % properties.length;
            for (let i = 0; i < properties.length; i++) {
              if (i === rangeIndex) {
                filter[properties[i]] = { gte: 'a', lte: 'z' }; // range filter
              } else {
                filter[properties[i]] = `val_${properties[i]}`;
              }
            }

            const prefix = buildCompoundPrefix(filter, compoundIndex, encodeValue);
            expect(prefix).toBeUndefined();
          }
        ),
        { numRuns }
      );
    });
  });

  describe('selectCompoundIndex — correctness', () => {
    it('should select the compound index with the most matching properties', () => {
      fc.assert(
        fc.property(
          arbPropName,
          arbPropName,
          arbPropName,
          arbPropName,
          (prop1, prop2, prop3, sortProp) => {
            // Ensure all distinct
            const allNames = [prop1, prop2, prop3, sortProp];
            if (new Set(allNames).size !== allNames.length) {
              return;
            }

            const smallIndex: CompoundIndexDefinition = {
              name         : 'small',
              properties   : [prop1],
              sortProperty : sortProp,
            };
            const largeIndex: CompoundIndexDefinition = {
              name         : 'large',
              properties   : [prop1, prop2],
              sortProperty : sortProp,
            };
            const wrongSort: CompoundIndexDefinition = {
              name         : 'wrongSort',
              properties   : [prop1, prop2, prop3],
              sortProperty : 'nonexistent_sort',
            };

            const filter: Filter = {
              [prop1] : 'v1',
              [prop2] : 'v2',
              [prop3] : 'v3',
            };
            const queryOptions: QueryOptions = {
              sortProperty  : sortProp,
              sortDirection : SortDirection.Ascending,
            };

            const selected = selectCompoundIndex(filter, queryOptions, [smallIndex, largeIndex, wrongSort]);
            expect(selected).toBe(largeIndex); // largeIndex has more matching properties
          }
        ),
        { numRuns }
      );
    });

    it('should return undefined when no compound index matches sort property', () => {
      fc.assert(
        fc.property(
          arbPropName,
          arbPropName,
          (prop, sortProp) => {
            if (prop === sortProp) {
              return;
            }

            const idx: CompoundIndexDefinition = {
              name         : 'idx',
              properties   : [prop],
              sortProperty : 'other_sort',
            };

            const filter: Filter = { [prop]: 'val' };
            const queryOptions: QueryOptions = {
              sortProperty  : sortProp,
              sortDirection : SortDirection.Ascending,
            };

            const selected = selectCompoundIndex(filter, queryOptions, [idx]);
            expect(selected).toBeUndefined();
          }
        ),
        { numRuns }
      );
    });
  });

  describe('buildCompoundKey — key contains all segments in order', () => {
    it('should encode property values in the compound key in definition order', () => {
      fc.assert(
        fc.property(
          fc.array(arbPropName, { minLength: 1, maxLength: 4 })
            .filter((props) => new Set(props).size === props.length),
          arbPropName,
          arbMessageCid,
          (properties, sortProperty, messageCid) => {
            if (properties.includes(sortProperty)) {
              return;
            }

            const compoundIndex: CompoundIndexDefinition = {
              name: 'test',
              properties,
              sortProperty,
            };

            const indexes: KeyValues = {};
            const values: string[] = [];
            for (const prop of properties) {
              const val = `v_${prop}`;
              indexes[prop] = val;
              values.push(val);
            }
            const sortVal = 'sort_val';
            indexes[sortProperty] = sortVal;

            const key = buildCompoundKey(messageCid, indexes, compoundIndex, encodeValue, DELIMITER);
            expect(key).toBeDefined();

            // Verify: key should be values joined by \x01, then \x01sortVal\x00messageCid
            const expected = values.join(COMPOUND_SEGMENT_SEPARATOR) +
              COMPOUND_SEGMENT_SEPARATOR + sortVal + DELIMITER + messageCid;
            expect(key).toBe(expected);
          }
        ),
        { numRuns }
      );
    });
  });
});
