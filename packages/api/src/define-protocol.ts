/**
 * Factory function for creating typed protocol definitions.
 *
 * `defineProtocol()` pairs a standard {@link ProtocolDefinition} with the
 * runtime codecs used by {@link TypedEnbox} for application values.
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type {
  ContextRoleGroup,
  ContextRoleGroups,
  ContextRolePath,
  ProtocolPathTypeNames,
  ProtocolRecordCodecs,
  TypedProtocol,
} from './protocol-types.js';
import type { RecordCodec, RecordCodecMap } from './record-codec.js';

import { getTypeName } from '@enbox/dwn-sdk-js';
import {
  assertTypedProtocolStructureSupported,
  collectProtocolPaths,
  isEncryptedRoleAudiencePath,
  resolveContextRoleScope,
} from './protocol-paths.js';

type ExactProtocolCodecs<
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
> = Exclude<Extract<keyof C, string>, ProtocolPathTypeNames<D>> extends never ? C : never;

type DefineProtocolOptions<D extends ProtocolDefinition> = Readonly<{
  roleGroups: ContextRoleGroups<ContextRolePath<D>> & {
    readonly default: ContextRoleGroup<ContextRolePath<D>>;
  };
}>;

type FrozenRoleGroups<G extends ContextRoleGroups> = Readonly<{
  [Name in keyof G]: Readonly<G[Name]>;
}>;

type RoleGroupsFromOptions<O> = O extends { readonly roleGroups: infer G extends ContextRoleGroups }
  ? FrozenRoleGroups<G>
  : {};

/**
 * Creates a {@link TypedProtocol} from a plain DWN protocol definition and
 * the codecs that define each typed record's application value.
 *
 * @param definition - A standard `ProtocolDefinition` object.
 * @param codecs - One runtime codec for every type reachable through the structure.
 * @param options - Application-only context role groups, ordered strongest to weakest.
 * @returns A `TypedProtocol` containing the definition, codecs, and application role groups.
 *
 * @example
 * ```ts
 * const notes = defineProtocol(NotesDefinition, {
 *   note       : recordCodecs.json<{ title: string; body: string }>(),
 *   attachment : recordCodecs.blob(),
 * });
 *
 * // notes.definition is the raw ProtocolDefinition
 * // TypedEnbox infers paths like 'note' | 'note/attachment' and
 * // data types from the codecs.
 * ```
 */
export function defineProtocol<
  const D extends ProtocolDefinition,
  const C extends ProtocolRecordCodecs<D>,
  const O extends DefineProtocolOptions<D> | undefined = undefined,
>(
  definition : D,
  codecs : ExactProtocolCodecs<D, C>,
  options?: O,
): TypedProtocol<D, C, RoleGroupsFromOptions<O>> {
  assertTypedProtocolComponents(definition, codecs);
  const roleGroups = prepareRoleGroups(
    definition,
    options === undefined ? {} : options.roleGroups,
  ) as RoleGroupsFromOptions<O>;

  return { definition, codecs, roleGroups };
}

/** @internal Whether a runtime value satisfies the protocol shape required by typed APIs. */
export function isTypedProtocol(value: unknown): value is TypedProtocol {
  if (!isObjectRecord(value)) {
    return false;
  }

  try {
    assertTypedProtocolComponents(value.definition, value.codecs);
    prepareRoleGroups(value.definition as ProtocolDefinition, value.roleGroups);
    return true;
  } catch {
    return false;
  }
}

/** Validate and freeze application role precedence without changing the DWN definition. */
function prepareRoleGroups(
  definition: ProtocolDefinition,
  value: unknown,
): ContextRoleGroups {
  if (!isObjectRecord(value)) {
    throw new TypeError('defineProtocol: roleGroups must be an object.');
  }
  const groups = Object.entries(value);
  if (groups.length > 0 && !Object.hasOwn(value, 'default')) {
    throw new TypeError('defineProtocol: roleGroups must declare a \'default\' group.');
  }

  const prepared = groups.map(([name, candidate]): [string, readonly [string, ...string[]]] => {
    if (name.length === 0) {
      throw new TypeError('defineProtocol: role group names must be non-empty.');
    }
    if (!Array.isArray(candidate) || candidate.length === 0 || candidate.some(role => typeof role !== 'string')) {
      throw new TypeError(`defineProtocol: roleGroups['${name}'] must contain at least one role path.`);
    }
    const roles = candidate as string[];
    if (new Set(roles).size !== roles.length) {
      throw new TypeError(`defineProtocol: roleGroups['${name}'] must not contain duplicate roles.`);
    }

    let contextPath: string | undefined;
    for (const role of roles) {
      if (!isEncryptedRoleAudiencePath(definition, role)) {
        throw new TypeError(`defineProtocol: roleGroups['${name}'] role '${role}' is not an encrypted audience.`);
      }
      const scope = resolveContextRoleScope(definition, role);
      contextPath ??= scope.protocolPath;
      if (scope.protocolPath !== contextPath) {
        throw new TypeError(`defineProtocol: roleGroups['${name}'] roles must share one context root.`);
      }
    }

    return [name, Object.freeze([...roles]) as readonly [string, ...string[]]];
  });
  return Object.freeze(Object.fromEntries(prepared)) as ContextRoleGroups;
}

/** Validate the definition shape and exact runtime codec map shared by both public entry points. */
function assertTypedProtocolComponents(definition: unknown, codecs: unknown): void {
  if (!isObjectRecord(definition)
    || typeof definition.protocol !== 'string'
    || definition.protocol === ''
    || typeof definition.published !== 'boolean'
    || !isObjectRecord(definition.types)
    || !isObjectRecord(definition.structure)) {
    throw new TypeError(
      'defineProtocol: definition must include a non-empty protocol URI, boolean published flag, ' +
      'and object-valued types and structure.',
    );
  }

  if (!isObjectRecord(codecs)) {
    throw new TypeError('defineProtocol: codecs must be an object.');
  }

  assertProtocolTypes(definition.types);
  assertProtocolStructureNodes(definition.structure);
  assertProtocolCodecs(definition as ProtocolDefinition, codecs as RecordCodecMap);
}

/** Validate the runtime fields consumed from every protocol type declaration. */
function assertProtocolTypes(types: globalThis.Record<string, unknown>): void {
  for (const [typeName, type] of Object.entries(types)) {
    if (!isObjectRecord(type)
      || (type.schema !== undefined && typeof type.schema !== 'string')
      || (type.dataFormats !== undefined
        && (!Array.isArray(type.dataFormats) || type.dataFormats.some((format) => typeof format !== 'string')))
      || (type.encryptionRequired !== undefined && typeof type.encryptionRequired !== 'boolean')) {
      throw new TypeError(`defineProtocol: definition.types['${typeName}'] must be a valid protocol type object.`);
    }
  }
}

/** Every non-directive structure entry represents a record path and must be an object node. */
function assertProtocolStructureNodes(
  structure: globalThis.Record<string, unknown>,
  prefix: string = '',
): void {
  for (const [key, child] of Object.entries(structure)) {
    if (key.startsWith('$')) {
      continue;
    }

    const path = prefix === '' ? key : `${prefix}/${key}`;
    if (!isObjectRecord(child)) {
      throw new TypeError(`defineProtocol: definition.structure['${path}'] must be an object rule-set node.`);
    }
    assertProtocolStructureNodes(child, path);
  }
}

/** Enforce one valid codec for every reachable protocol type and no others. */
function assertProtocolCodecs(definition: ProtocolDefinition, codecs: RecordCodecMap): void {
  assertTypedProtocolStructureSupported(definition.structure);
  const requiredTypeNames = new Set(
    [...collectProtocolPaths(definition.structure)].map((path) => getTypeName(path)),
  );
  const missingTypeDefinitions = [...requiredTypeNames]
    .filter((typeName) => !Object.hasOwn(definition.types, typeName))
    .sort((a, b) => a.localeCompare(b));
  if (missingTypeDefinitions.length > 0) {
    throw new TypeError(
      `defineProtocol: definition.types must define every reachable protocol type ` +
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
    throw new TypeError(`defineProtocol: codecs must exactly match reachable protocol types (${details.join('; ')}).`);
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
