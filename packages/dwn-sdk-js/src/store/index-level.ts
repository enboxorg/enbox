import type { EqualFilter, Filter, KeyValues, PaginationCursor, QueryOptions, RangeFilter } from '../types/query-types.js';
import type { LevelWrapperBatchOperation, LevelWrapperIteratorOptions, } from './level-wrapper.js';

import { isEmptyObject } from '../utils/object.js';
import { lexicographicalCompare } from '../utils/string.js';
import { SortDirection } from '../types/query-types.js';
import {
  countWithCompoundIndex,
  createCompoundIndexDeleteOperation,
  createCompoundIndexPutOperation,
  queryWithCompoundIndex,
  selectCompoundIndex,
} from './index-level-compound.js';
import { createLevelDatabase, LevelWrapper } from './level-wrapper.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { FilterSelector, FilterUtility } from '../utils/filter.js';

export type IndexLevelConfig = {
  location: string,
  createLevelDatabase?: typeof createLevelDatabase,
  compoundIndexes?: CompoundIndexDefinition[],
};

export type IndexedItem = { messageCid: string, indexes: KeyValues };

/**
 * Defines a compound index that covers multiple filter properties and a sort property.
 *
 * When a query's equality filter properties match all `properties` AND its sort property
 * matches `sortProperty`, this compound index can serve the entire query from a single
 * LevelDB range scan — no in-memory filtering or sorting required.
 *
 * Key encoding: `<prop1>\x01<prop2>\x01...\x01<sortValue>\x00<messageCid>`
 */
export type CompoundIndexDefinition = {
  /** Unique name for this compound index (used as the sublevel partition name). */
  name: string;
  /** Filter properties that must all be present as equality filters in the query. */
  properties: string[];
  /** The sort property embedded at the end of the compound key. */
  sortProperty: string;
};

const INDEX_SUBLEVEL_NAME = 'index';

export interface IndexLevelOptions {
  signal?: AbortSignal;
}

/**
 * A LevelDB implementation for indexing the messages and events stored in the DWN.
 */
export class IndexLevel {
  db: LevelWrapper<string>;
  config: IndexLevelConfig;
  private _compoundIndexes: CompoundIndexDefinition[];

  constructor(config: IndexLevelConfig) {
    this.config = {
      createLevelDatabase,
      ...config,
    };

    this._compoundIndexes = config.compoundIndexes ?? [];

    this.db = new LevelWrapper<string>({
      location            : this.config.location,
      createLevelDatabase : this.config.createLevelDatabase,
      keyEncoding         : 'utf8'
    });
  }

  async open(): Promise<void> {
    await this.db.open();
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * deletes everything in the underlying index db.
   */
  async clear(): Promise<void> {
    await this.db.clear();
  }

  /**
   * Put an item into the index using information that will allow it to be queried for.
   *
   * @param tenant
   * @param messageCid a unique ID that represents the item being indexed, this is also used as the cursor value in a query.
   * @param indexes - (key-value pairs) to be included as part of indexing this item. Must include at least one indexing property.
   * @param options IndexLevelOptions that include an AbortSignal.
   */
  async put(
    tenant: string,
    messageCid: string,
    indexes: KeyValues,
    options?: IndexLevelOptions
  ): Promise<void> {

    // ensure we have something valid to index
    if (isEmptyObject(indexes)) {
      throw new DwnError(DwnErrorCode.IndexMissingIndexableProperty, 'Index must include at least one valid indexable property');
    }

    const item: IndexedItem = { messageCid, indexes };
    const opCreationPromises: Promise<LevelWrapperBatchOperation<string>>[] = [];

    // create an index entry for each property index
    // these indexes are all sortable lexicographically.
    for (const indexName in indexes) {
      const indexValue = indexes[indexName];
      if (Array.isArray(indexValue)) {
        for (const indexValueItem of indexValue) {
          const partitionOperationPromise = this.createPutIndexedItemOperation(tenant, item, indexName, indexValueItem);
          opCreationPromises.push(partitionOperationPromise);
        }
      } else {
        const partitionOperationPromise = this.createPutIndexedItemOperation(tenant, item, indexName, indexValue);
        opCreationPromises.push(partitionOperationPromise);
      }
    }

    // create compound index entries for any registered compound indexes whose properties are all present in the indexes.
    for (const compoundIndex of this._compoundIndexes) {
      const compoundOp = createCompoundIndexPutOperation(
        this.db, tenant, item, compoundIndex, IndexLevel.encodeValue, IndexLevel.delimiter
      );
      if (compoundOp !== undefined) {
        opCreationPromises.push(compoundOp);
      }
    }

    // create a reverse lookup for the sortedIndex values. This is used during deletion and cursor starting point lookup.
    const partitionOperationPromise = this.createOperationForIndexesLookupPartition(
      tenant,
      { type: 'put', key: messageCid, value: JSON.stringify(indexes) }
    );
    opCreationPromises.push(partitionOperationPromise);

    const indexOps = await Promise.all(opCreationPromises);
    const tenantPartition = await this.db.partition(tenant);
    await tenantPartition.batch(indexOps, options);
  }

  /**
   *  Deletes all of the index data associated with the item.
   */
  async delete(tenant: string, messageCid: string, options?: IndexLevelOptions): Promise<void> {
    const opCreationPromises: Promise<LevelWrapperBatchOperation<string>>[] = [];

    const indexes = await this.getIndexes(tenant, messageCid);
    if (indexes === undefined) {
      // invalid messageCid
      return;
    }

    // delete the reverse lookup
    const partitionOperationPromise = this.createOperationForIndexesLookupPartition(tenant, { type: 'del', key: messageCid });
    opCreationPromises.push(partitionOperationPromise);

    // delete the keys for each index
    for (const indexName in indexes) {
      const indexValue = indexes[indexName];
      if (Array.isArray(indexValue)) {
        for (const indexValueItem of indexValue) {
          const partitionOperationPromise = this.createDeleteIndexedItemOperation(tenant, messageCid, indexName, indexValueItem);
          opCreationPromises.push(partitionOperationPromise);
        }
      } else {
        const partitionOperationPromise = this.createDeleteIndexedItemOperation(tenant, messageCid, indexName, indexValue);
        opCreationPromises.push(partitionOperationPromise);
      }
    }

    // delete compound index entries
    for (const compoundIndex of this._compoundIndexes) {
      const compoundOp = createCompoundIndexDeleteOperation(
        this.db, tenant, messageCid, indexes, compoundIndex, IndexLevel.encodeValue, IndexLevel.delimiter
      );
      if (compoundOp !== undefined) {
        opCreationPromises.push(compoundOp);
      }
    }

    const indexOps = await Promise.all(opCreationPromises);
    const tenantPartition = await this.db.partition(tenant);
    await tenantPartition.batch(indexOps, options);
  }

  /**
   * Creates an IndexLevel `put` operation for indexing an item, creating a partition by `tenant` and by `indexName`
   */
  private async createPutIndexedItemOperation(
    tenant: string,
    item: IndexedItem,
    indexName: string,
    indexValue: string | number | boolean
  ): Promise<LevelWrapperBatchOperation<string>> {
    const { messageCid } = item;

    // The key is the indexValue followed by the messageCid as a tie-breaker.
    // for example if the property is messageTimestamp the key would look like:
    // '"2023-05-25T18:23:29.425008Z"\u0000bafyreigs3em7lrclhntzhgvkrf75j2muk6e7ypq3lrw3ffgcpyazyw6pry'
    const key = IndexLevel.keySegmentJoin(IndexLevel.encodeValue(indexValue), messageCid);

    return this.createOperationForIndexPartition(
      tenant,
      indexName,
      { type: 'put', key, value: JSON.stringify(item) }
    );
  }

  /**
   * Creates an IndexLevel `del` operation for deleting an item, creating a partition by `tenant` and by `indexName`
   */
  private async createDeleteIndexedItemOperation(
    tenant: string,
    messageCid: string,
    indexName: string,
    indexValue: string | number | boolean
  ): Promise<LevelWrapperBatchOperation<string>> {

    // The key is the indexValue followed by the messageCid as a tie-breaker.
    // for example if the property is messageTimestamp the key would look like:
    // '"2023-05-25T18:23:29.425008Z"\u0000bafyreigs3em7lrclhntzhgvkrf75j2muk6e7ypq3lrw3ffgcpyazyw6pry'
    const key = IndexLevel.keySegmentJoin(IndexLevel.encodeValue(indexValue), messageCid);

    return this.createOperationForIndexPartition(
      tenant,
      indexName,
      { type: 'del', key }
    );
  }

  /**
   * Wraps the given operation as an operation for the specified index partition.
   */
  private async createOperationForIndexPartition(tenant: string, indexName: string, operation: LevelWrapperBatchOperation<string>)
    : Promise<LevelWrapperBatchOperation<string>> {
    // we write the index entry into a sublevel-partition of tenantPartition.
    // putting each index entry within a sublevel allows the levelDB system to calculate a gt minKey and lt maxKey for each of the properties
    // this prevents them from clashing, especially when iterating in reverse without iterating through other properties.
    const tenantPartition = await this.db.partition(tenant);
    const indexPartitionName = IndexLevel.getIndexPartitionName(indexName);
    const partitionOperation = tenantPartition.createPartitionOperation(indexPartitionName, operation);
    return partitionOperation;
  }

  /**
   * Wraps the given operation as an operation for the messageCid to indexes lookup partition.
   */
  private async createOperationForIndexesLookupPartition(tenant: string, operation: LevelWrapperBatchOperation<string>)
    : Promise<LevelWrapperBatchOperation<string>> {
    const tenantPartition = await this.db.partition(tenant);
    const partitionOperation = tenantPartition.createPartitionOperation(INDEX_SUBLEVEL_NAME, operation);
    return partitionOperation;
  }

  private static getIndexPartitionName(indexName: string): string {
    // we create index partition names in __${indexName}__ wrapping so they do not clash with other sublevels that are created for other purposes.
    return `__${indexName}__`;
  }

  /**
   * Gets the index partition of the given indexName.
   */
  private async getIndexPartition(tenant: string, indexName: string): Promise<LevelWrapper<string>> {
    const indexPartitionName = IndexLevel.getIndexPartitionName(indexName);
    return (await this.db.partition(tenant)).partition(indexPartitionName);
  }

  /**
   * Gets the messageCid to indexes lookup partition.
   */
  private async getIndexesLookupPartition(tenant: string): Promise<LevelWrapper<string>> {
    return (await this.db.partition(tenant)).partition(INDEX_SUBLEVEL_NAME);
  }

  /**
   * Queries the index for items that match the filters. If no filters are provided, all items are returned.
   *
   * Query strategy selection (in priority order):
   * 1. **Compound index**: If a single filter matches a registered compound index (all equality properties + sort property),
   *    the entire query is served from a single LevelDB range scan. Supports cursors natively.
   * 2. **In-memory paging**: For "concise" filters without cursors. Scans the most selective property index, verifies in memory.
   * 3. **Iterator paging**: Default fallback. Scans the sort property index, testing each item against the filter.
   *
   * @param filters Array of filters that are treated as an OR query.
   * @param queryOptions query options for sort and pagination, requires at least `sortProperty`. The default sort direction is ascending.
   * @param options IndexLevelOptions that include an AbortSignal.
   * @returns {IndexedItem[]} an array of `IndexedItem` that match the given filters.
   */
  async query(tenant: string, filters: Filter[], queryOptions: QueryOptions, options?: IndexLevelOptions): Promise<IndexedItem[]> {

    // Strategy 1: try compound index for single-filter queries
    if (filters.length === 1 && !isEmptyObject(filters[0])) {
      const compoundResult = selectCompoundIndex(filters[0], queryOptions, this._compoundIndexes);
      if (compoundResult !== undefined) {
        return queryWithCompoundIndex(
          this.db, tenant, filters[0], queryOptions, compoundResult,
          IndexLevel.encodeValue, IndexLevel.delimiter,
          this.queryWithIteratorPaging.bind(this), options
        );
      }
    }

    // Strategy 2: in-memory paging for concise filters
    if (IndexLevel.shouldQueryWithInMemoryPaging(filters, queryOptions)) {
      return this.queryWithInMemoryPaging(tenant, filters, queryOptions, options);
    }

    // Strategy 3: iterator paging (default)
    return this.queryWithIteratorPaging(tenant, filters, queryOptions, options);
  }

  /**
   * Counts the number of items that match the given filters without loading full records.
   *
   * When a compound index covers the query, counting is a simple key iteration without value deserialization.
   * Otherwise, falls back to counting via the existing query strategies.
   */
  async count(tenant: string, filters: Filter[], queryOptions: Omit<QueryOptions, 'limit' | 'cursor'>,
    options?: IndexLevelOptions): Promise<number> {

    // try compound index for single-filter queries
    if (filters.length === 1 && !isEmptyObject(filters[0])) {
      const compoundResult = selectCompoundIndex(filters[0], { ...queryOptions }, this._compoundIndexes);
      if (compoundResult !== undefined) {
        return countWithCompoundIndex(
          this.db, tenant, filters[0], compoundResult,
          IndexLevel.encodeValue, this.query.bind(this), options
        );
      }
    }

    // fallback: run a full query without limit and count the results
    const results = await this.query(tenant, filters, { ...queryOptions }, options);
    return results.length;
  }

  /**
   * Queries the sort property index for items that match the filters. If no filters are provided, all items are returned.
   * This query is a linear iterator over the sorted index, checking each item for a match.
   * If a cursor is provided it starts the iteration from the cursor point.
   */
  async queryWithIteratorPaging(
    tenant: string,
    filters: Filter[],
    queryOptions: QueryOptions,
    options?: IndexLevelOptions
  ): Promise<IndexedItem[]> {
    const { cursor: queryCursor , limit } = queryOptions;

    // if there is a cursor we fetch the starting key given the sort property, otherwise we start from the beginning of the index.
    const startKey = queryCursor ? this.createStartingKeyFromCursor(queryCursor) : '';

    const matches: IndexedItem[] = [];
    for await ( const item of this.getIndexIterator(tenant, startKey, queryOptions, options)) {
      if (limit !== undefined && limit === matches.length) {
        break;
      }

      const { indexes } = item;
      if (FilterUtility.matchAnyFilter(indexes, filters)) {
        matches.push(item);
      }
    }

    return matches;
  }

  /**
   * Creates an AsyncGenerator that returns each sorted index item given a specific sortProperty.
   * If a cursor is passed, the starting value (gt or lt) is derived from that.
   */
  private async * getIndexIterator(
    tenant: string, startKey:string, queryOptions: QueryOptions, options?: IndexLevelOptions
  ): AsyncGenerator<IndexedItem> {
    const { sortProperty, sortDirection = SortDirection.Ascending, cursor } = queryOptions;

    const iteratorOptions: LevelWrapperIteratorOptions<string> = {
      gt: startKey
    };

    // if we are sorting in descending order we can iterate in reverse.
    if (sortDirection === SortDirection.Descending) {
      iteratorOptions.reverse = true;

      // if a cursor is provided and we are sorting in descending order, the startKey should be the upper bound.
      if (cursor !== undefined) {
        iteratorOptions.lt = startKey;
        delete iteratorOptions.gt;
      }
    }

    const sortPartition = await this.getIndexPartition(tenant, sortProperty);
    for await (const [ _, val ] of sortPartition.iterator(iteratorOptions, options)) {
      const { indexes, messageCid } = JSON.parse(val);
      yield { indexes, messageCid };
    }
  }

  /**
   * Creates the starting point for a LevelDB query given an messageCid as a cursor and the indexed property.
   * Used as (gt) for ascending queries, or (lt) for descending queries.
   */
  private createStartingKeyFromCursor(cursor: PaginationCursor): string {
    const { messageCid , value } = cursor;
    return IndexLevel.keySegmentJoin(IndexLevel.encodeValue(value), messageCid);
  }

  /**
   * Returns a PaginationCursor using the last item of a given array of IndexedItems.
   * If the given array is empty, undefined is returned.
   *
   * @throws {DwnError} if the sort property or cursor value is invalid.
   */
  static createCursorFromLastArrayItem(items: IndexedItem[], sortProperty: string): PaginationCursor | undefined {
    if (items.length > 0) {
      return this.createCursorFromItem(items.at(-1)!, sortProperty);
    }
  }

  /**
   * Creates a PaginationCursor from a given IndexedItem and sortProperty.
   *
   * @throws {DwnError} if the sort property or cursor value is invalid.
   */
  static createCursorFromItem(item: IndexedItem, sortProperty: string): PaginationCursor {
    const { messageCid , indexes } = item;
    const value = indexes[sortProperty];

    if (value === undefined) {
      throw new DwnError(DwnErrorCode.IndexInvalidCursorSortProperty, `the sort property '${sortProperty}' is not defined within the given item.`);
    }

    // we only support cursors for string or number types
    if (typeof value === 'boolean' || Array.isArray(value)) {
      throw new DwnError(
        DwnErrorCode.IndexInvalidCursorValueType,
        `only string or number values are supported for cursors, a(n) ${typeof value} was given.`
      );
    }

    return { messageCid , value };
  }

  /**
   * Queries the provided searchFilters asynchronously, returning results that match the matchFilters.
   *
   * @param filters the filters passed to the parent query.
   * @param searchFilters the modified filters used for the LevelDB query to search for a subset of items to match against.
   *
   * @throws {DwnErrorCode.IndexLevelInMemoryInvalidSortProperty} if an invalid sort property is provided.
   */
  async queryWithInMemoryPaging(
    tenant: string,
    filters: Filter[],
    queryOptions: QueryOptions,
    options?: IndexLevelOptions
  ): Promise<IndexedItem[]> {
    const { sortProperty, sortDirection = SortDirection.Ascending, cursor: queryCursor, limit } = queryOptions;

    // we get the cursor start key here so that we match the failing behavior of `queryWithIteratorPaging`
    const cursorStartingKey = queryCursor ? this.createStartingKeyFromCursor(queryCursor) : undefined;

    // we create a matches map so that we can short-circuit matched items within the async single query below.
    const matches:Map<string, IndexedItem> = new Map();

    // If the filter is empty, we just give it an empty filter so that we can iterate over all the items later in executeSingleFilterQuery().
    // We could do the iteration here, but it would be duplicating the same logic, so decided to just setup the data structure here.
    if (filters.length === 0) {
      filters = [{}];
    }

    try {
      await Promise.all(filters.map((filter: Filter): Promise<void> => {
        return this.executeSingleFilterQuery(tenant, filter, sortProperty, matches, options);
      }));
    } catch (error) {
      if ((error as DwnError).code === DwnErrorCode.IndexInvalidSortPropertyInMemory) {
        // return empty results if the sort property is invalid.
        return [];
      }
    }

    const sortedValues = [...matches.values()].sort((a,b) => this.sortItems(a,b, sortProperty, sortDirection));

    const start = cursorStartingKey !== undefined ? this.findCursorStartingIndex(sortedValues, sortDirection, sortProperty, cursorStartingKey) : 0;
    if (start < 0) {
      // if the provided cursor does not come before any of the results, we return no results
      return [];
    }

    const end = limit !== undefined ? start + limit: undefined;
    return sortedValues.slice(start, end);
  }

  /**
   * Execute a filtered query against a single filter and return all results.
   */
  private async executeSingleFilterQuery(
    tenant: string,
    filter: Filter,
    sortProperty: string,
    matches: Map<string, IndexedItem>,
    levelOptions?: IndexLevelOptions
  ): Promise<void> {

    // Note: We have an array of Promises in order to support OR (anyOf) matches when given a list of accepted values for a property
    const filterPromises: Promise<IndexedItem[]>[] = [];

    // If the filter is empty, then we just iterate over one of the indexes that contains all the records and return all items.
    if (isEmptyObject(filter)) {
      const getAllItemsPromise = this.getAllItems(tenant, sortProperty);
      filterPromises.push(getAllItemsPromise);
    }

    // else the filter is not empty
    const searchFilter = FilterSelector.reduceFilter(filter);
    for (const propertyName in searchFilter) {
      const propertyFilter = searchFilter[propertyName];
      // We will find the union of these many individual queries later.
      if (FilterUtility.isEqualFilter(propertyFilter)) {
        // propertyFilter is an EqualFilter, meaning it is a non-object primitive type
        const exactMatchesPromise = this.filterExactMatches(tenant, propertyName, propertyFilter, levelOptions);
        filterPromises.push(exactMatchesPromise);
      } else if (FilterUtility.isOneOfFilter(propertyFilter)) {
        // `propertyFilter` is a OneOfFilter
        // Support OR matches by querying for each values separately, then adding them to the promises array.
        for (const propertyValue of new Set(propertyFilter)) {
          const exactMatchesPromise = this.filterExactMatches(tenant, propertyName, propertyValue, levelOptions);
          filterPromises.push(exactMatchesPromise);
        }
      } else if (FilterUtility.isRangeFilter(propertyFilter)) {
        // `propertyFilter` is a `RangeFilter`
        const rangeMatchesPromise = this.filterRangeMatches(tenant, propertyName, propertyFilter, levelOptions);
        filterPromises.push(rangeMatchesPromise);
      }
    }

    // acting as an OR match for the property, any of the promises returning a match will be treated as a property match
    for (const promise of filterPromises) {
      const indexItems = await promise;
      // reminder: the promise returns a list of IndexedItem satisfying a particular property match
      for (const indexedItem of indexItems) {
        // short circuit: if a data is already included to the final matched key set (by a different `Filter`),
        // no need to evaluate if the data satisfies this current filter being evaluated
        // otherwise check that the item is a match.
        if (matches.has(indexedItem.messageCid) || !FilterUtility.matchFilter(indexedItem.indexes, filter)) {
          continue;
        }

        // ensure that each matched item has the sortProperty, otherwise fail the entire query.
        if (indexedItem.indexes[sortProperty] === undefined) {
          throw new DwnError(DwnErrorCode.IndexInvalidSortPropertyInMemory, `invalid sort property ${sortProperty}`);
        }

        matches.set(indexedItem.messageCid, indexedItem);
      }
    }
  }

  private async getAllItems(tenant: string, sortProperty: string): Promise<IndexedItem[]> {
    const filterPartition = await this.getIndexPartition(tenant, sortProperty);
    const items: IndexedItem[] = [];
    for await (const [ _key, value ] of filterPartition.iterator()) {
      items.push(JSON.parse(value) as IndexedItem);
    }
    return items;
  }

  /**
   * Returns items that match the exact property and value.
   */
  private async filterExactMatches(
    tenant:string,
    propertyName: string,
    propertyValue: EqualFilter,
    options?: IndexLevelOptions
  ): Promise<IndexedItem[]> {

    const matchPrefix = IndexLevel.keySegmentJoin(IndexLevel.encodeValue(propertyValue));
    const iteratorOptions: LevelWrapperIteratorOptions<string> = {
      gt: matchPrefix
    };

    const filterPartition = await this.getIndexPartition(tenant, propertyName);
    const matches: IndexedItem[] = [];
    for await (const [ key, value ] of filterPartition.iterator(iteratorOptions, options)) {
      // immediately stop if we arrive at an index that contains a different property value
      if (!key.startsWith(matchPrefix)) {
        break;
      }
      matches.push(JSON.parse(value) as IndexedItem);
    }
    return matches;
  }

  /**
   * Returns items that match the range filter.
   *
   * For `lte` bounds, the encoded value is extended with a trailing `\xff` so that composite keys
   * of the form `<encodedValue>\x00<messageCid>` are naturally included in the range scan,
   * eliminating the need for a separate exact-match query.
   */
  private async filterRangeMatches(
    tenant: string,
    propertyName: string,
    rangeFilter: RangeFilter,
    options?: IndexLevelOptions
  ): Promise<IndexedItem[]> {
    const iteratorOptions: LevelWrapperIteratorOptions<string> = {};
    for (const comparator in rangeFilter) {
      const comparatorName = comparator as keyof RangeFilter;
      const encodedValue = IndexLevel.encodeValue(rangeFilter[comparatorName]!);
      if (comparatorName === 'lte') {
        // Extend the lte bound so that composite keys `<encodedValue>\x00<messageCid>` are included.
        // Since \x00 < \xff, any key starting with encodedValue followed by the \x00 delimiter
        // will be lexicographically less than encodedValue + \xff.
        iteratorOptions[comparatorName] = encodedValue + '\xff';
      } else {
        iteratorOptions[comparatorName] = encodedValue;
      }
    }

    // if there is no lower bound specified (`gt` or `gte`), we need to iterate from the upper bound,
    // so that we will iterate over all the matches before hitting mismatches.
    if (iteratorOptions.gt === undefined && iteratorOptions.gte === undefined) {
      iteratorOptions.reverse = true;
    }

    const matches: IndexedItem[] = [];
    const filterPartition = await this.getIndexPartition(tenant, propertyName);

    for await (const [ key, value ] of filterPartition.iterator(iteratorOptions, options)) {
      // if "greater-than" is specified, skip all keys that contain the exact value given in the "greater-than" condition
      if ('gt' in rangeFilter && this.extractIndexValueFromKey(key) === IndexLevel.encodeValue(rangeFilter.gt!)) {
        continue;
      }
      matches.push(JSON.parse(value) as IndexedItem);
    }

    return matches;
  }

  /**
   * Sorts Items lexicographically in ascending or descending order given a specific indexName, using the messageCid as a tie breaker.
   * We know the indexes include the indexName and they are only of string or number type and not Arrays or booleans.
   * because they have already been checked within executeSingleFilterQuery.
   */
  private sortItems(itemA: IndexedItem, itemB: IndexedItem, indexName: string, direction: SortDirection): number {
    const itemAValue = itemA.indexes[indexName] as string | number;
    const itemBValue = itemB.indexes[indexName] as string | number;

    const aCompareValue = IndexLevel.encodeValue(itemAValue) + itemA.messageCid;
    const bCompareValue = IndexLevel.encodeValue(itemBValue) + itemB.messageCid;

    return direction === SortDirection.Ascending ?
      lexicographicalCompare(aCompareValue, bCompareValue) :
      lexicographicalCompare(bCompareValue, aCompareValue);
  }

  /**
   * Find the starting position for pagination within the IndexedItem array using binary search.
   * Returns the index of the first item after the cursor, or -1 if no such item exists.
   *
   * Since the array is already sorted, binary search provides O(log n) performance instead of O(n).
   */
  private findCursorStartingIndex(items: IndexedItem[], sortDirection: SortDirection, sortProperty: string, cursorStartingKey: string): number {

    const isAfterCursor = (item: IndexedItem): boolean => {
      const { messageCid, indexes } = item;
      const sortValue = indexes[sortProperty] as string | number;
      const itemCompareValue = IndexLevel.keySegmentJoin(IndexLevel.encodeValue(sortValue), messageCid);

      return sortDirection === SortDirection.Ascending ?
        itemCompareValue > cursorStartingKey :
        itemCompareValue < cursorStartingKey;
    };

    // binary search for the first item after the cursor
    let low = 0;
    let high = items.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (isAfterCursor(items[mid])) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    return low < items.length ? low : -1;
  }

  /**
   * Gets the indexes given an messageCid. This is a reverse lookup to construct starting keys, as well as deleting indexed items.
   */
  private async getIndexes(tenant: string, messageCid: string): Promise<KeyValues|undefined> {
    const indexesLookupPartition = await this.getIndexesLookupPartition(tenant);
    const serializedIndexes = await indexesLookupPartition.get(messageCid);
    if (serializedIndexes === undefined) {
      // invalid messageCid
      return;
    }

    return JSON.parse(serializedIndexes) as KeyValues;
  }

  /**
   * Given a key from an indexed partitioned property key.
   *  ex:
   *    key: '"2023-05-25T11:22:33.000000Z"\u0000bayfreigu....'
   *    returns "2023-05-25T11:22:33.000000Z"
   */
  private extractIndexValueFromKey(key: string): string {
    const [value] = key.split(IndexLevel.delimiter);
    return value;
  }

  /**
   * Joins the given values using the `\x00` (\u0000) character.
   */
  private static delimiter = `\x00`;
  private static keySegmentJoin(...values: string[]): string {
    return values.join(IndexLevel.delimiter);
  }

  /**
   *  Encodes a numerical value as a string for lexicographical comparison.
   *  If the number is positive it simply pads it with leading zeros.
   *  ex.: input:  1024 => "0000000000001024"
   *       input: -1024 => "!9007199254739967"
   *
   * @param value the number to encode.
   * @returns a string representation of the number.
   */
  static encodeNumberValue(value: number): string {
    const NEGATIVE_OFFSET = Number.MAX_SAFE_INTEGER;
    const NEGATIVE_PREFIX = '!'; // this will be sorted below positive numbers lexicographically
    const PADDING_LENGTH = String(Number.MAX_SAFE_INTEGER).length;

    const prefix: string = value < 0 ? NEGATIVE_PREFIX : '';
    const offset: number = value < 0 ? NEGATIVE_OFFSET : 0;
    return prefix + String(value + offset).padStart(PADDING_LENGTH, '0');
  }

  /**
   * Encodes an indexed value to a string
   *
   * NOTE: we currently only use this for strings, numbers and booleans.
   */
  static encodeValue(value: string | number | boolean): string {
    switch (typeof value) {
    case 'number':
      return this.encodeNumberValue(value);
    default:
      return JSON.stringify(value);
    }
  }

  // =========================================================================
  // Query strategy selection
  // =========================================================================

  private static shouldQueryWithInMemoryPaging(filters: Filter[], queryOptions: QueryOptions): boolean {
    for (const filter of filters) {
      if (!IndexLevel.isFilterConcise(filter, queryOptions)) {
        return false;
      }
    }

    // only use in-memory paging if all filters are concise
    return true;
  }

  public static isFilterConcise(filter: Filter, queryOptions: QueryOptions): boolean {
    // if there is a specific recordId in the filter, return true immediately.
    if (filter.recordId !== undefined) {
      return true;
    }

    // unless a recordId is present, if there is a cursor we never use in memory paging
    if (queryOptions.cursor !== undefined) {
      return false;
    }
    // NOTE: remaining conditions will not have cursor
    if (
      filter.protocolPath !== undefined ||
      filter.contextId !== undefined ||
      filter.parentId !== undefined ||
      filter.schema !== undefined
    ) {
      return true;
    }

    // all else
    return false;
  }
}
