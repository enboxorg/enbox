import type { ModuleDefinition, ModuleRuleSet } from '@enbox/dwn-sdk-js';

import { getRuleSetAtPath, walkModuleRuleSets } from '@enbox/dwn-sdk-js';

/** @internal Whether one authored module path is a role record. */
export function isModuleRolePath(
  definition: ModuleDefinition,
  modulePath: string,
): boolean {
  return getRuleSetAtPath(modulePath, definition.structure)?.$role === true;
}

/** @internal Collect locally owned record paths, traversing structural attachments. */
export function collectModulePaths(
  structure: globalThis.Record<string, unknown>,
): Set<string> {
  const paths = new Set<string>();
  walkModuleRuleSets(structure as ModuleRuleSet, (path, ruleSet): void => {
    if (typeof ruleSet.$ref !== 'string') {
      paths.add(path);
    }
  });
  return paths;
}

/** @internal Managed invitation/follow records belong only to locally rooted sharing modules. */
export function hasManagedSharedContext(definition: ModuleDefinition): boolean {
  const hasEncryptedTypes = Object.entries(definition.types).some(([name, type]) =>
    name !== 'enboxContextFollow' && name !== 'enboxContextInvitation' && type.encryptionRequired === true);
  if (!hasEncryptedTypes) {
    return false;
  }

  return [...collectModulePaths(definition.structure)].some(path => {
    const root = definition.structure[path.split('/')[0]];
    return typeof root.$ref !== 'string' && isModuleRolePath(definition, path);
  });
}
