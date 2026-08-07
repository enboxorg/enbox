import type { ProtocolDefinition, ProtocolRuleSet } from '@enbox/dwn-sdk-js';

import { getRuleSetAtPath, walkProtocolRuleSets } from '@enbox/dwn-sdk-js';

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

/** @internal Collect every non-directive path in a protocol structure. */
export function collectProtocolPaths(
  structure: globalThis.Record<string, unknown>,
): Set<string> {
  const paths = new Set<string>();
  walkProtocolRuleSets(structure as ProtocolRuleSet, (path): void => {
    paths.add(path);
  });
  return paths;
}

/** @internal Reject protocol composition until typed referenced policy can be supplied explicitly. */
export function assertTypedProtocolStructureSupported(
  structure: globalThis.Record<string, unknown>,
): void {
  walkProtocolRuleSets(structure as ProtocolRuleSet, (path, ruleSet): void => {
    if (typeof (ruleSet as { $ref?: unknown }).$ref === 'string') {
      throw new TypeError(
        `Typed protocols do not yet support $ref at '${path}'; use the raw DWN API for protocol composition.`,
      );
    }
  });
}
