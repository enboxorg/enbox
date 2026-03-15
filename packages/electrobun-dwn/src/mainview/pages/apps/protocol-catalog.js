import * as protocolExports from '@enbox/protocols';

/**
 * @typedef {{
 *   protocol: string;
 *   published?: boolean;
 *   uses?: Record<string, string>;
 *   [key: string]: unknown;
 * }} ProtocolDefinitionLike
 */

/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   definition: ProtocolDefinitionLike;
 *   protocol: string;
 *   protocolUrl: string;
 *   publisher: string;
 *   searchText: string;
 * }} ProtocolCatalogEntry
 */

/**
 * @param {unknown} value
 * @returns {value is ProtocolDefinitionLike}
 */
function isProtocolDefinition(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.protocol === 'string'
    && value.protocol.trim().length > 0,
  );
}

/**
 * @param {string} exportName
 * @returns {string}
 */
function formatProtocolName(exportName) {
  return exportName
    .replace(/Definition$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

/**
 * @param {string} protocolUrl
 * @returns {string}
 */
function protocolPublisher(protocolUrl) {
  try {
    return new URL(protocolUrl).hostname;
  } catch {
    return protocolUrl;
  }
}

/**
 * @returns {readonly ProtocolCatalogEntry[]}
 */
function createProtocolCatalog() {
  return Object.freeze(
    Object.entries(protocolExports)
      .filter(([exportName, value]) => exportName.endsWith('Definition') && isProtocolDefinition(value))
      .map(([exportName, definition]) => {
        const name = formatProtocolName(exportName);
        const protocolUrl = definition.protocol.trim();
        const publisher = protocolPublisher(protocolUrl);

        return {
          id: protocolUrl,
          name,
          definition,
          protocol: protocolUrl,
          protocolUrl,
          publisher,
          searchText: `${name} ${publisher} ${protocolUrl}`.toLowerCase(),
        };
      })
      .sort((left, right) => {
        const nameComparison = left.name.localeCompare(right.name);
        if (nameComparison !== 0) {
          return nameComparison;
        }

        return left.protocol.localeCompare(right.protocol);
      }),
  );
}

export const protocolCatalog = createProtocolCatalog();

const protocolCatalogByUri = new Map(
  protocolCatalog.map((entry) => [entry.protocol, entry]),
);

/**
 * @param {string} protocolUri
 * @returns {ProtocolCatalogEntry | null}
 */
export function getProtocolCatalogEntry(protocolUri) {
  const normalizedProtocolUri = String(protocolUri ?? '').trim();
  return protocolCatalogByUri.get(normalizedProtocolUri) ?? null;
}

/**
 * @param {string} protocolUri
 * @returns {{ plan: ProtocolCatalogEntry[]; missingDependencies: string[] }}
 */
export function getProtocolInstallPlan(protocolUri) {
  const plan = [];
  const visited = new Set();
  const missingDependencies = new Set();

  /**
   * @param {string} nextProtocolUri
   */
  const visit = (nextProtocolUri) => {
    const normalizedProtocolUri = String(nextProtocolUri ?? '').trim();
    if (!normalizedProtocolUri || visited.has(normalizedProtocolUri)) {
      return;
    }

    visited.add(normalizedProtocolUri);
    const entry = getProtocolCatalogEntry(normalizedProtocolUri);

    if (!entry) {
      missingDependencies.add(normalizedProtocolUri);
      return;
    }

    const uses = entry.definition?.uses;
    if (uses && typeof uses === 'object') {
      for (const dependencyProtocol of Object.values(uses)) {
        if (typeof dependencyProtocol === 'string') {
          visit(dependencyProtocol);
        }
      }
    }

    plan.push(entry);
  };

  visit(protocolUri);

  return {
    plan,
    missingDependencies: [...missingDependencies],
  };
}
