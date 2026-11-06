import { canonicalJsonStringify } from '@enbox/common';

/** Deterministic equality for module definitions, including runtime encryption keys. */
export function installedModuleDefinitionsEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}
