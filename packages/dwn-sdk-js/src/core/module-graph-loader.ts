import type { ModuleDefinition } from '../types/modules-types.js';
import type { ResolvedModuleGraph } from './module-graph.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

import { lexicographicalCompare } from '../utils/string.js';
import { resolveModuleGraph } from './module-graph.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

/** The caller binds tenant and governing-time selection into this callback. */
export type ModuleDefinitionFetcher = (moduleUri: string) => Promise<ModuleDefinition | undefined>;

/** Resolves all runtime dependencies using the same tenant and governing timestamp. */
export async function loadModuleGraph(
  tenant: string,
  moduleUri: string,
  reader: Pick<ValidationStateReader, 'fetchModuleDefinition'>,
  messageTimestamp?: string,
): Promise<ResolvedModuleGraph> {
  const root = await reader.fetchModuleDefinition(tenant, moduleUri, messageTimestamp);
  const definitions = await preloadModuleDefinitions(root, async (uri): Promise<ModuleDefinition | undefined> => {
    try {
      return await reader.fetchModuleDefinition(tenant, uri, messageTimestamp);
    } catch (error) {
      if (error instanceof DwnError && error.code === DwnErrorCode.ModuleAuthorizationModuleNotFound) {
        return undefined;
      }
      throw error;
    }
  });
  return resolveModuleGraph(root, uri => definitions.get(uri));
}

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
    for (const targetUri of [...new Set(Object.values(snapshot.uses ?? {}))].sort(lexicographicalCompare)) {
      if (loading.has(targetUri)) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesCycle,
          `module dependency '${snapshot.module}' -> '${targetUri}' forms a cycle.`);
      }
      if (definitions.has(targetUri)) {
        continue;
      }
      const target = await fetchDefinition(targetUri); // NOSONAR: S9382 — bound reads and fail at the first canonical dependency.
      if (target === undefined) {
        throw new DwnError(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled,
          `composed module '${targetUri}' is not installed.`);
      }
      if (target.module !== targetUri) {
        throw new DwnError(DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl,
          `lookup for '${targetUri}' returned definition '${target.module}'.`);
      }
      await visit(target); // NOSONAR: S9382 — unwind the active ancestry before sibling cycle checks.
    }
    loading.delete(snapshot.module);
  }

  await visit(root);
  return definitions;
}
