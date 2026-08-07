/**
 * The shallow plain-object update accepted by record patch operations.
 *
 * Optional fields may be set to `null` to delete them. Required fields cannot
 * be deleted, so a required nullable field must be set to `null` through a
 * complete record replacement instead. Known binary and array payloads
 * cannot be patched.
 */
export type RecordPatch<T = unknown> = unknown extends T
  ? globalThis.Record<string, unknown>
  : T extends Blob | ArrayBuffer | ArrayBufferView | ReadableStream | readonly unknown[]
    ? never
    : T extends object
    ? { [K in keyof T]?: undefined extends T[K] ? T[K] | null : Exclude<T[K], null> }
    : never;

/** @internal Apply the canonical shallow patch semantics to one decoded value. */
export function mergeRecordPatch<T>(current: unknown, patch: RecordPatch<T>): T {
  if (!isPlainRecord(current)) {
    throw new Error('TypedEnbox.records.patch requires the current value to be a plain object.');
  }

  const merged: globalThis.Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged as T;
}

function isPlainRecord(value: unknown): value is globalThis.Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
