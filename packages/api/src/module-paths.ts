import type { ModuleDefinition, ModuleRuleSet } from '@enbox/dwn-sdk-js';

import { getRuleSetAtPath, walkModuleRuleSets } from '@enbox/dwn-sdk-js';

/**
 * @internal Classifies an audience role in an authored module definition.
 *
 * Configure injects `$keyAgreement` at every authored path when any type is encrypted,
 * so every local `$role` becomes an encrypted audience in the installed definition.
 */
export function isEncryptedRoleAudiencePath(
  definition: ModuleDefinition,
  modulePath: string,
): boolean {
  return Object.values(definition.types).some(type => type.encryptionRequired === true)
    && isModuleRolePath(definition, modulePath);
}

/** @internal Whether one authored module path is a role record. */
export function isModuleRolePath(
  definition: ModuleDefinition,
  modulePath: string,
): boolean {
  return getRuleSetAtPath(modulePath, definition.structure)?.$role === true;
}

/** @internal Collect every non-directive path in a module structure. */
export function collectModulePaths(
  structure: globalThis.Record<string, unknown>,
): Set<string> {
  const paths = new Set<string>();
  walkModuleRuleSets(structure as ModuleRuleSet, (path): void => {
    paths.add(path);
  });
  return paths;
}

/** @internal Reject module composition until typed referenced policy can be supplied explicitly. */
export function assertTypedModuleStructureSupported(
  structure: globalThis.Record<string, unknown>,
): void {
  walkModuleRuleSets(structure as ModuleRuleSet, (path, ruleSet): void => {
    if (typeof (ruleSet as { $ref?: unknown }).$ref === 'string') {
      throw new TypeError(
        `Typed modules do not yet support $ref at '${path}'; use the raw DWN API for module composition.`,
      );
    }
  });
}
