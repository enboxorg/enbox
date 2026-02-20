import type { Filter, KeyValues, QueryOptions } from '../types/query-types.js';
import type { IndexedItem, IndexLevelOptions } from './index-level.js';
import type { LevelWrapperBatchOperation, LevelWrapperIteratorOptions } from './level-wrapper.js';

import type { CompoundIndexDefinition } from './index-level.js';
import type { LevelWrapper } from './level-wrapper.js';

import { FilterUtility } from '../utils/filter.js';
import { SortDirection } from '../types/query-types.js';

/** Separator between compound key segments (higher than \x00 so prefix scans work correctly). */
export const COMPOUND_SEGMENT_SEPARATOR = '\x01';

/**
 * Gets the compound index partition for a given compound index definition.
 * Compound index sublevels use the naming convention `__compound:<name>__`.
 */
export async function getCompoundIndexPartition(
  db: LevelWrapper<string>, tenant: string, compoundIndex: CompoundIndexDefinition
): Promise<LevelWrapper<string>> {
  const partitionName = `__compound:${compoundIndex.name}__`;
  return (await db.partition(tenant)).partition(partitionName);
}

/**
 * Builds a compound index key from the given indexes and compound index definition.
 *
 * Key format: `<prop1>\x01<prop2>\x01...\x01<sortValue>\x00<messageCid>`
 *
 * @returns the compound key, or undefined if the indexes don't contain all required properties.
 */
export function buildCompoundKey(
  messageCid: string, indexes: KeyValues, compoundIndex: CompoundIndexDefinition,
  encodeValue: (value: string | number | boolean) => string, delimiter: string
): string | undefined {
  const segments: string[] = [];

  for (const property of compoundIndex.properties) {
    const value = indexes[property];
    if (value === undefined || Array.isArray(value)) {
      return undefined; // compound indexes don't support array values or missing properties
    }
    segments.push(encodeValue(value));
  }

  const sortValue = indexes[compoundIndex.sortProperty];
  if (sortValue === undefined || Array.isArray(sortValue)) {
    return undefined;
  }

  // join prefix segments with \x01, then append sort value and messageCid with the standard delimiters
  const prefixPart = segments.join(COMPOUND_SEGMENT_SEPARATOR);
  const sortPart = encodeValue(sortValue);
  return prefixPart + COMPOUND_SEGMENT_SEPARATOR + sortPart + delimiter + messageCid;
}

/**
 * Builds the prefix portion of a compound key from filter values (without the sort/messageCid suffix).
 * Used for range scans: all entries with this prefix match the filter.
 */
export function buildCompoundPrefix(
  filter: Filter, compoundIndex: CompoundIndexDefinition,
  encodeValue: (value: string | number | boolean) => string
): string | undefined {
  const segments: string[] = [];

  for (const property of compoundIndex.properties) {
    const filterValue = filter[property];
    if (filterValue === undefined || typeof filterValue === 'object') {
      return undefined; // compound prefix only works with equality filters
    }
    segments.push(encodeValue(filterValue));
  }

  return segments.join(COMPOUND_SEGMENT_SEPARATOR) + COMPOUND_SEGMENT_SEPARATOR;
}

/**
 * Creates a put operation for a compound index entry.
 * Returns undefined if the indexes don't contain all required compound index properties.
 */
export function createCompoundIndexPutOperation(
  db: LevelWrapper<string>, tenant: string, item: IndexedItem, compoundIndex: CompoundIndexDefinition,
  encodeValue: (value: string | number | boolean) => string, delimiter: string
): Promise<LevelWrapperBatchOperation<string>> | undefined {
  const key = buildCompoundKey(item.messageCid, item.indexes, compoundIndex, encodeValue, delimiter);
  if (key === undefined) {
    return undefined;
  }

  return createOperationForPartition(db, tenant, `__compound:${compoundIndex.name}__`, {
    type  : 'put',
    key,
    value : JSON.stringify(item),
  });
}

/**
 * Creates a delete operation for a compound index entry.
 * Returns undefined if the indexes don't contain all required compound index properties.
 */
export function createCompoundIndexDeleteOperation(
  db: LevelWrapper<string>, tenant: string, messageCid: string, indexes: KeyValues,
  compoundIndex: CompoundIndexDefinition,
  encodeValue: (value: string | number | boolean) => string, delimiter: string
): Promise<LevelWrapperBatchOperation<string>> | undefined {
  const key = buildCompoundKey(messageCid, indexes, compoundIndex, encodeValue, delimiter);
  if (key === undefined) {
    return undefined;
  }

  return createOperationForPartition(db, tenant, `__compound:${compoundIndex.name}__`, {
    type: 'del',
    key,
  });
}

/**
 * Generic helper to create a batch operation for any named partition under a tenant.
 */
export async function createOperationForPartition(
  db: LevelWrapper<string>, tenant: string, partitionName: string, operation: LevelWrapperBatchOperation<string>
): Promise<LevelWrapperBatchOperation<string>> {
  const tenantPartition = await db.partition(tenant);
  return tenantPartition.createPartitionOperation(partitionName, operation);
}

/**
 * Selects the best compound index that covers the given filter and sort requirements.
 *
 * A compound index "covers" a query when:
 * 1. Every property in the compound index definition is present in the filter as an equality filter.
 * 2. The compound index's sort property matches the query's sort property.
 *
 * Among multiple matching compound indexes, the one with the most properties is preferred
 * (more specific = fewer false positives in the prefix scan).
 */
export function selectCompoundIndex(
  filter: Filter, queryOptions: QueryOptions, compoundIndexes: CompoundIndexDefinition[]
): CompoundIndexDefinition | undefined {
  let bestMatch: CompoundIndexDefinition | undefined;
  let bestPropertyCount = 0;

  for (const compoundIndex of compoundIndexes) {
    // check that the sort property matches
    if (compoundIndex.sortProperty !== queryOptions.sortProperty) {
      continue;
    }

    // check that all compound properties are present in the filter as equality filters
    let allPropertiesMatch = true;
    for (const property of compoundIndex.properties) {
      const filterValue = filter[property];
      if (filterValue === undefined || typeof filterValue === 'object') {
        allPropertiesMatch = false;
        break;
      }
    }

    if (allPropertiesMatch && compoundIndex.properties.length > bestPropertyCount) {
      bestMatch = compoundIndex;
      bestPropertyCount = compoundIndex.properties.length;
    }
  }

  return bestMatch;
}

/**
 * Queries using a compound index. This is the most efficient query strategy: a single LevelDB
 * range scan that filters, sorts, and paginates all at once.
 *
 * The compound key encodes the filter properties as a prefix and the sort property as a suffix,
 * so iterating over keys with the filter prefix yields results in sort order.
 *
 * Any remaining filter properties not covered by the compound index are verified in memory.
 *
 * @param queryWithIteratorPagingFallback callback to fall back to iterator paging if compound prefix fails.
 */
export async function queryWithCompoundIndex(
  db: LevelWrapper<string>,
  tenant: string,
  filter: Filter,
  queryOptions: QueryOptions,
  compoundIndex: CompoundIndexDefinition,
  encodeValue: (value: string | number | boolean) => string,
  delimiter: string,
  queryWithIteratorPagingFallback: (
    tenant: string, filters: Filter[], queryOptions: QueryOptions, options?: IndexLevelOptions
  ) => Promise<IndexedItem[]>,
  options?: IndexLevelOptions
): Promise<IndexedItem[]> {
  const { sortDirection = SortDirection.Ascending, cursor, limit } = queryOptions;

  const prefix = buildCompoundPrefix(filter, compoundIndex, encodeValue);
  if (prefix === undefined) {
    // should not happen since selectCompoundIndex already validated, but guard against it
    return queryWithIteratorPagingFallback(tenant, [filter], queryOptions, options);
  }

  const partition = await getCompoundIndexPartition(db, tenant, compoundIndex);

  // determine the iterator bounds from the prefix
  const iteratorOptions: LevelWrapperIteratorOptions<string> = {};

  if (cursor !== undefined) {
    // build the full compound key for the cursor position
    const cursorSortEncoded = encodeValue(cursor.value);
    const cursorKey = prefix + cursorSortEncoded + delimiter + cursor.messageCid;

    if (sortDirection === SortDirection.Ascending) {
      iteratorOptions.gt = cursorKey;
      // upper bound: everything with this prefix (prefix + \xff is past all valid compound keys with this prefix)
      iteratorOptions.lt = prefix + '\xff';
    } else {
      iteratorOptions.lt = cursorKey;
      iteratorOptions.gt = prefix;
      iteratorOptions.reverse = true;
    }
  } else {
    if (sortDirection === SortDirection.Ascending) {
      iteratorOptions.gt = prefix;
      iteratorOptions.lt = prefix + '\xff';
    } else {
      // for descending without cursor, start from the end of the prefix range
      iteratorOptions.gt = prefix;
      iteratorOptions.lt = prefix + '\xff';
      iteratorOptions.reverse = true;
    }
  }

  // determine which filter properties are NOT covered by the compound index
  // (need in-memory verification for these)
  // NOTE: the compound index equality properties are fully covered by the prefix scan,
  // but the sort property is only covered for ordering — any range filter on the sort
  // property must still be applied as a residual filter.
  const coveredEqualityProperties = new Set(compoundIndex.properties);
  const residualFilter: Filter = {};
  let hasResidualFilter = false;
  for (const property in filter) {
    if (!coveredEqualityProperties.has(property)) {
      residualFilter[property] = filter[property];
      hasResidualFilter = true;
    }
  }

  const matches: IndexedItem[] = [];
  for await (const [_key, value] of partition.iterator(iteratorOptions, options)) {
    if (limit !== undefined && matches.length === limit) {
      break;
    }

    const item = JSON.parse(value) as IndexedItem;

    // verify any residual filter properties in memory
    if (hasResidualFilter && !FilterUtility.matchFilter(item.indexes, residualFilter)) {
      continue;
    }

    matches.push(item);
  }

  return matches;
}

/**
 * Counts items matching a compound index prefix without loading full records.
 * Iterates only keys (not values) for maximum efficiency.
 *
 * @param queryFallback callback to fall back to full query if compound prefix fails.
 */
export async function countWithCompoundIndex(
  db: LevelWrapper<string>,
  tenant: string,
  filter: Filter,
  compoundIndex: CompoundIndexDefinition,
  encodeValue: (value: string | number | boolean) => string,
  queryFallback: (tenant: string, filters: Filter[], queryOptions: QueryOptions, options?: IndexLevelOptions) => Promise<IndexedItem[]>,
  options?: IndexLevelOptions
): Promise<number> {
  const prefix = buildCompoundPrefix(filter, compoundIndex, encodeValue);
  if (prefix === undefined) {
    // fallback
    const results = await queryFallback(tenant, [filter], { sortProperty: compoundIndex.sortProperty }, options);
    return results.length;
  }

  const partition = await getCompoundIndexPartition(db, tenant, compoundIndex);

  // determine which filter properties are NOT covered by the compound index
  // (same logic as queryWithCompoundIndex: sort property range filters are residual)
  const coveredEqualityProperties = new Set(compoundIndex.properties);
  let hasResidualFilter = false;
  const residualFilter: Filter = {};
  for (const property in filter) {
    if (!coveredEqualityProperties.has(property)) {
      residualFilter[property] = filter[property];
      hasResidualFilter = true;
    }
  }

  const iteratorOptions: LevelWrapperIteratorOptions<string> = {
    gt : prefix,
    lt : prefix + '\xff',
  };

  let count = 0;
  if (hasResidualFilter) {
    // must read values to check residual filter
    for await (const [_key, value] of partition.iterator(iteratorOptions, options)) {
      const item = JSON.parse(value) as IndexedItem;
      if (FilterUtility.matchFilter(item.indexes, residualFilter)) {
        count++;
      }
    }
  } else {
    // no residual filter — iterate keys via iterator without parsing values
    for await (const [_key, _value] of partition.iterator(iteratorOptions, options)) {
      count++;
    }
  }

  return count;
}
