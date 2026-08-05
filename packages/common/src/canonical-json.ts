/**
 * Recursively canonicalizes a JSON-compatible value into a deterministic
 * shape: object keys are sorted by UTF-16 code unit and entries with
 * `undefined` values are dropped, matching `JSON.stringify` object semantics.
 * Returns a new value; the input is not mutated.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const entry = object[key];
      if (entry === undefined) {
        continue;
      }
      canonical[key] = canonicalizeJson(entry);
    }
    return canonical;
  }

  return value;
}

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 * Equality of the output strings is equivalent to deep JSON equality of the
 * inputs, regardless of key insertion order.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}
