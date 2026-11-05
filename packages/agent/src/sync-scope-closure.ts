import type { ModuleDefinition, ModuleRuleSet } from '@enbox/dwn-sdk-js';

import { parseCrossModuleRef } from '@enbox/dwn-sdk-js';

import { lexicographicalCompare } from './types/sync.js';

export type ModuleClosureEdges = {
  dependencyModules: string[];
  usesModules: string[];
};

/**
 * Extracts the module-level closure edges a retained module definition can
 * introduce for sync registration validation.
 */
export function getModuleClosureEdges(definition: ModuleDefinition): ModuleClosureEdges {
  const usesModules = sortedUnique(Object.values(definition.uses ?? {}));
  const dependencyModules = sortedUnique(collectDependencyModules(definition));

  return { dependencyModules, usesModules };
}

function collectDependencyModules(definition: ModuleDefinition): string[] {
  const modules: string[] = [];
  for (const ruleSet of Object.values(definition.structure)) {
    collectDependencyModulesFromRuleSet(ruleSet, definition.uses ?? {}, modules);
  }

  return modules;
}

function collectDependencyModulesFromRuleSet(
  ruleSet: ModuleRuleSet,
  uses: Record<string, string>,
  modules: string[],
): void {
  collectReferencedModule(ruleSet.$ref, uses, modules);

  for (const actionRule of ruleSet.$actions ?? []) {
    collectReferencedModule(actionRule.role, uses, modules);
    collectReferencedModule(actionRule.of, uses, modules);
  }

  for (const [key, value] of Object.entries(ruleSet)) {
    if (key.startsWith('$') || !isModuleRuleSet(value)) {
      continue;
    }

    collectDependencyModulesFromRuleSet(value, uses, modules);
  }
}

function collectReferencedModule(
  ref: string | undefined,
  uses: Record<string, string>,
  modules: string[],
): void {
  if (ref === undefined) {
    return;
  }

  const parsed = parseCrossModuleRef(ref);
  if (parsed === undefined) {
    return;
  }

  const module = uses[parsed.alias];
  if (module !== undefined) {
    modules.push(module);
  }
}

function isModuleRuleSet(value: unknown): value is ModuleRuleSet {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(lexicographicalCompare);
}
