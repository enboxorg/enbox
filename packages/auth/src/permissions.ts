/**
 * Permission request normalization utilities.
 *
 * Converts simplified `ModuleRequest` entries (raw definitions, structural
 * definition carriers, or explicit permission policies) into agent-level
 * `ConnectPermissionRequest` objects used by connect handlers.
 *
 * @module
 * @internal
 */

import type { ConnectPermissionRequest } from '@enbox/connect';
import type { DwnModuleDefinition } from '@enbox/agent';

import type {
  ModuleDefinitionCarrier,
  ModulePermissionRequest,
  ModuleRequest,
  Permission,
} from './types.js';

import { DEFAULT_PERMISSIONS } from './types.js';
import { WalletConnect } from './wallet-connect-client.js';

/**
 * Normalize simplified `ModuleRequest[]` into agent-level
 * `ConnectPermissionRequest[]`.
 */
export function normalizeModuleRequests(
  modules: readonly ModuleRequest[] | undefined,
): ConnectPermissionRequest[] {
  if (!modules || modules.length === 0) { return []; }

  const normalized = modules.map((entry, index) => {
    if (isObjectRecord(entry) && Object.hasOwn(entry, 'protocol')) {
      throw new TypeError(`normalizeModuleRequests: modules[${index}] uses the removed protocol field.`);
    }
    const explicit = isModulePermissionRequest(entry);
    const source = explicit
      ? getExplicitModuleSource(entry)
      : entry;
    const definition = getModuleDefinition(source, index);
    const permissions = normalizePermissionPolicy(
      explicit ? entry.permissions : undefined,
      `normalizeModuleRequests: modules[${index}].permissions`,
    );

    return { definition, permissions };
  });

  assertUniqueModuleUris(normalized);

  return normalized.map(({ definition, permissions }) => {
    return WalletConnect.createPermissionRequestForModule({
      definition,
      permissions,
    });
  });
}

type NormalizedModuleRequest = {
  definition: DwnModuleDefinition;
  permissions: Permission[];
};

/** Reject duplicate requests before producing any agent-level permission request. */
function assertUniqueModuleUris(modules: readonly NormalizedModuleRequest[]): void {
  const firstIndexes = new Map<string, number>();
  for (const [index, { definition }] of modules.entries()) {
    const moduleUri = definition.module;
    const firstIndex = firstIndexes.get(moduleUri);
    if (firstIndex !== undefined) {
      throw new TypeError(
        `normalizeModuleRequests: duplicate module URI '${moduleUri}' at indexes ${firstIndex} and ${index}.`,
      );
    }
    firstIndexes.set(moduleUri, index);
  }
}

/**
 * Normalize and copy a permission policy without mutating caller-owned input.
 *
 * An omitted policy receives the default read, write, and delete permissions.
 * Shared with higher-level application manifest validation so every auth
 * request surface uses the same default, vocabulary, and duplicate rules.
 *
 * @internal
 */
export function normalizePermissionPolicy(value: unknown, location: string): Permission[] {
  const policy = value === undefined ? DEFAULT_PERMISSIONS : value;
  if (!Array.isArray(policy)) {
    throw new TypeError(`${location} must be an array.`);
  }

  const permissions: Permission[] = [];
  const firstIndexes = new Map<Permission, number>();
  for (const [permissionIndex, permission] of policy.entries()) {
    if (!isPermission(permission)) {
      throw new TypeError(
        `${location}[${permissionIndex}] has unsupported permission ` +
        `'${String(permission)}'. Supported permissions: read, write, delete.`,
      );
    }

    const firstIndex = firstIndexes.get(permission);
    if (firstIndex !== undefined) {
      throw new TypeError(
        `${location} contains duplicate permission '${permission}' ` +
        `at indexes ${firstIndex} and ${permissionIndex}.`,
      );
    }

    firstIndexes.set(permission, permissionIndex);
    permissions.push(permission);
  }

  return permissions;
}

function isPermission(value: unknown): value is Permission {
  return value === 'read' || value === 'write' || value === 'delete';
}

/** Whether a module request carries an explicit permission policy. */
function isModulePermissionRequest(entry: ModuleRequest): entry is ModulePermissionRequest {
  return isObjectRecord(entry) && Object.hasOwn(entry, 'permissions');
}

/** Select the definition source from either supported explicit request shape. */
function getExplicitModuleSource(
  entry: ModulePermissionRequest,
): DwnModuleDefinition | ModuleDefinitionCarrier {
  return 'module' in entry ? entry.module : entry.definition;
}

/** Unwrap a raw definition from a dependency-neutral structural carrier. */
function getModuleDefinition(
  source: DwnModuleDefinition | ModuleDefinitionCarrier,
  moduleIndex: number,
): DwnModuleDefinition {
  const candidate: unknown = source;
  let definition: unknown;
  if (isObjectRecord(candidate)
    && typeof candidate.module === 'string'
    && Object.hasOwn(candidate, 'types')
    && Object.hasOwn(candidate, 'structure')) {
    definition = candidate;
  } else if (isObjectRecord(candidate)) {
    definition = candidate.definition;
  }

  if (isObjectRecord(definition) && Object.hasOwn(definition, 'protocol')) {
    throw new TypeError(`normalizeModuleRequests: modules[${moduleIndex}] definition uses the removed protocol field.`);
  }

  if (!isObjectRecord(definition)
    || typeof definition.module !== 'string'
    || definition.module === ''
    || typeof definition.published !== 'boolean'
    || !isObjectRecord(definition.types)
    || !isObjectRecord(definition.structure)) {
    throw new TypeError(
      `normalizeModuleRequests: modules[${moduleIndex}] must provide a module definition with ` +
      'a non-empty module URI, boolean published flag, and object-valued types and structure.',
    );
  }

  return definition as DwnModuleDefinition;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
