/**
 * Type-level utilities for extracting typed paths, type names, data formats,
 * and tag shapes from a {@link ModuleDefinition}.
 *
 * These types are purely compile-time — they produce no runtime code.
 */

import type { ModuleDefinition, ModuleRuleSet, ModuleTagsDefinition, ModuleType } from '@enbox/dwn-sdk-js';
import type { RecordCodec, RecordCodecMap } from './record-codec.js';

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/**
 * Recursively extracts all valid module path strings from a `ModuleRuleSet`.
 *
 * Given a structure like `{ foo: { bar: { ... } } }`, this produces
 * `'foo' | 'foo/bar'`.  Directive keys (starting with `$`) are excluded.
 */
export type RuleSetPaths<R, Prefix extends string = ''> = {
  [K in Extract<keyof R, string>]: K extends `$${string}`
    ? never
    : R[K] extends ModuleRuleSet
      ? `${Prefix}${K}` | RuleSetPaths<R[K], `${Prefix}${K}/`>
      : never;
}[Extract<keyof R, string>];

/**
 * All valid module path strings for a given `ModuleDefinition`.
 *
 * @example
 * ```ts
 * type Paths = ModulePaths<typeof myDef>;
 * // 'thread' | 'thread/message' | 'project' | 'project/task'
 * ```
 */
export type ModulePaths<D extends ModuleDefinition> = RuleSetPaths<D['structure']>;

// ---------------------------------------------------------------------------
// Type-name extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the last segment (type name) from a module path string.
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
 * Looks up the `dataFormats` array for a given type name in the module definition.
 * Returns `undefined` if the type does not declare dataFormats.
 */
type DataFormatsForType<D extends ModuleDefinition, TypeName extends string> =
  TypeName extends keyof D['types']
    ? D['types'][TypeName] extends ModuleType
      ? D['types'][TypeName]['dataFormats']
      : undefined
    : undefined;

/**
 * Resolves the `dataFormat` string literal union for a module path.
 * Module types without a declared `dataFormats` list retain the raw
 * string escape hatch.
 */
export type DataFormatAtPath<
  D extends ModuleDefinition,
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
 * Navigates a `ModuleRuleSet` tree to the node at the given slash-delimited path.
 */
type RuleSetAtPath<R, Path extends string> =
  Path extends `${infer Head}/${infer Tail}`
    ? Head extends keyof R
      ? R[Head] extends ModuleRuleSet
        ? RuleSetAtPath<R[Head], Tail>
        : never
      : never
    : Path extends keyof R
      ? R[Path] extends ModuleRuleSet
        ? R[Path]
        : never
      : never;

// ---------------------------------------------------------------------------
// Role extraction
// ---------------------------------------------------------------------------

/** Module paths whose literal rule declares `$role: true`. */
export type ModuleRolePaths<D extends ModuleDefinition> = {
  [Path in ModulePaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $role: true;
  }
    ? Path
    : never;
}[ModulePaths<D>];

/** Module paths whose literal rule declares `$squash: true`. */
export type SquashModulePaths<D extends ModuleDefinition> = {
  [Path in ModulePaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $squash: true;
  }
    ? Path
    : never;
}[ModulePaths<D>];

type EncryptedTypeNames<D extends ModuleDefinition> = {
  [Name in keyof D['types']]: D['types'][Name] extends { readonly encryptionRequired: true } ? Name : never;
}[keyof D['types']];

type ReadActionRole<Action> = Action extends {
  readonly role: infer Role extends string;
  readonly can: readonly string[];
} ? Extract<Action['can'][number], 'read'> extends never ? never : Role : never;

type DirectRolePaths<RuleSet, Root extends string> = {
  [Child in Extract<keyof RuleSet, string>]: Child extends `$${string}`
    ? never
    : RuleSet[Child] extends { readonly $role: true } ? `${Root}/${Child}` : never;
}[Extract<keyof RuleSet, string>];

/** Encrypted audience roles directly below a root whose actions grant them read access. */
export type ContextRolesAtPath<
  D extends ModuleDefinition,
  Root extends ModulePaths<D> & string,
> = Root extends unknown
  ? EncryptedTypeNames<D> extends never ? never
    : RuleSetAtPath<D['structure'], Root> extends infer RuleSet
      ? RuleSet extends { readonly $role: true } ? never
        : RuleSet extends { readonly $actions: readonly (infer Action)[] }
          ? Extract<ReadActionRole<Action>, DirectRolePaths<RuleSet, Root>>
          : never
      : never
  : never;

/** Context roots with at least one direct encrypted audience role granted read access. */
export type ContextRootPath<D extends ModuleDefinition> = {
  [Path in ModulePaths<D> & string]: [ContextRolesAtPath<D, Path>] extends [never] ? never : Path;
}[ModulePaths<D> & string];

/** Every role eligible for following through its directly containing context. */
export type ContextRolePath<D extends ModuleDefinition> = {
  [Path in ModulePaths<D> & string]: ContextRolesAtPath<D, Path>;
}[ModulePaths<D> & string];

// ---------------------------------------------------------------------------
// Singleton extraction
// ---------------------------------------------------------------------------

/** Module paths whose literal rule declares `$recordLimit.max: 1`. */
export type SingletonModulePaths<D extends ModuleDefinition> = {
  [Path in ModulePaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $recordLimit: { readonly max: 1 };
  }
    ? Path
    : never;
}[ModulePaths<D>];

/**
 * Exact direct-child paths below `Parent` whose literal rule declares
 * `$recordLimit.max: 1`.
 *
 * Descendants deeper than one edge and children with any other limit are
 * excluded. Definitions widened to the generic `ModuleDefinition` cannot
 * prove a singleton constraint; keep module definitions as const literals.
 */
export type DirectSingletonChildPaths<
  D extends ModuleDefinition,
  Parent extends ModulePaths<D>,
> = RuleSetAtPath<D['structure'], Parent> extends infer ParentRuleSet
  ? ParentRuleSet extends ModuleRuleSet
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
 * Extracts the `$tags` definition for a given module path.
 * Returns `never` if the path does not declare `$tags`.
 */
export type TagsAtPath<D extends ModuleDefinition, Path extends string> =
  RuleSetAtPath<D['structure'], Path> extends infer RS
    ? RS extends ModuleRuleSet
      ? RS['$tags'] extends ModuleTagsDefinition
        ? RS['$tags']
        : never
      : never
    : never;

/**
 * Extracts the user-defined tag keys (excluding `$`-prefixed meta-keys)
 * from a `ModuleTagsDefinition`.
 */
export type TagKeys<Tags extends ModuleTagsDefinition> = Exclude<
  Extract<keyof Tags, string>,
  `$${string}`
>;

/** Every module type name reachable through the module structure. */
export type ModulePathTypeNames<D extends ModuleDefinition> = TypeNameAtPath<ModulePaths<D>>;

/** Runtime codecs required to use every typed record path in a module. */
export type ModuleRecordCodecs<D extends ModuleDefinition> = {
  [K in ModulePathTypeNames<D>]: RecordCodec<unknown>;
};

// ---------------------------------------------------------------------------
// Typed module — output of defineModule()
// ---------------------------------------------------------------------------

/**
 * The return type of `defineModule()`. Bundles the raw module definition
 * with runtime codecs.
 */
export type TypedModule<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> = {
  /** The effective DWN module definition, including Enbox-managed module paths. */
  readonly definition: D;

  /** Application codecs keyed by module type name. */
  readonly codecs: C;
};
