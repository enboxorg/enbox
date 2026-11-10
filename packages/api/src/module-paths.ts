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
