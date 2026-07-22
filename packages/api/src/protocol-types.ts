/**
 * Type-level utilities for extracting typed paths, type names, schemas,
 * data formats, and tag shapes from a {@link ProtocolDefinition}.
 *
 * These types are purely compile-time — they produce no runtime code.
 */

import type { ProtocolDefinition, ProtocolRuleSet, ProtocolTagsDefinition, ProtocolType } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/**
 * Recursively extracts all valid protocol path strings from a `ProtocolRuleSet`.
 *
 * Given a structure like `{ foo: { bar: { ... } } }`, this produces
 * `'foo' | 'foo/bar'`.  Directive keys (starting with `$`) are excluded.
 */
export type RuleSetPaths<R, Prefix extends string = ''> = {
  [K in Extract<keyof R, string>]: K extends `$${string}`
    ? never
    : R[K] extends ProtocolRuleSet
      ? `${Prefix}${K}` | RuleSetPaths<R[K], `${Prefix}${K}/`>
      : never;
}[Extract<keyof R, string>];

/**
 * All valid protocol path strings for a given `ProtocolDefinition`.
 *
 * @example
 * ```ts
 * type Paths = ProtocolPaths<typeof myDef>;
 * // 'friend' | 'friend/message' | 'group' | 'group/member'
 * ```
 */
export type ProtocolPaths<D extends ProtocolDefinition> = RuleSetPaths<D['structure']>;

// ---------------------------------------------------------------------------
// Type-name extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the last segment (type name) from a protocol path string.
 *
 * @example
 * ```ts
 * type T = TypeNameAtPath<'group/member'>; // 'member'
 * ```
 */
export type TypeNameAtPath<Path extends string> =
  Path extends `${string}/${infer Rest}`
    ? TypeNameAtPath<Rest>
    : Path;

// ---------------------------------------------------------------------------
// Schema & data-format lookup
// ---------------------------------------------------------------------------

/**
 * The type names declared in the `types` map of a `ProtocolDefinition`.
 */
export type TypeNames<D extends ProtocolDefinition> = Extract<keyof D['types'], string>;

/**
 * Looks up the `schema` URI for a given type name in the protocol definition.
 * Returns `undefined` if the type does not declare a schema.
 */
export type SchemaForType<D extends ProtocolDefinition, TypeName extends string> =
  TypeName extends keyof D['types']
    ? D['types'][TypeName] extends ProtocolType
      ? D['types'][TypeName]['schema']
      : undefined
    : undefined;

/**
 * Looks up the `dataFormats` array for a given type name in the protocol definition.
 * Returns `undefined` if the type does not declare dataFormats.
 */
export type DataFormatsForType<D extends ProtocolDefinition, TypeName extends string> =
  TypeName extends keyof D['types']
    ? D['types'][TypeName] extends ProtocolType
      ? D['types'][TypeName]['dataFormats']
      : undefined
    : undefined;

/**
 * Resolves the `dataFormat` string literal union for a protocol path.
 * Protocol types without a declared `dataFormats` list retain the raw
 * string escape hatch.
 */
export type DataFormatAtPath<
  D extends ProtocolDefinition,
  Path extends string,
> = DataFormatsForType<D, TypeNameAtPath<Path>> extends infer Formats
  ? Formats extends readonly string[]
    ? Formats[number]
    : string
  : string;

// ---------------------------------------------------------------------------
// Tag extraction helpers
// ---------------------------------------------------------------------------

/**
 * Navigates a `ProtocolRuleSet` tree to the node at the given slash-delimited path.
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

/**
 * Extracts the `$tags` definition for a given protocol path.
 * Returns `never` if the path does not declare `$tags`.
 */
export type TagsAtPath<D extends ProtocolDefinition, Path extends string> =
  RuleSetAtPath<D['structure'], Path> extends infer RS
    ? RS extends ProtocolRuleSet
      ? RS['$tags'] extends ProtocolTagsDefinition
        ? RS['$tags']
        : never
      : never
    : never;

/**
 * Extracts the user-defined tag keys (excluding `$`-prefixed meta-keys)
 * from a `ProtocolTagsDefinition`.
 */
export type TagKeys<Tags extends ProtocolTagsDefinition> = Exclude<
  Extract<keyof Tags, string>,
  `$${string}`
>;

// ---------------------------------------------------------------------------
// Schema map — associates TypeScript data types with protocol type names
// ---------------------------------------------------------------------------

/**
 * A mapping from protocol type names to their TypeScript data shapes.
 *
 * Used as a type parameter to `defineProtocol()` and `TypedEnbox` so that
 * the protocol definition JSON stays JSON-compatible while TypeScript types
 * are tracked separately.
 *
 * @example
 * ```ts
 * type MySchemaMap = {
 *   profile : { displayName: string; bio?: string };
 *   avatar  : Blob;
 * };
 * ```
 */
export type SchemaMap = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Typed protocol — output of defineProtocol()
// ---------------------------------------------------------------------------

/**
 * The return type of `defineProtocol()`. Bundles the raw protocol definition
 * with its inferred path strings and schema type map for downstream use
 * by `TypedEnbox`.
 */
export type TypedProtocol<
  D extends ProtocolDefinition = ProtocolDefinition,
  M extends SchemaMap = SchemaMap,
> = {
  /** The raw DWN protocol definition (JSON-compatible). */
  readonly definition: D;

  /**
   * Phantom property carrying the schema map type. Not present at runtime;
   * used only by TypeScript to thread the generic through.
   */
  readonly _schemaMap?: M;
};
