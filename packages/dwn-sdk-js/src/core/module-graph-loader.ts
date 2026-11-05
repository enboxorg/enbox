import type { ModuleDefinition } from '../types/modules-types.js';

import { DwnError, DwnErrorCode } from './dwn-error.js';

/** The caller binds tenant and governing-time selection into this callback. */
export type ModuleDefinitionFetcher = (moduleUri: string) => Promise<ModuleDefinition | undefined>;

/** Loads each dependency once; graph resolution remains synchronous and does no I/O. */
export async function preloadModuleDefinitions(
  root: ModuleDefinition,
  fetchDefinition: ModuleDefinitionFetcher,
): Promise<ReadonlyMap<string, ModuleDefinition>> {
  const definitions = new Map<string, ModuleDefinition>();
  const loading = new Set<string>();

  async function visit(definition: ModuleDefinition): Promise<void> {
    if (loading.has(definition.module)) {
      throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesCycle,
        `module dependency cycle at '${definition.module}'.`);
    }
    if (definitions.has(definition.module)) {
      return;
    }
    const snapshot = structuredClone(definition);
    definitions.set(snapshot.module, snapshot);
    loading.add(snapshot.module);
    for (const targetUri of [...new Set(Object.values(snapshot.uses ?? {}))].sort()) {
      if (loading.has(targetUri)) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesCycle,
          `module dependency '${snapshot.module}' -> '${targetUri}' forms a cycle.`);
      }
      if (definitions.has(targetUri)) {
        continue;
      }
      const target = await fetchDefinition(targetUri);
      if (target === undefined) {
        throw new DwnError(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled,
          `composed module '${targetUri}' is not installed.`);
      }
      if (target.module !== targetUri) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl,
          `lookup for '${targetUri}' returned definition '${target.module}'.`);
      }
      await visit(target);
    }
    loading.delete(snapshot.module);
  }

  await visit(root);
  return definitions;
}
