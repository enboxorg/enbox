import { Filter } from '@tbd54566975/dwn-sdk-js';
import { KeyValues } from '../types.js';

export function extractTagsAndSanitizeIndexes(records: KeyValues): {
  tags: KeyValues;
  indexes: KeyValues;
} {

  const tags = {};
  const indexes = { ...records };

  sanitizeIndexes(indexes);

  // tag values are prefixed with 'tag.', we extract them to be inserted separately into the tags reference tables.
  // we delete them from the `indexes` object so they are not included in the main insert.
  for (let key in indexes) {
    if (key.startsWith('tag.')) {
      let value = indexes[key];
      delete indexes[key];
      tags[key.slice(4)] = value;
    }
  }

  return { tags, indexes };
}

export function sanitizeIndexes(records: KeyValues) {
  for (let key in records) {
    let value = records[key];
    if (Array.isArray(value)) {
      const sanitizedValues: any[] = [];
      for (const valueItem of value) {
        sanitizedValues.push(sanitizedValue(valueItem));
      }
      records[key] = sanitizedValues;
      continue;
    }

    records[key] = sanitizedValue(value);
  }
}

/**
 * Sanitizes the given value into a string or number.
 * NOTE: sqlite3 we use does not support inserting boolean values, so we convert them to a number.
 */
export function sanitizedValue(value: string | number | boolean): string | number {
  switch (typeof value) {
  case 'boolean':
    return value ? 1 : 0;
  default:
    return value;
  }
}

/**
 * Sanitizes the filters and separates tags from non-tags filter.
 */
export function sanitizeFiltersAndSeparateTags(filters: Filter[]): {
  tags: Filter;
  filter: Filter;
}[] {

  const extractedFilters: { tags: Filter, filter: Filter }[] = [];

  for (const filter of filters) {
    const tagFilter = {};
    const nonTagFilter = {};

    // tag values are prefixed with 'tag.', we extract them to be queried separately in the tags tables.
    for (let key in filter) {
      const value = sanitizeFilterValue(filter[key]);

      if (key.startsWith('tag.')) {
        tagFilter[key.slice(4)] = value;
      } else {
        nonTagFilter[key] = value;
      }
    }

    extractedFilters.push({
      tags   : tagFilter,
      filter : nonTagFilter,
    });
  }

  return extractedFilters;
}

// we sanitize the filter value for a number representation of the boolean

/**
 * Sanitizes the given filter value to align with the value conversions done during insertions/updates.
 * NOTE: sqlite3 we use does not support inserting boolean values,
 *       so we convert them to a number during insertions/updates, as a result we need to align the filter values in queries.
*/
// TODO: export filter types from `dwn-sdk-js`
export function sanitizeFilterValue(value: any): any {
  switch (typeof value) {
  case 'boolean':
    return value ? 1 : 0;
  default:
    return value;
  }
}

export function sanitizeFilters(filters: Filter[]) {
  filters.forEach(sanitizeFilter);
}

export function sanitizeFilter(filter: Filter): Filter {
  for (let key in filter) {
    let value = filter[key];
    filter[key] = sanitizeFilterValue(value);
  }
  return filter;
}