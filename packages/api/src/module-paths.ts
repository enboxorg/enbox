import type { ModuleRuleSet } from '@enbox/dwn-sdk-js';

import { walkModuleRuleSets } from '@enbox/dwn-sdk-js';

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
