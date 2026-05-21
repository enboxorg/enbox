/**
 * Checks whether the given object has any properties.
 */
export function isEmptyObject(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  if (Object.getOwnPropertySymbols(obj).length > 0) {
    return false;
  }

  return Object.keys(obj).length === 0;
}

/**
 * Recursively removes all properties with an empty object or array as its value from the given object.
 *
 * Null-tolerant: skips `null` values without recursing into them.
 * `typeof null === 'object'` in JavaScript, so without an explicit guard
 * the recursion would call `Object.keys(null)` and throw.
 */
export function removeEmptyObjects(obj: Record<string, unknown>): void {
  Object.keys(obj).forEach(key => {
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      // recursive remove empty object or array properties in nested objects
      removeEmptyObjects(value as Record<string, unknown>);
    }

    if (isEmptyObject(value)) {
      delete obj[key];
    }
  });
}

/**
 * Recursively removes all properties with `undefined` as its value from the given object.
 *
 * Mutates `obj` in place and descends into nested objects. Null-tolerant:
 * `null` values are left in place but not recursed into (`typeof null ===
 * 'object'` in JavaScript, so without the guard the recursion would call
 * `Object.keys(null)` and throw). Use {@link omitUndefined} when you
 * want an immutable, shallow, type-preserving alternative.
 *
 * @see {@link omitUndefined} for the non-mutating, typed, shallow variant used
 *   by higher-level packages like `@enbox/api` to normalize call-site options.
 */
export function removeUndefinedProperties(obj: Record<string, unknown>): void {
  Object.keys(obj).forEach(key => {
    const value = obj[key];
    if (value === undefined) {
      delete obj[key];
    } else if (value !== null && typeof value === 'object') {
      removeUndefinedProperties(value as Record<string, unknown>); // recursive remove `undefined` properties in nested objects
    }
  });
}

/**
 * Returns a new object containing only the entries of `input` whose values are
 * not `undefined`. Pure — never mutates the input. Shallow — does not descend
 * into nested objects.
 *
 * Companion to {@link removeUndefinedProperties}, which mutates and recurses.
 * Pick the variant that matches the call site:
 *
 * | Helper                       | Mutates? | Recursive? | Typed?           |
 * |------------------------------|----------|------------|------------------|
 * | `removeUndefinedProperties`  | yes      | yes        | no (`Record`)    |
 * | `omitUndefined`              | no       | no         | yes (preserves T)|
 *
 * Both helpers are the single source of truth for the monorepo —
 * `@enbox/dwn-sdk-js/utils/object.ts` re-exports them rather than holding
 * its own copy. New shape-transform helpers belong here.
 *
 * @example
 * ```ts
 * omitUndefined({ a: 1, b: undefined, c: 'x' });
 * // → { a: 1, c: 'x' }
 *
 * // Useful when building option payloads where `undefined` keys would break
 * // assertion equality in tests:
 * const opts = omitUndefined({ password: input.password, sync: input.sync });
 * ```
 */
export function omitUndefined<T extends object>(input: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(input) as (keyof T)[]) {
    const value = input[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}