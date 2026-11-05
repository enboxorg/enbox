import * as moduleExports from '@enbox/modules';

/**
 * @typedef {{
 *   module: string;
 *   published?: boolean;
 *   uses?: Record<string, string>;
 *   [key: string]: unknown;
 * }} ModuleDefinitionLike
 */

/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   definition: ModuleDefinitionLike;
 *   module: string;
 *   moduleUrl: string;
 *   publisher: string;
 *   searchText: string;
 * }} ModuleCatalogEntry
 */

/**
 * @param {unknown} value
 * @returns {value is ModuleDefinitionLike}
 */
function isModuleDefinition(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.module === 'string'
    && value.module.trim().length > 0,
  );
}

/**
 * @param {string} exportName
 * @returns {string}
 */
function formatModuleName(exportName) {
  return exportName
    .replace(/Definition$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

/**
 * @param {string} moduleUrl
 * @returns {string}
 */
function modulePublisher(moduleUrl) {
  try {
    return new URL(moduleUrl).hostname;
  } catch {
    return moduleUrl;
  }
}

/**
 * @returns {readonly ModuleCatalogEntry[]}
 */
function createModuleCatalog() {
  return Object.freeze(
    Object.entries(moduleExports)
      .filter(([exportName, value]) => exportName.endsWith('Definition') && isModuleDefinition(value))
      .map(([exportName, definition]) => {
        const name = formatModuleName(exportName);
        const moduleUrl = definition.module.trim();
        const publisher = modulePublisher(moduleUrl);

        return {
          id: moduleUrl,
          name,
          definition,
          module: moduleUrl,
          moduleUrl,
          publisher,
          searchText: `${name} ${publisher} ${moduleUrl}`.toLowerCase(),
        };
      })
      .sort((left, right) => {
        const nameComparison = left.name.localeCompare(right.name);
        if (nameComparison !== 0) {
          return nameComparison;
        }

        return left.module.localeCompare(right.module);
      }),
  );
}

export const moduleCatalog = createModuleCatalog();

const moduleCatalogByUri = new Map(
  moduleCatalog.map((entry) => [entry.module, entry]),
);

/**
 * @param {string} moduleUri
 * @returns {ModuleCatalogEntry | null}
 */
export function getModuleCatalogEntry(moduleUri) {
  const normalizedModuleUri = String(moduleUri ?? '').trim();
  return moduleCatalogByUri.get(normalizedModuleUri) ?? null;
}

/**
 * @param {string} moduleUri
 * @returns {{ plan: ModuleCatalogEntry[]; missingDependencies: string[] }}
 */
export function getModuleInstallPlan(moduleUri) {
  const plan = [];
  const visited = new Set();
  const missingDependencies = new Set();

  /**
   * @param {string} nextModuleUri
   */
  const visit = (nextModuleUri) => {
    const normalizedModuleUri = String(nextModuleUri ?? '').trim();
    if (!normalizedModuleUri || visited.has(normalizedModuleUri)) {
      return;
    }

    visited.add(normalizedModuleUri);
    const entry = getModuleCatalogEntry(normalizedModuleUri);

    if (!entry) {
      missingDependencies.add(normalizedModuleUri);
      return;
    }

    const uses = entry.definition?.uses;
    if (uses && typeof uses === 'object') {
      for (const dependencyModule of Object.values(uses)) {
        if (typeof dependencyModule === 'string') {
          visit(dependencyModule);
        }
      }
    }

    plan.push(entry);
  };

  visit(moduleUri);

  return {
    plan,
    missingDependencies: [...missingDependencies],
  };
}
