import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DateSort } from '../../src/types/records-types.js';
import { Records } from '../../src/utils/records.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('Records utility functions — fuzz', () => {

  describe('getParentContextFromOfContextId', () => {
    it('should return everything up to the last / for multi-segment contextIds', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes('/')),
            { minLength: 2, maxLength: 6 },
          ),
          (segments) => {
            const contextId = segments.join('/');
            const parent = Records.getParentContextFromOfContextId(contextId);
            const expected = segments.slice(0, -1).join('/');
            expect(parent).toBe(expected);
          }
        ),
        { numRuns }
      );
    });

    it('should return empty string for root contextIds (no /)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('/')),
          (contextId) => {
            expect(Records.getParentContextFromOfContextId(contextId)).toBe('');
          }
        ),
        { numRuns }
      );
    });

    it('should return undefined for undefined input', () => {
      expect(Records.getParentContextFromOfContextId(undefined)).toBeUndefined();
    });
  });

  describe('buildTagIndexes — tag. prefix', () => {
    it('should prefix all keys with tag.', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.startsWith('tag.')),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            { minKeys: 1, maxKeys: 5 },
          ),
          (tags) => {
            const result = Records.buildTagIndexes(tags);
            for (const key of Object.keys(tags)) {
              expect(result[`tag.${key}`]).toEqual(tags[key]);
            }
            // No keys without the tag. prefix
            for (const key of Object.keys(result)) {
              expect(key.startsWith('tag.')).toBe(true);
            }
            // Same number of keys
            expect(Object.keys(result).length).toBe(Object.keys(tags).length);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('filterIncludesPublishedRecords / filterIncludesUnpublishedRecords', () => {
    it('should always include at least one class of records', () => {
      fc.assert(
        fc.property(
          fc.record({
            published     : fc.constantFrom(undefined, true, false),
            datePublished : fc.constantFrom(undefined, { from: '2024-01-01' }),
          }),
          (filter) => {
            const pub = Records.filterIncludesPublishedRecords(filter);
            const unpub = Records.filterIncludesUnpublishedRecords(filter);
            // At least one must be true — a filter always matches something
            expect(pub || unpub).toBe(true);
          }
        ),
        { numRuns }
      );
    });

    it('should correctly classify explicit published=true', () => {
      expect(Records.filterIncludesPublishedRecords({ published: true })).toBe(true);
      expect(Records.filterIncludesUnpublishedRecords({ published: true })).toBe(false);
    });

    it('should correctly classify explicit published=false', () => {
      expect(Records.filterIncludesPublishedRecords({ published: false })).toBe(false);
      expect(Records.filterIncludesUnpublishedRecords({ published: false })).toBe(true);
    });
  });

  describe('convertDateSort — exhaustiveness', () => {
    it('should return a valid MessageSort for every DateSort value', () => {
      const allDateSorts = Object.values(DateSort);
      for (const dateSort of allDateSorts) {
        const result = Records.convertDateSort(dateSort);
        // Exactly one sort property should be set
        const keys = Object.keys(result);
        expect(keys.length).toBe(1);
        const value = Object.values(result)[0];
        // SortDirection is 1 (ascending) or -1 (descending)
        expect(value === 1 || value === -1).toBe(true);
      }
    });

    it('should default to messageTimestamp descending for undefined', () => {
      const result = Records.convertDateSort(undefined);
      expect(result).toEqual({ messageTimestamp: -1 });
    });
  });
});
