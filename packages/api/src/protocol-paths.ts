import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { getProtocolRoleActionPaths, getRuleSetAtPath, ProtocolAction } from '@enbox/dwn-sdk-js';

/** Runtime scope derived from one contextual protocol role. */
type ContextRoleScope = {
  allowedPaths: ReadonlySet<string>;
  protocolPath: string;
  readablePaths: [string, ...string[]];
};

/**
 * @internal Classifies an audience role in an authored protocol definition.
 *
 * Configure injects `$keyAgreement` at every authored path when any type is encrypted,
 * so every local `$role` becomes an encrypted audience in the installed definition.
 */
export function isEncryptedRoleAudiencePath(
  definition: ProtocolDefinition,
  protocolPath: string,
): boolean {
  return Object.values(definition.types).some(type => type.encryptionRequired === true)
    && isProtocolRolePath(definition, protocolPath);
}

/** @internal Whether one authored protocol path is a role record. */
export function isProtocolRolePath(
  definition: ProtocolDefinition,
  protocolPath: string,
): boolean {
  return getRuleSetAtPath(protocolPath, definition.structure)?.$role === true;
}

/** @internal Resolve the content scope governed by one nested protocol role. */
export function resolveContextRoleScope(
  definition: ProtocolDefinition,
  role: string,
): ContextRoleScope {
  if (!isProtocolRolePath(definition, role)) {
    throw new TypeError(`Context role '${role}' is not a protocol role path.`);
  }

  const protocolPath = role.split('/').slice(0, -1).join('/');
  if (protocolPath === '') {
    throw new TypeError('Context roles must be nested below a context root.');
  }
  const isContextContentPath = (path: string): boolean =>
    (path === protocolPath || path.startsWith(`${protocolPath}/`)) &&
    !isProtocolRolePath(definition, path);
  const readablePaths = getProtocolRoleActionPaths(definition, role, ProtocolAction.Read)
    .filter(isContextContentPath);
  if (!readablePaths.includes(protocolPath)) {
    throw new TypeError(`Context role '${role}' must authorize reading its parent context '${protocolPath}'.`);
  }

  return {
    allowedPaths  : new Set(getProtocolRoleActionPaths(definition, role).filter(isContextContentPath)),
    protocolPath,
    readablePaths : readablePaths as [string, ...string[]],
  };
}

/** @internal Collect every non-directive path in a protocol structure. */
export function collectProtocolPaths(
  structure: globalThis.Record<string, unknown>,
  prefix: string = '',
): Set<string> {
  const paths = new Set<string>();

  for (const [key, child] of Object.entries(structure)) {
    if (key.startsWith('$')) {
      continue;
    }

    const path = prefix === '' ? key : `${prefix}/${key}`;
    paths.add(path);
    if (child !== null && typeof child === 'object') {
      for (const nested of collectProtocolPaths(child as globalThis.Record<string, unknown>, path)) {
        paths.add(nested);
      }
    }
  }

  return paths;
}

/** @internal Reject protocol composition until typed referenced policy can be supplied explicitly. */
export function assertTypedProtocolStructureSupported(
  structure: globalThis.Record<string, unknown>,
  prefix: string = '',
): void {
  for (const [key, child] of Object.entries(structure)) {
    if (key.startsWith('$') || child === null || typeof child !== 'object') {
      continue;
    }

    const path = prefix === '' ? key : `${prefix}/${key}`;
    const node = child as globalThis.Record<string, unknown>;
    if (typeof node.$ref === 'string') {
      throw new TypeError(
        `Typed protocols do not yet support $ref at '${path}'; use the raw DWN API for protocol composition.`,
      );
    }
    assertTypedProtocolStructureSupported(node, path);
  }
}
