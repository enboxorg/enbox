/** Deterministic equality for protocol definitions, including runtime encryption keys. */
export function installedProtocolDefinitionsEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

/** Deterministic JSON serialization with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const object = value as Record<string, unknown>;
  const pairs = Object.keys(object)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableStringify(object[key]));
  return '{' + pairs.join(',') + '}';
}
