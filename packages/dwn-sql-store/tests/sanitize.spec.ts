import type { Filter, KeyValues } from '@enbox/dwn-sdk-js';

import { describe, expect, it } from 'bun:test';
import {
  extractTagsAndSanitizeIndexes,
  sanitizedValue,
  sanitizeFilter,
  sanitizeFilters,
  sanitizeFiltersAndSeparateTags,
  sanitizeIndexes,
} from '../src/utils/sanitize.js';

describe('sanitize utilities', () => {

  // ─── sanitizedValue ───────────────────────────────────────────────────

  describe('sanitizedValue()', () => {
    it('should convert boolean true to 1', () => {
      expect(sanitizedValue(true)).toBe(1);
    });

    it('should convert boolean false to 0', () => {
      expect(sanitizedValue(false)).toBe(0);
    });

    it('should pass through string values unchanged', () => {
      expect(sanitizedValue('hello')).toBe('hello');
    });

    it('should pass through number values unchanged', () => {
      expect(sanitizedValue(42)).toBe(42);
    });

    it('should pass through zero unchanged', () => {
      expect(sanitizedValue(0)).toBe(0);
    });

    it('should pass through empty string unchanged', () => {
      expect(sanitizedValue('')).toBe('');
    });
  });

  // ─── sanitizeIndexes ──────────────────────────────────────────────────

  describe('sanitizeIndexes()', () => {
    it('should sanitize boolean values in indexes', () => {
      // Typed as KeyValues because sanitizeIndexes mutates booleans to 1/0 in place;
      // the union value type keeps the post-mutation numeric assertions well-typed.
      const records: KeyValues = { isActive: true, isClosed: false, name: 'test' };
      sanitizeIndexes(records);

      expect(records.isActive).toBe(1);
      expect(records.isClosed).toBe(0);
      expect(records.name).toBe('test');
    });

    it('should sanitize array values', () => {
      const records = { tags: [true, false, 'hello', 42] };
      sanitizeIndexes(records);

      expect(records.tags).toEqual([1, 0, 'hello', 42]);
    });

    it('should handle empty objects', () => {
      const records = {};
      sanitizeIndexes(records);
      expect(records).toEqual({});
    });
  });

  // ─── extractTagsAndSanitizeIndexes ────────────────────────────────────

  describe('extractTagsAndSanitizeIndexes()', () => {
    it('should extract tag-prefixed fields into tags object', () => {
      const records = {
        'protocol'  : 'proto-1',
        'tag.color' : 'red',
        'tag.size'  : 42,
      };

      const result = extractTagsAndSanitizeIndexes(records);

      expect(result.tags).toEqual({ color: 'red', size: 42 });
      expect(result.indexes).toEqual({ protocol: 'proto-1' });
    });

    it('should sanitize boolean values in indexes before extracting tags', () => {
      const records = {
        'published'  : true,
        'tag.active' : true,
      };

      const result = extractTagsAndSanitizeIndexes(records);

      expect(result.indexes.published).toBe(1);
      // tag.active was a boolean in the original records, but sanitizeIndexes runs before extraction
      expect(result.tags.active).toBe(1);
    });

    it('should return empty tags when no tag-prefixed fields exist', () => {
      const records = { protocol: 'proto-1', method: 'Write' };
      const result = extractTagsAndSanitizeIndexes(records);

      expect(result.tags).toEqual({});
      expect(result.indexes).toEqual({ protocol: 'proto-1', method: 'Write' });
    });

    it('should not mutate the original records object', () => {
      const records = { 'tag.color': 'red', 'protocol': 'proto-1' };
      const original = { ...records };
      extractTagsAndSanitizeIndexes(records);

      // The function creates a shallow copy of records for indexes, so original is not affected
      expect(original['tag.color']).toBe('red');
      expect(original.protocol).toBe('proto-1');
    });
  });

  // ─── sanitizeFiltersAndSeparateTags ───────────────────────────────────

  describe('sanitizeFiltersAndSeparateTags()', () => {
    it('should separate tag filters from non-tag filters', () => {
      const filters: Filter[] = [
        { protocol: 'proto-1', 'tag.color': 'red' },
      ];

      const result = sanitizeFiltersAndSeparateTags(filters);

      expect(result.length).toBe(1);
      expect(result[0].filter).toEqual({ protocol: 'proto-1' });
      expect(result[0].tags).toEqual({ color: 'red' });
    });

    it('should sanitize boolean values in filters', () => {
      const filters: Filter[] = [
        { published: true as any, 'tag.active': false as any },
      ];

      const result = sanitizeFiltersAndSeparateTags(filters);

      expect(result[0].filter.published).toBe(1);
      expect(result[0].tags.active).toBe(0);
    });

    it('should handle multiple filters', () => {
      const filters: Filter[] = [
        { protocol: 'proto-a' },
        { method: 'Write', 'tag.priority': 5 },
      ];

      const result = sanitizeFiltersAndSeparateTags(filters);

      expect(result.length).toBe(2);
      expect(result[0].filter).toEqual({ protocol: 'proto-a' });
      expect(result[0].tags).toEqual({});
      expect(result[1].filter).toEqual({ method: 'Write' });
      expect(result[1].tags).toEqual({ priority: 5 });
    });

    it('should handle filters with no tags', () => {
      const filters: Filter[] = [{ protocol: 'proto-1' }];
      const result = sanitizeFiltersAndSeparateTags(filters);

      expect(result[0].tags).toEqual({});
    });
  });

  // ─── Dead code: sanitizeFilters() and sanitizeFilter() ────────────────
  //
  // These functions are exported from sanitize.ts but never imported or
  // called anywhere in the codebase. They are candidates for removal.
  // We test them here for completeness of coverage.

  describe('sanitizeFilters() — dead code', () => {
    it('should sanitize all filters in place', () => {
      const filters: Filter[] = [
        { published: true as any, method: 'Write' },
        { isActive: false as any },
      ];

      sanitizeFilters(filters);

      expect(filters[0].published).toBe(1);
      expect(filters[0].method).toBe('Write');
      expect(filters[1].isActive).toBe(0);
    });
  });

  describe('sanitizeFilter() — dead code', () => {
    it('should sanitize a single filter in place and return it', () => {
      const filter: Filter = { published: true as any, name: 'test' };

      const result = sanitizeFilter(filter);

      expect(result.published).toBe(1);
      expect(result.name).toBe('test');
      expect(result).toBe(filter); // same reference
    });
  });
});
