/**
 * Permission request normalization utilities.
 *
 * Converts simplified `ProtocolRequest` entries (raw definitions, structural
 * definition carriers, or explicit permission policies) into agent-level
 * `ConnectPermissionRequest` objects used by connect handlers.
 *
 * @module
 * @internal
 */

import type { ConnectPermissionRequest } from '@enbox/connect';
import type { DwnProtocolDefinition } from '@enbox/agent';

import type {
  Permission,
  ProtocolDefinitionCarrier,
  ProtocolPermissionRequest,
  ProtocolRequest,
} from './types.js';

import { ServiceConfigProtocolDefinition } from '@enbox/agent';

import { DEFAULT_PERMISSIONS } from './types.js';
import { WalletConnect } from './wallet-connect-client.js';

/**
 * Read-only connect request for the endpoint-change announcement protocol.
 *
 * Include this alongside an application's own protocols before starting a
 * service-config watch. The resulting Messages.Read grant lets sync replicate
 * public owner announcements; their endpoint payload remains informational and
 * consumers must freshly resolve the DID document.
 */
export function serviceConfigProtocolRequest(): ProtocolRequest {
  return {
    definition  : ServiceConfigProtocolDefinition,
    permissions : ['read'],
  };
}

/**
 * Normalize simplified `ProtocolRequest[]` into agent-level
 * `ConnectPermissionRequest[]`.
 */
export function normalizeProtocolRequests(
  protocols: readonly ProtocolRequest[] | undefined,
): ConnectPermissionRequest[] {
  if (!protocols || protocols.length === 0) { return []; }

  const normalized = protocols.map((entry, index) => {
    const explicit = isProtocolPermissionRequest(entry);
    const source = explicit
      ? getExplicitProtocolSource(entry)
      : entry;
    const definition = getProtocolDefinition(source, index);
    const permissions = explicit
      ? copyPermissionPolicy(entry.permissions, index)
      : [...DEFAULT_PERMISSIONS];

    return { definition, permissions };
  });

  assertUniqueProtocolUris(normalized);

  return normalized.map(({ definition, permissions }) => {
    return WalletConnect.createPermissionRequestForProtocol({
      definition,
      permissions,
    });
  });
}

type NormalizedProtocolRequest = {
  definition: DwnProtocolDefinition;
  permissions: Permission[];
};

/** Reject duplicate requests before producing any agent-level permission request. */
function assertUniqueProtocolUris(protocols: readonly NormalizedProtocolRequest[]): void {
  const firstIndexes = new Map<string, number>();
  for (const [index, { definition }] of protocols.entries()) {
    const protocolUri = definition.protocol;
    const firstIndex = firstIndexes.get(protocolUri);
    if (firstIndex !== undefined) {
      throw new TypeError(
        `normalizeProtocolRequests: duplicate protocol URI '${protocolUri}' at indexes ${firstIndex} and ${index}.`,
      );
    }
    firstIndexes.set(protocolUri, index);
  }
}

/** Validate and copy one explicit permission policy without mutating caller-owned input. */
function copyPermissionPolicy(value: unknown, protocolIndex: number): Permission[] {
  const path = `protocols[${protocolIndex}].permissions`;
  if (!Array.isArray(value)) {
    throw new TypeError(`normalizeProtocolRequests: ${path} must be an array.`);
  }

  const permissions: Permission[] = [];
  const firstIndexes = new Map<Permission, number>();
  for (const [permissionIndex, permission] of value.entries()) {
    if (!isPermission(permission)) {
      throw new TypeError(
        `normalizeProtocolRequests: ${path}[${permissionIndex}] has unsupported permission ` +
        `'${String(permission)}'. Supported permissions: read, write, delete.`,
      );
    }

    const firstIndex = firstIndexes.get(permission);
    if (firstIndex !== undefined) {
      throw new TypeError(
        `normalizeProtocolRequests: ${path} contains duplicate permission '${permission}' ` +
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

/** Whether a protocol request carries an explicit permission policy. */
function isProtocolPermissionRequest(entry: ProtocolRequest): entry is ProtocolPermissionRequest {
  return isObjectRecord(entry) && Object.hasOwn(entry, 'permissions');
}

/** Select the definition source from either supported explicit request shape. */
function getExplicitProtocolSource(
  entry: ProtocolPermissionRequest,
): DwnProtocolDefinition | ProtocolDefinitionCarrier {
  return 'protocol' in entry ? entry.protocol : entry.definition;
}

/** Unwrap a raw definition from a dependency-neutral structural carrier. */
function getProtocolDefinition(
  source: DwnProtocolDefinition | ProtocolDefinitionCarrier,
  protocolIndex: number,
): DwnProtocolDefinition {
  const candidate: unknown = source;
  let definition: unknown;
  if (isObjectRecord(candidate)
    && typeof candidate.protocol === 'string'
    && Object.hasOwn(candidate, 'types')
    && Object.hasOwn(candidate, 'structure')) {
    definition = candidate;
  } else if (isObjectRecord(candidate)) {
    definition = candidate.definition;
  }

  if (!isObjectRecord(definition)
    || typeof definition.protocol !== 'string'
    || definition.protocol === ''
    || typeof definition.published !== 'boolean'
    || !isObjectRecord(definition.types)
    || !isObjectRecord(definition.structure)) {
    throw new TypeError(
      `normalizeProtocolRequests: protocols[${protocolIndex}] must provide a protocol definition with ` +
      'a non-empty protocol URI, boolean published flag, and object-valued types and structure.',
    );
  }

  return definition as DwnProtocolDefinition;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
