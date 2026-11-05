/**
 * Typed application module registration and auth-request projection.
 *
 * An application manifest keeps each {@link TypedModule} together with the
 * permission policy used for delegated connect. Runtime codecs remain on the
 * application side; {@link getApplicationModuleRequests} projects only raw
 * definitions and permissions across the auth/connect boundary.
 */

import type { TypedModule } from './module-types.js';
import type { ModuleRequest, Permission } from '@enbox/auth';

import { authoredModuleDefinitionsEqual } from '@enbox/dwn-sdk-js';
import { isTypedModule } from './define-module.js';
import { normalizePermissionPolicy } from '@enbox/auth';

/** One typed module registered by an application. */
export type ApplicationManifestModule<Module extends TypedModule = TypedModule> = {
  /** Typed module retained for application APIs and future readiness checks. */
  readonly module: Module;

  /** Normalized delegated permissions requested for this module. */
  readonly permissions: readonly Permission[];
};

type ApplicationManifestModuleRegistration<Module extends TypedModule = TypedModule> = {
  readonly module: Module;
  readonly permissions?: readonly Permission[];
};

/** A direct typed-module shorthand or an entry with explicit permissions. */
export type ApplicationManifestModuleInput<Module extends TypedModule = TypedModule> =
  | Module
  | ApplicationManifestModuleRegistration<Module>;

/** A stable application-owned registry of typed modules. */
export type ApplicationManifest<
  Modules extends readonly ApplicationManifestModule[] = readonly ApplicationManifestModule[],
> = {
  /** Normalized typed module registrations, in declaration order. */
  readonly modules: Modules;
};

type TypedModuleFromInput<Input> =
  Input extends TypedModule
    ? Input
    : Input extends ApplicationManifestModuleRegistration<infer Module>
      ? Module
      : never;

type NormalizedManifestModules<Inputs extends readonly ApplicationManifestModuleInput[]> = {
  readonly [Index in keyof Inputs]: ApplicationManifestModule<TypedModuleFromInput<Inputs[Index]>>;
};

/** Options accepted by {@link defineApplicationManifest}. */
export type DefineApplicationManifestOptions<
  Inputs extends readonly ApplicationManifestModuleInput[] = readonly ApplicationManifestModuleInput[],
> = {
  readonly modules: Inputs;
};

/**
 * Registers the typed modules and delegated permission policies for one
 * application.
 *
 * Direct `TypedModule` entries use auth's default permissions. Wrap a typed
 * module in `{ module, permissions }` for an explicit policy. Module URIs
 * must be unique; duplicate and conflicting definitions are rejected instead
 * of silently merging permission policies.
 *
 * The returned manifest freezes only its copied containers. Caller-owned typed
 * modules, definitions, and codecs are retained by reference and are not
 * frozen or otherwise mutated.
 *
 * @example
 * ```ts
 * const application = defineApplicationManifest({
 *   modules: [
 *     NotesModule,
 *     { module: PhotosModule, permissions: ['read'] },
 *   ],
 * } as const);
 * ```
 */
export function defineApplicationManifest<
  const Inputs extends readonly ApplicationManifestModuleInput[],
>(
  options: DefineApplicationManifestOptions<Inputs>,
): ApplicationManifest<NormalizedManifestModules<Inputs>> {
  const normalized: ApplicationManifestModule[] = [];
  const seen = new Map<string, { index: number; module: TypedModule }>();

  for (const [index, input] of options.modules.entries()) {
    const registration = isApplicationManifestModule(input) ? input : undefined;
    const module = registration?.module ?? input;
    if (!isTypedModule(module)) {
      throw new TypeError(`defineApplicationManifest: modules[${index}] must be a TypedModule.`);
    }

    const moduleUri = module.definition.module;
    const previous = seen.get(moduleUri);
    if (previous !== undefined) {
      const duplicate = authoredModuleDefinitionsEqual(previous.module.definition, module.definition);
      const reason = duplicate ? 'duplicate module URI' : 'conflicting definitions for module URI';
      throw new TypeError(
        `defineApplicationManifest: ${reason} '${moduleUri}' at indexes ${previous.index} and ${index}.`,
      );
    }
    seen.set(moduleUri, { index, module });

    const permissions = Object.freeze(normalizePermissionPolicy(
      registration?.permissions,
      `defineApplicationManifest: modules[${index}].permissions`,
    ));
    normalized.push(Object.freeze({ permissions, module }));
  }

  return Object.freeze({
    modules: Object.freeze(normalized),
  }) as ApplicationManifest<NormalizedManifestModules<Inputs>>;
}

/**
 * Projects a typed application manifest into dependency-neutral auth module
 * requests for a delegated connect or refresh call.
 *
 * The returned array and permission arrays are fresh mutable copies.
 * Runtime codecs are never included. Owner/vault callers should not pass these
 * requests to `connect()` because a non-empty module list intentionally
 * selects auth's delegated-handler route.
 */
export function getApplicationModuleRequests(
  application: ApplicationManifest,
): ModuleRequest[] {
  return application.modules.map(({ permissions, module }) => ({
    definition  : module.definition,
    permissions : [...permissions],
  }));
}

/** Whether an input uses the explicit application-manifest entry shape. */
function isApplicationManifestModule(
  input: ApplicationManifestModuleInput,
): input is ApplicationManifestModuleRegistration {
  return Object.hasOwn(input, 'module');
}
