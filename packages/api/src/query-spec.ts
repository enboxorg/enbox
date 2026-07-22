import type { DwnPaginationCursor } from '@enbox/agent';
import type { DataFormatAtPath, ProtocolPaths, TagKeys, TagsAtPath } from './protocol-types.js';
import type { Pagination, ProtocolDefinition, RecordsFilter } from '@enbox/dwn-sdk-js';

import { DateSort } from '@enbox/dwn-sdk-js';

type LowerBound<T extends string | number> =
  | { gt: T; gte?: never }
  | { gt?: never; gte: T };

type UpperBound<T extends string | number> =
  | { lt: T; lte?: never }
  | { lt?: never; lte: T };

type RangeFilter<T extends string | number> =
  (LowerBound<T> | UpperBound<T>) & Partial<LowerBound<T>> & Partial<UpperBound<T>>;

type EnumValue<Schema, Fallback> = Schema extends { enum: readonly (infer Value)[] }
  ? Extract<Value, Fallback>
  : Fallback;

type TagFilterForSchema<Schema> =
  Schema extends { type: 'string' }
    ? EnumValue<Schema, string> | { startsWith: string } | RangeFilter<string>
    : Schema extends { type: 'number' | 'integer' }
      ? EnumValue<Schema, number> | RangeFilter<number>
      : Schema extends { type: 'boolean' }
        ? EnumValue<Schema, boolean>
        : never;

type ScalarTagKeys<D extends ProtocolDefinition, Path extends string> = {
  [Key in TagKeys<TagsAtPath<D, Path>>]: TagsAtPath<D, Path>[Key] extends {
    type: 'string' | 'number' | 'integer' | 'boolean';
  } ? Key : never;
}[TagKeys<TagsAtPath<D, Path>>];

type StringSelection = string | string[] | readonly string[];

type QueryFilterInput = Omit<RecordsFilter, 'author' | 'recipient' | 'parentId'> & {
  author?: StringSelection;
  recipient?: StringSelection;
};

const dateSortValues = new Set<unknown>([
  DateSort.CreatedAscending,
  DateSort.CreatedDescending,
  DateSort.PublishedAscending,
  DateSort.PublishedDescending,
  DateSort.UpdatedAscending,
  DateSort.UpdatedDescending,
]);

/**
 * Type-safe scalar tag filters explicitly declared by the protocol at one
 * exact path. Undefined tags allowed by protocol policy, array-valued tags,
 * and tag policy inherited through `$ref` remain available through the raw
 * DWN API instead of widening this surface.
 */
export type QueryTagFilters<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = [TagsAtPath<D, Path>] extends [never]
  ? never
  : [ScalarTagKeys<D, Path>] extends [never]
    ? never
    : {
      [Key in ScalarTagKeys<D, Path>]?: TagFilterForSchema<TagsAtPath<D, Path>[Key]>;
    };

/**
 * Filter fields accepted by the typed query surface for one protocol path.
 * Protocol identity fields are injected from the typed protocol and cannot
 * be overridden by a caller.
 */
export type QueryFilter<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = Omit<RecordsFilter, 'author' | 'recipient' | 'parentId' | 'protocol' | 'protocolPath' | 'schema' | 'tags' | 'dataFormat'> & {
  /** One author, or a non-empty set of authors. */
  author?: StringSelection;

  /** One recipient, or a non-empty set of recipients. */
  recipient?: StringSelection;

  /** A data format declared for this exact protocol path. */
  dataFormat?: DataFormatAtPath<D, Path>;

  /** Protocol-declared scalar tag filters for this exact path. */
  tags?: QueryTagFilters<D, Path>;
};

/**
 * The canonical typed selection accepted by `records.query()` and
 * `records.count()`, and later by `records.observe()`.
 *
 * Count evaluates the same authorized population before pagination. Sort
 * order is immaterial to a count, except that published-date sorting selects
 * published records only, exactly as it does for a query.
 */
export type QuerySpec<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = {
  /** A remote DWN tenant to query. Omit for the connected tenant's local DWN. */
  from?: string;

  /** Additional filters; protocol, path, and schema are injected automatically. */
  filter?: QueryFilter<D, Path>;

  /** Existing DWN created, published, or updated date ordering. */
  dateSort?: DateSort;

  /** Keyset pagination for `query()`; validated but excluded from `count()`. */
  pagination?: { limit?: number; cursor?: DwnPaginationCursor };

  /** Protocol role used to authorize the operation. */
  protocolRole?: string;
};

/** Options for draining a {@link QuerySpec} to cursor exhaustion. */
export type QueryAllSpec<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = Omit<QuerySpec<D, Path>, 'pagination'> & {
  pageSize?: number;
  maxRecords?: number;
  maxPages?: number;
};

/** @internal Canonical low-level selection produced from a typed query spec. */
type CompiledQuerySpec = {
  from?: string;
  filter: RecordsFilter;
  dateSort?: DateSort;
  pagination?: Pagination;
  protocolRole?: string;
};

/**
 * @internal Compile one typed query specification into the low-level request
 * shape shared by query, queryAll, count, and subscription consumers.
 */
export function compileQuerySpec(
  definition: ProtocolDefinition,
  protocolPath: string,
  spec: {
    from?: string;
    filter?: QueryFilterInput;
    dateSort?: DateSort;
    pagination?: Pagination;
    protocolRole?: string;
  } = {},
): CompiledQuerySpec {
  assertValidQueryControls(spec.dateSort, spec.pagination);

  return {
    from         : spec.from,
    filter       : compileQueryFilter(definition, protocolPath, spec.filter, spec.dateSort),
    dateSort     : spec.dateSort,
    pagination   : spec.pagination,
    protocolRole : spec.protocolRole,
  };
}

/** @internal Compile and validate the shared selection filter. */
export function compileQueryFilter(
  definition: ProtocolDefinition,
  protocolPath: string,
  filter: QueryFilterInput | undefined,
  dateSort?: DateSort,
): RecordsFilter {
  assertValidFilter(filter, dateSort);

  const { author, recipient, ...rest } = filter ?? {};
  const compiledFilter: RecordsFilter = {
    ...rest,
    ...(author === undefined ? {} : { author: normalizeStringSelection(author) }),
    ...(recipient === undefined ? {} : { recipient: normalizeStringSelection(recipient) }),
  };
  if (selectsPublishedRecords(filter, dateSort)) {
    compiledFilter.published = true;
  }

  const directParentId = getDirectParentId(filter?.contextId, protocolPath);
  if (directParentId !== undefined) {
    compiledFilter.parentId = directParentId;
  }

  const typeName = protocolPath.split('/').at(-1)!;
  const schema = definition.types[typeName]?.schema;
  return {
    ...compiledFilter,
    protocol: definition.protocol,
    protocolPath,
    ...(schema === undefined ? {} : { schema }),
  };
}

function assertValidFilter(filter: QueryFilterInput | undefined, dateSort: DateSort | undefined): void {
  if (Array.isArray(filter?.author) && filter.author.length === 0) {
    throw new TypeError('QuerySpec: filter.author must not be an empty array.');
  }
  if (Array.isArray(filter?.recipient) && filter.recipient.length === 0) {
    throw new TypeError('QuerySpec: filter.recipient must not be an empty array.');
  }
  if (filter?.tags !== undefined && Object.keys(filter.tags).length === 0) {
    throw new TypeError('QuerySpec: filter.tags must contain at least one tag filter.');
  }
  if (filter?.published === false && selectsPublishedRecords(filter, dateSort)) {
    throw new TypeError('QuerySpec: published-date filters and sorting cannot be combined with published: false.');
  }
}

function assertValidQueryControls(dateSort: DateSort | undefined, pagination: Pagination | undefined): void {
  if (dateSort !== undefined && !dateSortValues.has(dateSort)) {
    throw new TypeError(`QuerySpec: unsupported dateSort '${dateSort}'.`);
  }
  if (pagination === undefined) {
    return;
  }
  if (!isPlainObject(pagination) || hasUnexpectedKeys(pagination, ['limit', 'cursor'])) {
    throw new TypeError('QuerySpec: pagination must contain only limit and cursor.');
  }
  if (pagination.limit !== undefined
    && (typeof pagination.limit !== 'number' || !Number.isFinite(pagination.limit) || pagination.limit < 1)) {
    throw new TypeError('QuerySpec: pagination.limit must be a finite number greater than or equal to 1.');
  }
  if (pagination.cursor === undefined) {
    return;
  }

  const cursor = pagination.cursor;
  if (!isPlainObject(cursor)
    || hasUnexpectedKeys(cursor, ['messageCid', 'value'])
    || typeof cursor.messageCid !== 'string'
    || (typeof cursor.value !== 'string' && (typeof cursor.value !== 'number' || !Number.isFinite(cursor.value)))) {
    throw new TypeError('QuerySpec: pagination.cursor must contain a string messageCid and a string or finite number value.');
  }
}

function hasUnexpectedKeys(value: object, allowedKeys: string[]): boolean {
  return Object.keys(value).some((key) => !allowedKeys.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringSelection(selection: StringSelection): string | string[] {
  return typeof selection === 'string' ? selection : [...selection];
}

/**
 * Add an exact parent-ID fence when `contextId` names the direct parent of
 * the selected path. This preserves exact child selection independently of
 * the DWN context index's prefix representation. Shallower context scopes
 * are left unfenced so the DWN layer can give them segment-safe descendant
 * semantics in the follow-up implementation.
 */
function getDirectParentId(contextId: string | undefined, protocolPath: string): string | undefined {
  if (contextId === undefined) {
    return undefined;
  }

  const pathDepth = protocolPath.split('/').length;
  const contextSegments = contextId.split('/');
  return pathDepth > 1 && contextSegments.length === pathDepth - 1
    ? contextSegments.at(-1)
    : undefined;
}

function selectsPublishedRecords(filter: QueryFilterInput | undefined, dateSort: DateSort | undefined): boolean {
  return filter?.datePublished !== undefined
    || dateSort === DateSort.PublishedAscending
    || dateSort === DateSort.PublishedDescending;
}
