/**
 * Factory function for creating typed module definitions.
 *
 * `defineModule()` pairs a standard {@link ModuleDefinition} with the
 * runtime codecs used by {@link TypedEnbox} for application values.
 */

import type { ModuleDefinition, ResolvedModuleGraph } from '@enbox/dwn-sdk-js';

import type { DefineModuleOptions, ModuleDependencies, ModuleDependenciesFor, ModuleDependency, ModuleRecordCodecs, TypedModule } from './module-types.js';
import type { RecordCodec, RecordCodecMap } from './record-codec.js';

import { collectModulePaths } from './module-paths.js';
import { authoredModuleDefinitionsEqual, getTypeName, ModulesConfigure, resolveModuleGraph } from '@enbox/dwn-sdk-js';

const resolvedGraphs = new WeakMap<object, ResolvedModuleGraph>();

/**
 * Creates a {@link TypedModule} from a plain DWN module definition and
 * the codecs that define each typed record's application value.
 *
 * @param options - The authored definition, exact local codecs, and direct dependency artifacts.
 * @returns A `TypedModule` containing the definition and codecs.
 *
 * @example
 * ```ts
 * const notes = defineModule({
 *   definition: NotesDefinition,
 *   codecs: {
 *     note       : recordCodecs.json<{ title: string; body: string }>(),
 *     attachment : recordCodecs.blob(),
 *   },
 * });
 *
 * // notes.definition is the authored ModuleDefinition
 * // TypedEnbox infers paths like 'note' | 'note/attachment' and
 * // data types from the codecs.
 * ```
 */
export function defineModule<
  const D extends ModuleDefinition,
  const C extends ModuleRecordCodecs<D>,
  const Deps extends ModuleDependenciesFor<D> = ModuleDependenciesFor<D>,
>(options: DefineModuleOptions<D, C, Deps>): TypedModule<D, C, Deps> {
  if (!isObjectRecord(options)) {
    throw new TypeError('defineModule: options must be an object.');
  }
  const { definition, codecs } = options;
  assertTypedModuleComponents(definition, codecs);
  const dependencies = Object.freeze({ ...options.dependencies }) as Deps;
  assertDependencyAliases(definition, dependencies);
  const snapshot = structuredClone(definition);
  const frozenCodecs = Object.freeze({ ...codecs }) as C;
  freezeDefinition(snapshot);
  const artifact = Object.freeze({
    definition : snapshot as D,
    codecs     : frozenCodecs,
    dependencies,
  });
  resolvedGraphs.set(artifact, computeTypedModuleGraph(artifact, true));
  return artifact;
}

/** @internal Whether a runtime value satisfies the module shape required by typed APIs. */
export function isTypedModule(value: unknown): value is TypedModule {
  if (!isObjectRecord(value)) {
    return false;
  }

  try {
    resolveTypedModuleGraph(value);
    return true;
  } catch {
    return false;
  }
}

/** Derive and memoize the canonical graph from the artifact's definitions and dependency bindings. */
export function resolveTypedModuleGraph(value: unknown): ResolvedModuleGraph {
  if (!isObjectRecord(value)) {
    throw new TypeError('defineModule: module artifact must be an object.');
  }
  if (Object.isFrozen(value)) {
    const cached = resolvedGraphs.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = computeTypedModuleGraph(value);
    resolvedGraphs.set(value, resolved);
    return resolved;
  }
  return computeTypedModuleGraph(value);
}

function computeTypedModuleGraph(value: globalThis.Record<string, unknown>, rootValidated = false): ResolvedModuleGraph {
  const definitions = new Map<string, ModuleDefinition>();
  const visited = new Set<object>();
  collectDependencyDefinitions(value, definitions, visited, rootValidated);
  return resolveModuleGraph(value.definition as ModuleDefinition, uri => definitions.get(uri), { requireKeyAgreement: false });
}

/** @internal Validate an application's complete artifact set and order providers before consumers. */
export function orderTypedModuleDependencies(roots: readonly ModuleDependency[]): ModuleDependency[] {
  const definitions = new Map<string, ModuleDefinition>();
  const visited = new Set<object>();
  for (const root of roots) {
    collectDependencyDefinitions(root, definitions, visited);
    resolveTypedModuleGraph(root);
  }
  const ordered: ModuleDependency[] = [];
  const complete = new Set<string>();
  const visit = (module: ModuleDependency): void => {
    if (complete.has(module.definition.module)) {
      return;
    }
    for (const dependency of Object.values(module.dependencies)) {
      visit(dependency);
    }
    complete.add(module.definition.module);
    ordered.push(module);
  };
  for (const root of roots) {
    visit(root);
  }
  return ordered;
}

function collectDependencyDefinitions(
  value: globalThis.Record<string, unknown>,
  definitions: Map<string, ModuleDefinition>,
  visited: Set<object>,
  skipValidation = false,
): void {
  if (visited.has(value)) {
    return;
  }
  visited.add(value);
  if (!skipValidation && !resolvedGraphs.has(value)) {
    assertTypedModuleComponents(value.definition, value.codecs);
    assertDependencyAliases(value.definition as ModuleDefinition, value.dependencies);
  }
  const definition = value.definition as ModuleDefinition;
  const previous = definitions.get(definition.module);
  if (previous !== undefined && !authoredModuleDefinitionsEqual(previous, definition)) {
    throw new TypeError(`defineModule: conflicting dependency definitions for module '${definition.module}'.`);
  }
  definitions.set(definition.module, definition);
  for (const dependency of Object.values(value.dependencies as ModuleDependencies)) {
    collectDependencyDefinitions(dependency, definitions, visited);
  }
}

function assertDependencyAliases(definition: ModuleDefinition, value: unknown): asserts value is ModuleDependencies {
  if (!isObjectRecord(value)) {
    throw new TypeError('defineModule: dependencies must be an object.');
  }
  const uses = definition.uses ?? {};
  const required = Object.keys(uses);
  const supplied = Object.keys(value);
  if (required.length !== supplied.length || required.some(alias => !Object.hasOwn(value, alias))) {
    throw new TypeError('defineModule: dependencies must exactly match the declared uses aliases.');
  }
  for (const alias of required) {
    const dependency = value[alias];
    if (!isObjectRecord(dependency) || !isObjectRecord(dependency.definition) || dependency.definition.module !== uses[alias]) {
      throw new TypeError(`defineModule: dependency '${alias}' must provide module '${uses[alias]}'.`);
    }
  }
}

function freezeDefinition(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeDefinition(child);
    }
    Object.freeze(value);
  }
}

/** Validate the definition shape and exact runtime codec map shared by both public entry points. */
function assertTypedModuleComponents(definition: unknown, codecs: unknown): void {
  assertModuleDefinitionShape(definition);

  if (!isObjectRecord(codecs)) {
    throw new TypeError('defineModule: codecs must be an object.');
  }

  assertModuleTypes(definition.types);
  assertModuleStructureNodes(definition.structure);
  assertModuleCodecs(definition, codecs as RecordCodecMap);
  ModulesConfigure.validateModuleDefinition(definition, { requireKeyAgreement: false });
}

function assertModuleDefinitionShape(definition: unknown): asserts definition is ModuleDefinition {
  if (!isObjectRecord(definition)
    || typeof definition.module !== 'string'
    || definition.module === ''
    || typeof definition.published !== 'boolean'
    || !isObjectRecord(definition.types)
    || !isObjectRecord(definition.structure)) {
    throw new TypeError(
      'defineModule: definition must include a non-empty module URI, boolean published flag, ' +
      'and object-valued types and structure.',
    );
  }

}

/** Validate the runtime fields consumed from every module type declaration. */
function assertModuleTypes(types: globalThis.Record<string, unknown>): void {
  for (const [typeName, type] of Object.entries(types)) {
    if (!isObjectRecord(type)
      || (type.schema !== undefined && typeof type.schema !== 'string')
      || (type.dataFormats !== undefined
        && (!Array.isArray(type.dataFormats) || type.dataFormats.some((format) => typeof format !== 'string')))
      || (type.encryptionRequired !== undefined && typeof type.encryptionRequired !== 'boolean')) {
      throw new TypeError(`defineModule: definition.types['${typeName}'] must be a valid module type object.`);
    }
  }
}

/** Every non-directive structure entry represents a record path and must be an object node. */
function assertModuleStructureNodes(
  structure: globalThis.Record<string, unknown>,
  prefix: string = '',
): void {
  for (const [key, child] of Object.entries(structure)) {
    if (key.startsWith('$')) {
      continue;
    }

    const path = prefix === '' ? key : `${prefix}/${key}`;
    if (!isObjectRecord(child)) {
      throw new TypeError(`defineModule: definition.structure['${path}'] must be an object rule-set node.`);
    }
    assertModuleStructureNodes(child, path);
  }
}

/** Enforce one valid codec for every reachable module type and no others. */
function assertModuleCodecs(definition: ModuleDefinition, codecs: RecordCodecMap): void {
  const requiredTypeNames = new Set(
    [...collectModulePaths(definition.structure)].map((path) => getTypeName(path)),
  );
  const missingTypeDefinitions = [...requiredTypeNames]
    .filter((typeName) => !Object.hasOwn(definition.types, typeName))
    .sort((a, b) => a.localeCompare(b));
  if (missingTypeDefinitions.length > 0) {
    throw new TypeError(
      `defineModule: definition.types must define every reachable module type ` +
      `(missing: ${missingTypeDefinitions.join(', ')}).`,
    );
  }

  const suppliedTypeNames = Object.keys(codecs);
  const missing = [...requiredTypeNames].filter((typeName) => !Object.hasOwn(codecs, typeName));
  const extra = suppliedTypeNames.filter((typeName) => !requiredTypeNames.has(typeName));
  const invalid = suppliedTypeNames.filter((typeName) => !isRecordCodec(codecs[typeName]));

  if (missing.length > 0 || extra.length > 0 || invalid.length > 0) {
    missing.sort((a, b) => a.localeCompare(b));
    extra.sort((a, b) => a.localeCompare(b));
    invalid.sort((a, b) => a.localeCompare(b));
    const details = [
      ...(missing.length === 0 ? [] : [`missing: ${missing.join(', ')}`]),
      ...(extra.length === 0 ? [] : [`unexpected: ${extra.join(', ')}`]),
      ...(invalid.length === 0 ? [] : [`invalid: ${invalid.join(', ')}`]),
    ];
    throw new TypeError(`defineModule: codecs must exactly match reachable module types (${details.join('; ')}).`);
  }
}

function isRecordCodec(value: unknown): value is RecordCodec<unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<RecordCodec<unknown>>;
  return typeof candidate.encode === 'function' && typeof candidate.decode === 'function';
}

function isObjectRecord(value: unknown): value is globalThis.Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
