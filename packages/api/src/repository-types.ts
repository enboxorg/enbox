/**
 * Type-level machinery for the protocol repository pattern.
 *
 * These types produce a statically-typed CRUD API shape from a
 * `ProtocolDefinition` + `SchemaMap`, with singleton detection
 * (via `$recordLimit: { max: 1 }`) and nested-path awareness.
 *
 * All types are purely compile-time — they produce no runtime code.
 *
 * @module
 */

import type { SchemaMap } from './protocol-types.js';
import type { TypedLiveQuery } from './typed-live-query.js';
import type { TypedRecord } from './typed-record.js';
import type {
  DataForPath,
  TypedCreateRequest,
  TypedQueryRequest,
  TypedSubscribeRequest,
} from './typed-web5.js';
import type { DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type { ProtocolDefinition, ProtocolRuleSet } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Structure navigation
// ---------------------------------------------------------------------------

/**
 * Navigates a `ProtocolRuleSet` tree to the node at a slash-delimited path.
 */
type RuleSetAtPath<R, Path extends string> =
  Path extends `${infer Head}/${infer Tail}`
    ? Head extends keyof R
      ? R[Head] extends ProtocolRuleSet
        ? RuleSetAtPath<R[Head], Tail>
        : never
      : never
    : Path extends keyof R
      ? R[Path] extends ProtocolRuleSet
        ? R[Path]
        : never
      : never;

// ---------------------------------------------------------------------------
// Singleton detection
// ---------------------------------------------------------------------------

/**
 * Extracts the `$recordLimit` from a rule set node, if present.
 */
type RecordLimitAtRuleSet<RS> =
  RS extends { $recordLimit: infer L } ? L : never;

/**
 * `true` when the rule set at `Path` has `$recordLimit: { max: 1 }`.
 */
export type IsSingleton<D extends ProtocolDefinition, Path extends string> =
  RecordLimitAtRuleSet<RuleSetAtPath<D['structure'], Path>> extends { max: 1 }
    ? true
    : false;

// ---------------------------------------------------------------------------
// Data type resolution
// ---------------------------------------------------------------------------

/** Resolves the TypeScript data type for a given path. */
type DataAt<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = DataForPath<D, M, Path>;

// ---------------------------------------------------------------------------
// Common option types
// ---------------------------------------------------------------------------

/**
 * Write options for a collection `create()` call.
 * Omits `data` (passed separately) and protocol-injected fields.
 */
export type CollectionCreateOptions<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = Omit<TypedCreateRequest<D, M, Path>, 'data' | 'parentContextId'> & {
  data: DataAt<D, M, Path>;
};

/**
 * Write options for a singleton `set()` call.
 */
export type SingletonSetOptions<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = Omit<TypedCreateRequest<D, M, Path>, 'data' | 'parentContextId'> & {
  data: DataAt<D, M, Path>;
};

// ---------------------------------------------------------------------------
// CRUD shapes
// ---------------------------------------------------------------------------

/** CRUD API for a root-level collection (unbounded or max > 1). */
export type CollectionCRUD<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  create(options: CollectionCreateOptions<D, M, Path>): Promise<DwnResponseStatus & { record: TypedRecord<DataAt<D, M, Path>> }>;
  query(options?: TypedQueryRequest): Promise<DwnResponseStatus & { records: TypedRecord<DataAt<D, M, Path>>[]; cursor?: DwnPaginationCursor }>;
  get(recordId: string): Promise<TypedRecord<DataAt<D, M, Path>>>;
  delete(recordId: string): Promise<DwnResponseStatus>;
  subscribe(options?: TypedSubscribeRequest): Promise<TypedLiveQuery<DataAt<D, M, Path>> | undefined>;
};

/** CRUD API for a root-level singleton ($recordLimit max: 1). */
export type SingletonCRUD<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  set(options: SingletonSetOptions<D, M, Path>): Promise<DwnResponseStatus & { record: TypedRecord<DataAt<D, M, Path>> }>;
  get(): Promise<TypedRecord<DataAt<D, M, Path>> | undefined>;
  delete(recordId: string): Promise<DwnResponseStatus>;
};

/** CRUD API for a nested collection (parent context required). */
export type NestedCollectionCRUD<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  create(
    parentContextId: string,
    options: CollectionCreateOptions<D, M, Path>,
  ): Promise<DwnResponseStatus & { record: TypedRecord<DataAt<D, M, Path>> }>;
  query(
    parentContextId: string,
    options?: TypedQueryRequest,
  ): Promise<DwnResponseStatus & { records: TypedRecord<DataAt<D, M, Path>>[]; cursor?: DwnPaginationCursor }>;
  get(recordId: string): Promise<TypedRecord<DataAt<D, M, Path>>>;
  delete(recordId: string): Promise<DwnResponseStatus>;
  subscribe(
    parentContextId: string,
    options?: TypedSubscribeRequest,
  ): Promise<TypedLiveQuery<DataAt<D, M, Path>> | undefined>;
};

/** CRUD API for a nested singleton ($recordLimit max: 1). */
export type NestedSingletonCRUD<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  set(
    parentContextId: string,
    options: SingletonSetOptions<D, M, Path>,
  ): Promise<DwnResponseStatus & { record: TypedRecord<DataAt<D, M, Path>> }>;
  get(parentContextId: string): Promise<TypedRecord<DataAt<D, M, Path>> | undefined>;
  delete(recordId: string): Promise<DwnResponseStatus>;
};

// ---------------------------------------------------------------------------
// Recursive repository node
// ---------------------------------------------------------------------------

/**
 * Extracts the child type names (non-`$`-prefixed keys that extend ProtocolRuleSet)
 * from a rule set node.
 */
type ChildKeys<RS> = {
  [K in Extract<keyof RS, string>]: K extends `$${string}`
    ? never
    : RS[K] extends ProtocolRuleSet
      ? K
      : never;
}[Extract<keyof RS, string>];

/**
 * Builds nested repository nodes for all children of a given rule set.
 */
type ChildNodes<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  RS,
  ParentPath extends string,
> = {
  [K in ChildKeys<RS>]: RepositoryNode<D, M, RS[K], `${ParentPath}/${K}`, true>;
};

/**
 * A single node in the repository tree. Provides CRUD methods appropriate
 * to whether the path is root/nested and singleton/collection, plus child
 * nodes for further nesting.
 */
export type RepositoryNode<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  RS,
  Path extends string,
  IsNested extends boolean = false,
> =
  // Choose CRUD shape based on singleton + nested status
  (IsNested extends true
    ? (IsSingleton<D, Path> extends true
      ? NestedSingletonCRUD<D, M, Path>
      : NestedCollectionCRUD<D, M, Path>)
    : (IsSingleton<D, Path> extends true
      ? SingletonCRUD<D, M, Path>
      : CollectionCRUD<D, M, Path>))
  // Plus child nodes for deeper nesting
  & ChildNodes<D, M, RS, Path>;

// ---------------------------------------------------------------------------
// Top-level repository type
// ---------------------------------------------------------------------------

/**
 * The top-level repository type for a protocol definition.
 *
 * Maps each root-level type name in the protocol's `structure` to a
 * `RepositoryNode` with the appropriate CRUD methods and nested children.
 *
 * @example
 * ```ts
 * const social: Repository<typeof SocialGraphDef, SocialGraphSchemaMap>;
 *
 * // Root collection
 * await social.friend.create({ data: { did: '...' } });
 * await social.friend.query();
 *
 * // Nested under group
 * await social.group.member.create(groupCtxId, { data: { did: '...' } });
 * ```
 */
export type Repository<
  D extends ProtocolDefinition,
  M extends SchemaMap,
> = {
  [K in Extract<keyof D['structure'], string> as K extends `$${string}` ? never : K]:
    D['structure'][K] extends ProtocolRuleSet
      ? RepositoryNode<D, M, D['structure'][K], K>
      : never;
} & {
  /** Install (configure) the protocol. Idempotent — no-op if already installed. */
  configure(options?: { encryption?: boolean }): Promise<DwnResponseStatus>;
};
