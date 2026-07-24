import type { DwnPaginationCursor } from '@enbox/agent';
import type { DataFormatAtPath, ProtocolPaths, TagKeys, TagsAtPath } from './protocol-types.js';
import type { Pagination, ProtocolDefinition, RecordsFilter } from '@enbox/dwn-sdk-js';

import { DateSort, getTypeName } from '@enbox/dwn-sdk-js';

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

type RecordFilterInput = Omit<RecordsFilter, 'author' | 'contextId' | 'parentId' | 'recipient'> & {
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
// Keep these constraints aligned with defs.json#/$defs/contextId in @enbox/dwn-sdk-js.
const CONTEXT_ID_MAX_LENGTH = 600;
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9]+(?:\/[a-zA-Z0-9]+)*$/;

/**
 * Type-safe scalar tag filters explicitly declared by the protocol at one
 * exact path. Undefined tags allowed by protocol policy, array-valued tags,
 * and tag policy inherited through `$ref` remain available through the raw
 * DWN API instead of widening this surface.
 */
type RecordTagFilters<
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
 * Protocol identity fields are injected from the typed protocol, while
 * context selection is expressed through {@link RecordQuery.within}.
 */
export type RecordFilter<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = Omit<RecordsFilter, 'author' | 'contextId' | 'parentId' | 'recipient' | 'protocol' | 'protocolPath' | 'schema' | 'tags' | 'dataFormat'> & {
  /** One author, or a non-empty set of authors. */
  author?: StringSelection;

  /** One recipient, or a non-empty set of recipients. */
  recipient?: StringSelection;

  /** A data format declared for this exact protocol path. */
  dataFormat?: DataFormatAtPath<D, Path>;

  /** Protocol-declared scalar tag filters for this exact path. */
  tags?: RecordTagFilters<D, Path>;
};

/**
 * The canonical typed selection accepted by `records.query()`,
 * `records.count()`, and `records.observe()`.
 *
 * Count evaluates the same authorized population before pagination. Sort
 * order is immaterial to a count, except that published-date sorting selects
 * published records only, exactly as it does for a query.
 */
export type RecordQuery<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = {
  /** A remote DWN tenant to query. Omit for the connected tenant's local DWN. */
  from?: string;

  /** Additional value filters; protocol identity and context are compiled automatically. */
  filter?: RecordFilter<D, Path>;

  /**
   * Select records within one protocol context.
   *
   * Combined with the exact protocol path, a path one level below the
   * context selects direct children; a deeper path selects descendants at
   * that exact path.
   */
  within?: string;

  /** Existing DWN created, published, or updated date ordering. */
  dateSort?: DateSort;

  /** Keyset pagination for `query()`; validated but excluded from `count()`. */
  pagination?: { limit?: number; cursor?: DwnPaginationCursor };

  /** Protocol role used to authorize the operation. */
  protocolRole?: string;
};

/** @internal Canonical low-level request produced from a typed record query. */
type CompiledRecordQuery = {
  from?: string;
  filter: RecordsFilter & { protocol: string; protocolPath: string };
  dateSort?: DateSort;
  pagination?: Pagination;
  protocolRole?: string;
};

/**
 * @internal Compile one typed record query into the low-level request
 * shape shared by query, count, and observed-view consumers.
 */
export function compileRecordQuery(
  definition: ProtocolDefinition,
  protocolPath: string,
  query: {
    from?: string;
    filter?: RecordFilterInput;
    dateSort?: DateSort;
    pagination?: Pagination;
    protocolRole?: string;
    within?: string;
  } = {},
): CompiledRecordQuery {
  assertValidQueryControls(query.dateSort, query.pagination);
  assertValidRecordWithin(protocolPath, query.within, true);

  return {
    from         : query.from,
    filter       : buildRecordFilter(definition, protocolPath, query.filter, query.dateSort, query.within),
    dateSort     : query.dateSort,
    pagination   : query.pagination,
    protocolRole : query.protocolRole,
  };
}

/** @internal Compile and validate the shared selection filter. */
export function compileRecordFilter(
  definition: ProtocolDefinition,
  protocolPath: string,
  filter: RecordFilterInput | undefined,
  dateSort?: DateSort,
  within?: string,
): RecordsFilter & { protocol: string; protocolPath: string } {
  assertValidRecordWithin(protocolPath, within, false);
  return buildRecordFilter(definition, protocolPath, filter, dateSort, within);
}

function buildRecordFilter(
  definition: ProtocolDefinition,
  protocolPath: string,
  filter: RecordFilterInput | undefined,
  dateSort?: DateSort,
  within?: string,
): RecordsFilter & { protocol: string; protocolPath: string } {
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

  const typeName = getTypeName(protocolPath);
  const schema = definition.types[typeName]?.schema;
  return {
    ...compiledFilter,
    ...(within === undefined ? {} : { contextId: within }),
    protocol: definition.protocol,
    protocolPath,
    ...(schema === undefined ? {} : { schema }),
  };
}

function assertValidFilter(filter: RecordFilterInput | undefined, dateSort: DateSort | undefined): void {
  if (filter !== undefined && (Object.hasOwn(filter, 'contextId') || Object.hasOwn(filter, 'parentId'))) {
    throw new TypeError('RecordFilter: use the top-level within selector instead of contextId or parentId.');
  }
  if (Array.isArray(filter?.author) && filter.author.length === 0) {
    throw new TypeError('RecordFilter: author must not be an empty array.');
  }
  if (Array.isArray(filter?.recipient) && filter.recipient.length === 0) {
    throw new TypeError('RecordFilter: recipient must not be an empty array.');
  }
  if (filter?.tags !== undefined && Object.keys(filter.tags).length === 0) {
    throw new TypeError('RecordFilter: tags must contain at least one tag filter.');
  }
  if (filter?.published === false && selectsPublishedRecords(filter, dateSort)) {
    throw new TypeError('RecordFilter: published-date filters and sorting cannot be combined with published: false.');
  }
}

/** @internal Validate one typed record context selector. */
export function assertValidRecordWithin(
  protocolPath : string,
  within : string | undefined,
  requiredForNestedPath : boolean,
): void {
  if (within === undefined) {
    if (requiredForNestedPath && protocolPath.includes('/')) {
      throw new TypeError(`Record scope: nested protocol path '${protocolPath}' requires a within selector.`);
    }
    return;
  }

  if (typeof within !== 'string'
    || within.length > CONTEXT_ID_MAX_LENGTH
    || !CONTEXT_ID_PATTERN.test(within)) {
    throw new TypeError('Record scope: within must be at most 600 characters of alphanumeric path segments.');
  }

  if (within.split('/').length > protocolPath.split('/').length) {
    throw new TypeError(`Record scope: within cannot be deeper than protocol path '${protocolPath}'.`);
  }
}

function assertValidQueryControls(dateSort: DateSort | undefined, pagination: Pagination | undefined): void {
  if (dateSort !== undefined && !dateSortValues.has(dateSort)) {
    throw new TypeError(`RecordQuery: unsupported dateSort '${dateSort}'.`);
  }
  if (pagination === undefined) {
    return;
  }
  if (!isPlainObject(pagination) || hasUnexpectedKeys(pagination, ['limit', 'cursor'])) {
    throw new TypeError('RecordQuery: pagination must contain only limit and cursor.');
  }
  if (pagination.limit !== undefined
    && (typeof pagination.limit !== 'number' || !Number.isFinite(pagination.limit) || pagination.limit < 1)) {
    throw new TypeError('RecordQuery: pagination.limit must be a finite number greater than or equal to 1.');
  }
  if (pagination.cursor === undefined) {
    return;
  }

  const cursor = pagination.cursor;
  if (!isPlainObject(cursor)
    || hasUnexpectedKeys(cursor, ['messageCid', 'value'])
    || typeof cursor.messageCid !== 'string'
    || (typeof cursor.value !== 'string' && (typeof cursor.value !== 'number' || !Number.isFinite(cursor.value)))) {
    throw new TypeError('RecordQuery: pagination.cursor must contain a string messageCid and a string or finite number value.');
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

function selectsPublishedRecords(filter: RecordFilterInput | undefined, dateSort: DateSort | undefined): boolean {
  return filter?.datePublished !== undefined
    || dateSort === DateSort.PublishedAscending
    || dateSort === DateSort.PublishedDescending;
}
