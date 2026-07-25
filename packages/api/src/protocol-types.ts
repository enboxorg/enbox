/**
 * Type-level utilities for extracting typed paths, type names, data formats,
 * and tag shapes from a {@link ProtocolDefinition}.
 *
 * These types are purely compile-time — they produce no runtime code.
 */

import type { ProtocolDefinition, ProtocolRuleSet, ProtocolTagsDefinition, ProtocolType } from '@enbox/dwn-sdk-js';
import type { RecordCodec, RecordCodecMap } from './record-codec.js';

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
 * // 'thread' | 'thread/message' | 'project' | 'project/task'
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
// Data-format lookup
// ---------------------------------------------------------------------------

/**
 * Looks up the `dataFormats` array for a given type name in the protocol definition.
 * Returns `undefined` if the type does not declare dataFormats.
 */
type DataFormatsForType<D extends ProtocolDefinition, TypeName extends string> =
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
// Rule-set lookup
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

// ---------------------------------------------------------------------------
// Role extraction
// ---------------------------------------------------------------------------

/** Protocol paths whose literal rule declares `$role: true`. */
export type ProtocolRolePaths<D extends ProtocolDefinition> = {
  [Path in ProtocolPaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $role: true;
  }
    ? Path
    : never;
}[ProtocolPaths<D>];

// ---------------------------------------------------------------------------
// Singleton extraction
// ---------------------------------------------------------------------------

/** Protocol paths whose literal rule declares `$recordLimit.max: 1`. */
export type SingletonProtocolPaths<D extends ProtocolDefinition> = {
  [Path in ProtocolPaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $recordLimit: { readonly max: 1 };
  }
    ? Path
    : never;
}[ProtocolPaths<D>];

/**
 * Exact direct-child paths below `Parent` whose literal rule declares
 * `$recordLimit.max: 1`.
 *
 * Descendants deeper than one edge and children with any other limit are
 * excluded. Definitions widened to the generic `ProtocolDefinition` cannot
 * prove a singleton constraint; keep protocol definitions as const literals.
 */
export type DirectSingletonChildPaths<
  D extends ProtocolDefinition,
  Parent extends ProtocolPaths<D>,
> = RuleSetAtPath<D['structure'], Parent> extends infer ParentRuleSet
  ? ParentRuleSet extends ProtocolRuleSet
    ? {
      [Child in Extract<keyof ParentRuleSet, string>]: Child extends `$${string}`
        ? never
        : ParentRuleSet[Child] extends {
          readonly $recordLimit: { readonly max: 1 };
        }
          ? `${Parent}/${Child}`
          : never;
    }[Extract<keyof ParentRuleSet, string>]
    : never
  : never;

// ---------------------------------------------------------------------------
// Tag extraction helpers
// ---------------------------------------------------------------------------

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

/** Every protocol type name reachable through the protocol structure. */
export type ProtocolPathTypeNames<D extends ProtocolDefinition> = TypeNameAtPath<ProtocolPaths<D>>;

/** Runtime codecs required to use every typed record path in a protocol. */
export type ProtocolRecordCodecs<D extends ProtocolDefinition> = {
  [K in ProtocolPathTypeNames<D>]: RecordCodec<unknown>;
};

// ---------------------------------------------------------------------------
// Typed protocol — output of defineProtocol()
// ---------------------------------------------------------------------------

/**
 * The return type of `defineProtocol()`. Bundles the raw protocol definition
 * with the runtime codecs that also carry its application value types.
 */
export type TypedProtocol<
  D extends ProtocolDefinition = ProtocolDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> = {
  /** The raw DWN protocol definition (JSON-compatible). */
  readonly definition: D;

  /** Application codecs keyed by protocol type name. */
  readonly codecs: C;
};
