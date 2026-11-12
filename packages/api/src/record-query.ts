import type { DataFormatAtPath, ModulePaths, TagKeys, TagsAtPath } from './module-types.js';
import type { ModuleDefinition, Pagination, RecordsFilter, ResolvedModuleGraph, ResolvedModuleNode } from '@enbox/dwn-sdk-js';

import { isPlainObject } from './utils.js';
import { DateSort, resolveModuleGraph } from '@enbox/dwn-sdk-js';

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

type ScalarTagKeys<D extends ModuleDefinition, Path extends string> = {
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
 * Type-safe scalar tag filters explicitly declared by the module at one
 * exact path. Undefined tags allowed by module policy, array-valued tags,
 * and tag policy inherited through `$ref` remain available through the raw
 * DWN API instead of widening this surface.
 */
type RecordTagFilters<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = [TagsAtPath<D, Path>] extends [never]
  ? never
  : [ScalarTagKeys<D, Path>] extends [never]
    ? never
    : {
      [Key in ScalarTagKeys<D, Path>]?: TagFilterForSchema<TagsAtPath<D, Path>[Key]>;
    };

/**
 * Filter fields accepted by the typed query surface for one module path.
 * Module identity fields are injected from the typed module, while
 * context selection is expressed through {@link RecordQuery.within}.
 */
export type RecordFilter<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = Omit<RecordsFilter, 'author' | 'contextId' | 'parentId' | 'recipient' | 'module' | 'modulePath' | 'schema' | 'tags' | 'dataFormat'> & {
  /** One author, or a non-empty set of authors. */
  author?: StringSelection;

  /** One recipient, or a non-empty set of recipients. */
  recipient?: StringSelection;

  /** A data format declared for this exact module path. */
  dataFormat?: DataFormatAtPath<D, Path>;

  /** Module-declared scalar tag filters for this exact path. */
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
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = {
  /** A remote DWN tenant to query. Omit for the connected tenant's local DWN. */
  from?: string;

  /** Additional value filters; module identity and context are compiled automatically. */
  filter?: RecordFilter<D, Path>;

  /**
   * Select records within one module context.
   *
   * Combined with the exact module path, a path one level below the
   * context selects direct children; a deeper path selects descendants at
   * that exact path.
   */
  within?: string;

  /** Existing DWN created, published, or updated date ordering. */
  dateSort?: DateSort;

  /** Maximum records returned by one `query()` page. Continue through `RecordPage.next()`. */
  pagination?: { limit?: number };

  /** Module role used to authorize the operation. */
  moduleRole?: string;
};

/** @internal Canonical low-level request produced from a typed record query. */
type CompiledRecordQuery = {
  from?: string;
  filter: RecordsFilter & { module: string; modulePath: string };
  dateSort?: DateSort;
  pagination?: Pagination;
  moduleRole?: string;
};

type QueryModule = ModuleDefinition | ResolvedModuleGraph;

/** @internal Resolve a local record selection without treating attachment nodes as records. */
export function resolveRecordQueryNode(module: QueryModule, path: string): ResolvedModuleNode {
  const graph = 'nodesByDeclaredPath' in module
    ? module
    : resolveModuleGraph(module, () => undefined, { requireKeyAgreement: false });
  const node = graph.nodesByDeclaredPath.get(path);
  if (node === undefined || node.kind !== 'record') {
    throw new TypeError(`Record scope: '${path}' is not a locally owned record path.`);
  }
  return node;
}

/**
 * @internal Compile one typed record query into the low-level request
 * shape shared by query, count, and observed-view consumers.
 */
export function compileRecordQuery(
  definition: QueryModule,
  modulePath: string,
  query: {
    from?: string;
    filter?: RecordFilterInput;
    dateSort?: DateSort;
    pagination?: { limit?: number };
    moduleRole?: string;
    within?: string;
  } = {},
): CompiledRecordQuery {
  assertValidQueryControls(query.dateSort, query.pagination);
  const node = resolveRecordQueryNode(definition, modulePath);
  assertValidRecordWithin(node, query.within, true);

  return {
    from       : query.from,
    filter     : buildRecordFilter(node, query.filter, query.dateSort, query.within),
    dateSort   : query.dateSort,
    pagination : query.pagination,
    moduleRole : query.moduleRole,
  };
}

/** @internal Compile and validate the shared selection filter. */
export function compileRecordFilter(
  definition: QueryModule,
  modulePath: string,
  filter: RecordFilterInput | undefined,
  within?: string,
): RecordsFilter & { module: string; modulePath: string } {
  const node = resolveRecordQueryNode(definition, modulePath);
  assertValidRecordWithin(node, within, false);
  return buildRecordFilter(node, filter, undefined, within);
}

function buildRecordFilter(
  node: ResolvedModuleNode,
  filter: RecordFilterInput | undefined,
  dateSort?: DateSort,
  within?: string,
): RecordsFilter & { module: string; modulePath: string } {
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

  const schema = node.recordType.schema;
  return {
    ...compiledFilter,
    ...(within === undefined ? {} : { contextId: within }),
    module     : node.owningModuleUri,
    modulePath : node.owningModulePath,
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
  node : Pick<ResolvedModuleNode, 'declaringModulePath' | 'physicalDepth'>,
  within : string | undefined,
  requiredForNestedPath : boolean,
): void {
  if (within === undefined) {
    if (requiredForNestedPath && node.physicalDepth > 1) {
      throw new TypeError(`Record scope: nested module path '${node.declaringModulePath}' requires a within selector.`);
    }
    return;
  }

  if (!isValidRecordContextId(within)) {
    throw new TypeError('Record scope: within must be at most 600 characters of alphanumeric path segments.');
  }

  if (within.split('/').length > node.physicalDepth) {
    throw new TypeError(`Record scope: within cannot be deeper than module path '${node.declaringModulePath}'.`);
  }
}

/** Whether a context ID has the canonical bounded, non-empty path-segment syntax. */
export function isValidRecordContextId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CONTEXT_ID_MAX_LENGTH && CONTEXT_ID_PATTERN.test(value);
}

function assertValidQueryControls(
  dateSort: DateSort | undefined,
  pagination: { limit?: number } | undefined,
): void {
  if (dateSort !== undefined && !dateSortValues.has(dateSort)) {
    throw new TypeError(`RecordQuery: unsupported dateSort '${dateSort}'.`);
  }
  if (pagination === undefined) {
    return;
  }
  if (!isPlainObject(pagination) || hasUnexpectedKeys(pagination, ['limit'])) {
    throw new TypeError('RecordQuery: pagination must contain only limit.');
  }
  if (pagination.limit !== undefined
    && (!Number.isSafeInteger(pagination.limit) || pagination.limit < 1)) {
    throw new TypeError('RecordQuery: pagination.limit must be a positive safe integer.');
  }
}

function hasUnexpectedKeys(value: object, allowedKeys: string[]): boolean {
  return Object.keys(value).some((key) => !allowedKeys.includes(key));
}

function normalizeStringSelection(selection: StringSelection): string | string[] {
  return typeof selection === 'string' ? selection : [...selection];
}

function selectsPublishedRecords(filter: RecordFilterInput | undefined, dateSort: DateSort | undefined): boolean {
  return filter?.datePublished !== undefined
    || dateSort === DateSort.PublishedAscending
    || dateSort === DateSort.PublishedDescending;
}
