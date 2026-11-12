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
export type RuleSetPaths<R, Prefix extends string = ''> = string extends keyof R ? string : {
  [K in Extract<keyof R, string>]: K extends `$${string}`
    ? never
    : R[K] extends ModuleRuleSet
      ? (R[K] extends { readonly $ref: string } ? never : `${Prefix}${K}`) | RuleSetPaths<R[K], `${Prefix}${K}/`>
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

/** All declared structure paths, including `$ref` attachment nodes (which are excluded from writable record paths). */
type DeclaredPaths<R, Prefix extends string = ''> = string extends keyof R ? string : {
  [K in Extract<keyof R, string>]: K extends `$${string}` ? never
    : R[K] extends ModuleRuleSet ? `${Prefix}${K}` | DeclaredPaths<R[K], `${Prefix}${K}/`> : never;
}[Extract<keyof R, string>];

// ---------------------------------------------------------------------------
// Attachment resolution
// ---------------------------------------------------------------------------

type AttachmentTarget = { module: string; path: string };

/** Follow `$ref` links across `dependencies` to resolve the underlying owning module URI and record path. */
type ResolveAttachmentTarget<
  M extends ModuleDependency,
  Path extends string,
  Seen extends string = never,
> = string extends keyof M['definition']['structure'] ? AttachmentTarget
  : string extends Path ? AttachmentTarget
    : M['definition']['module'] extends Seen ? never
      : RuleSetAtPath<M['definition']['structure'], Path> extends infer Node
        ? [Node] extends [never] ? never
          : Node extends { readonly $ref: infer Reference extends string }
            ? string extends Reference ? AttachmentTarget
              : Reference extends `${infer Alias}:${infer Target}`
                ? Alias extends keyof M['dependencies']
                  ? ResolveAttachmentTarget<M['dependencies'][Alias], Target,
                    Seen | (string extends M['definition']['module'] ? never : M['definition']['module'])>
                  : never
                : never
            : { module: M['definition']['module']; path: Path }
        : never;

/** True when `Target` can match `(ModuleUri, ModulePath)` (allowing widened `string` types while rejecting mismatched string literals). */
type MatchesAttachmentTarget<Target, ModuleUri extends string, ModulePath extends string> =
  Target extends AttachmentTarget
    ? [Target['module'] & ModuleUri] extends [never] ? false
      : [Target['path'] & ModulePath] extends [never] ? false : true
    : false;

/** Resolve the owning `(module, path)` target plus all physical ancestor `(module, path)` steps for `Path` in `M`. */
type ResolveAttachmentLineage<
  M extends ModuleDependency,
  Path extends string,
  Seen extends string = never,
> = string extends keyof M['definition']['structure'] ? AttachmentTarget
  : string extends Path ? AttachmentTarget
    : M['definition']['module'] extends Seen ? never
      : RuleSetAtPath<M['definition']['structure'], Path> extends infer Node
        ? [Node] extends [never] ? never
          : Node extends { readonly $ref: infer Reference extends string }
            ? string extends Reference ? AttachmentTarget
              : Reference extends `${infer Alias}:${infer Target}`
                ? Alias extends keyof M['dependencies']
                  ? ResolveAttachmentLineage<M['dependencies'][Alias], Target,
                    Seen | (string extends M['definition']['module'] ? never : M['definition']['module'])>
                  : never
                : never
            : { module: M['definition']['module']; path: Path } | (
              Path extends `${infer Parent}/${string}`
                ? ResolveAttachmentLineage<M, Parent, Seen>
                : never
            )
        : never;

type IsStringUnion<Value extends string, Whole extends string = Value> =
  Value extends unknown ? ([Whole] extends [Value] ? false : true) : false;

type SingleAttachmentPath<Paths extends string> =
  string extends Paths ? string
    : [Paths] extends [never] ? never
      : IsStringUnion<Paths> extends true ? never : Paths;

/**
 * Local `$ref` attachment paths in `M` that resolve to `(OwningModuleUri, OwningModulePath)`.
 * References may chain through typed dependencies, but do not import undeclared provider children.
 * A definition widened to the generic `ModuleDefinition` retains a runtime-checked `string` path.
 */
export type ModuleAttachmentPaths<
  M extends TypedModule,
  OwningModuleUri extends string,
  OwningModulePath extends string,
> = string extends keyof M['definition']['structure'] ? string : {
  [Path in DeclaredPaths<M['definition']['structure']>]:
    RuleSetAtPath<M['definition']['structure'], Path> extends { readonly $ref: string }
      ? true extends MatchesAttachmentTarget<ResolveAttachmentTarget<M, Path>, OwningModuleUri, OwningModulePath>
        ? Path : never
      : never;
}[DeclaredPaths<M['definition']['structure']>];

/**
 * Unique top-level `$ref` attachment path in `M` that attaches directly to or
 * beneath the context root `(OwningModuleUri, OwningContextRootPath)`.
 * Collapses to `never` when `M` declares zero or multiple top-level `$ref`s
 * under the same context root, matching `resolveModuleContextRoot` at runtime.
 */
export type ModuleContextAttachmentPath<
  M extends TypedModule,
  OwningModuleUri extends string,
  OwningContextRootPath extends string,
> = string extends keyof M['definition']['structure'] ? string : SingleAttachmentPath<{
  [Key in Extract<keyof M['definition']['structure'], string>]:
    Key extends `$${string}` ? never
      : M['definition']['structure'][Key] extends { readonly $ref: string }
        ? true extends MatchesAttachmentTarget<ResolveAttachmentLineage<M, Key>, OwningModuleUri, OwningContextRootPath>
          ? Key : never
        : never;
}[Extract<keyof M['definition']['structure'], string>]>;

// ---------------------------------------------------------------------------
// Role extraction
// ---------------------------------------------------------------------------

type ResolvedRoleAtPath<
  D extends ModuleDefinition,
  Deps extends ModuleDependencies,
  Path extends string,
  Seen extends string = never,
> = D['module'] extends Seen ? false
  : RuleSetAtPath<D['structure'], Path> extends infer Node
    ? Node extends { readonly $role: true } ? true
      : Node extends { readonly $ref: `${infer Alias}:${infer Target}` }
        ? Alias extends keyof Deps
          ? ResolvedRoleAtPath<Deps[Alias]['definition'], Deps[Alias]['dependencies'], Target,
            Seen | (string extends D['module'] ? never : D['module'])>
          : false
        : false
    : false;

type DeclaredRolePaths<D extends ModuleDefinition, Deps extends ModuleDependencies> =
  string extends keyof D['structure'] ? never : {
    [Path in DeclaredPaths<D['structure']>]: ResolvedRoleAtPath<D, Deps, Path> extends true ? Path : never;
  }[DeclaredPaths<D['structure']>];

/** Local role paths and explicitly qualified role paths exposed by dependencies. */
export type ModuleRolePaths<
  D extends ModuleDefinition,
  Deps extends ModuleDependencies = ModuleDependenciesFor<D>,
> = DeclaredRolePaths<D, Deps> | {
  [Alias in Extract<keyof Deps, string>]: `${Alias}:${DeclaredRolePaths<Deps[Alias]['definition'], Deps[Alias]['dependencies']>}`;
}[Extract<keyof Deps, string>];

/** Module paths whose literal rule declares `$squash: true`. */
export type SquashModulePaths<D extends ModuleDefinition> = {
  [Path in ModulePaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $squash: true;
  }
    ? Path
    : never;
}[ModulePaths<D>];

type ReadActionRole<Action> = Action extends {
  readonly role: infer Role extends string;
  readonly can: readonly string[];
} ? Extract<Action['can'][number], 'read'> extends never ? never : Role : never;

type DirectRolePaths<RuleSet, Root extends string> = {
  [Child in Extract<keyof RuleSet, string>]: Child extends `$${string}`
    ? never
    : RuleSet[Child] extends { readonly $role: true } ? `${Root}/${Child}` : never;
}[Extract<keyof RuleSet, string>];

type IsLocallyRooted<D extends ModuleDefinition, Path extends string> =
  Path extends `${infer Head}/${string}`
    ? D['structure'][Head] extends { readonly $ref: string } ? false : true
    : D['structure'][Path] extends { readonly $ref: string } ? false : true;

/** Contextual roles directly below a root whose actions grant them read access. */
export type ContextRolesAtPath<
  D extends ModuleDefinition,
  Root extends ModulePaths<D> & string,
> = Root extends unknown
  ? IsLocallyRooted<D, Root> extends false ? never
    : RuleSetAtPath<D['structure'], Root> extends infer RuleSet
      ? RuleSet extends { readonly $role: true } ? never
        : RuleSet extends { readonly $actions: readonly (infer Action)[] }
          ? Extract<ReadActionRole<Action>, DirectRolePaths<RuleSet, Root>>
          : never
      : never
  : never;

/** Context roots with at least one direct role granted read access. */
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

/** Runtime metadata retained for one dependency; no codecs are transmitted to a DWN. */
export type ModuleDependency = {
  readonly definition: ModuleDefinition;
  readonly codecs: RecordCodecMap;
  readonly dependencies: ModuleDependencies;
};

/** Aliases are lexical to the module that declares them. */
export type ModuleDependencies = Readonly<Record<string, ModuleDependency>>;

/** Every declared `uses` alias must supply an artifact with its exact module URI. */
export type ModuleDependenciesFor<D extends ModuleDefinition> = {
  readonly [Alias in Extract<keyof NonNullable<D['uses']>, string>]: ModuleDependency & {
    readonly definition: ModuleDefinition & { readonly module: NonNullable<D['uses']>[Alias] };
  };
};

export type ExactModuleCodecs<D extends ModuleDefinition, C extends RecordCodecMap> =
  Exclude<Extract<keyof C, string>, ModulePathTypeNames<D>> extends never ? C : never;

export type ExactModuleDependencies<D extends ModuleDefinition, Deps extends ModuleDependencies> =
  Exclude<Extract<keyof Deps, string>, keyof NonNullable<D['uses']>> extends never ? Deps : never;

/** Inputs for one typed module, with an exact dependency map when `uses` is declared. */
export type DefineModuleOptions<
  D extends ModuleDefinition,
  C extends ModuleRecordCodecs<D>,
  Deps extends ModuleDependenciesFor<D> = ModuleDependenciesFor<D>,
> = {
  readonly definition: D;
  readonly codecs: ExactModuleCodecs<D, C>;
} & (keyof NonNullable<D['uses']> extends never
  ? { readonly dependencies?: Record<string, never> }
  : { readonly dependencies: ExactModuleDependencies<D, Deps> });

/**
 * The return type of `defineModule()`. Bundles the raw module definition
 * with runtime codecs.
 */
export type TypedModule<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Deps extends ModuleDependencies = ModuleDependencies,
> = {
  /** The authored DWN module definition. */
  readonly definition: D;

  /** Application codecs keyed by module type name. */
  readonly codecs: C;

  /** Complete typed artifacts for exactly the module's own `uses` aliases. */
  readonly dependencies: Deps;

};
