import { canonicalJsonStringify } from '@enbox/common';

/** Deterministic equality for protocol definitions, including runtime encryption keys. */
export function installedProtocolDefinitionsEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}
