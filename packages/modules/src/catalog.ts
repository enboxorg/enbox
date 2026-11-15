import type { ModuleCatalogEntry } from './catalog-types.js';

import { moduleCatalog } from './generated/catalog.js';

export { moduleCatalog, standardModules } from './generated/catalog.js';

/** Look up a module by exact URI or case-insensitive catalog ID/name. */
export function getModuleCatalogEntry(idOrUri: string): ModuleCatalogEntry | undefined {
  const value = idOrUri.trim();
  const name = value.toLowerCase();
  return moduleCatalog.find((entry): boolean => entry.uri === value || entry.id === name || entry.name.toLowerCase() === name);
}

/** Search discovery metadata without reading any personal DWN records. */
export function searchModuleCatalog(query: string): readonly ModuleCatalogEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return moduleCatalog;
  }
  return moduleCatalog.filter((entry): boolean => {
    const text = [entry.id, entry.name, entry.category, entry.description, ...entry.captureExamples,
      ...entry.records.map((record): string => record.path)].join(' ').toLowerCase();
    return terms.every((term): boolean => text.includes(term));
  });
}
