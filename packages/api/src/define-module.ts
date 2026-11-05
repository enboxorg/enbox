/**
 * Factory function for creating typed module definitions.
 *
 * `defineModule()` pairs a standard {@link ModuleDefinition} with the
 * runtime codecs used by {@link TypedEnbox} for application values.
 */

import type { ModuleDefinition } from '@enbox/dwn-sdk-js';

import type { ModulePathTypeNames, ModuleRecordCodecs, TypedModule } from './module-types.js';
import type { RecordCodec, RecordCodecMap } from './record-codec.js';

import { getTypeName } from '@enbox/dwn-sdk-js';
import {
  addSharedContextModule,
  assertSharedContextNamesAvailable,
  hasSharedContextModule,
} from './shared-context-module.js';
import {
  assertTypedModuleStructureSupported,
  collectModulePaths,
  isEncryptedRoleAudiencePath,
} from './module-paths.js';

type ExactModuleCodecs<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
> = Exclude<Extract<keyof C, string>, ModulePathTypeNames<D>> extends never ? C : never;

/**
 * Creates a {@link TypedModule} from a plain DWN module definition and
 * the codecs that define each typed record's application value.
 *
 * @param definition - A standard `ModuleDefinition` object.
 * @param codecs - One runtime codec for every type reachable through the structure.
 * @returns A `TypedModule` containing the definition and codecs.
 *
 * @example
 * ```ts
 * const notes = defineModule(NotesDefinition, {
 *   note       : recordCodecs.json<{ title: string; body: string }>(),
 *   attachment : recordCodecs.blob(),
 * });
 *
 * // notes.definition is the effective ModuleDefinition
 * // TypedEnbox infers paths like 'note' | 'note/attachment' and
 * // data types from the codecs.
 * ```
 */
export function defineModule<
  const D extends ModuleDefinition,
  const C extends ModuleRecordCodecs<D>,
>(
  definition : D,
  codecs : ExactModuleCodecs<D, C>,
): TypedModule<D, C> {
  assertSharedContextNamesAvailable(definition);
  assertTypedModuleComponents(definition, codecs);
  if (!hasEncryptedRoleAudience(definition)) {
    return { definition, codecs };
  }

  const augmented = addSharedContextModule(definition, codecs);
  return {
    definition : augmented.definition as D,
    codecs     : augmented.codecs as C,
  };
}

/** @internal Whether a runtime value satisfies the module shape required by typed APIs. */
export function isTypedModule(value: unknown): value is TypedModule {
  if (!isObjectRecord(value)) {
    return false;
  }

  try {
    assertTypedModuleComponents(value.definition, value.codecs);
    if (hasEncryptedRoleAudience(value.definition as ModuleDefinition)) {
      return hasSharedContextModule(
        value.definition as ModuleDefinition,
        value.codecs as RecordCodecMap,
      );
    }
    assertSharedContextNamesAvailable(value.definition as ModuleDefinition);
    return true;
  } catch {
    return false;
  }
}

/** Whether module semantics require the deterministic managed shared-context paths. */
function hasEncryptedRoleAudience(definition: ModuleDefinition): boolean {
  return [...collectModulePaths(definition.structure)]
    .some(modulePath => isEncryptedRoleAudiencePath(definition, modulePath));
}

/** Validate the definition shape and exact runtime codec map shared by both public entry points. */
function assertTypedModuleComponents(definition: unknown, codecs: unknown): void {
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

  if (!isObjectRecord(codecs)) {
    throw new TypeError('defineModule: codecs must be an object.');
  }

  assertModuleTypes(definition.types);
  assertModuleStructureNodes(definition.structure);
  assertModuleCodecs(definition as ModuleDefinition, codecs as RecordCodecMap);
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
  assertTypedModuleStructureSupported(definition.structure);
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
