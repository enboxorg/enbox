import type { ProtocolDefinition } from '../../src/index.js';

/**
 * Cast a JSON-imported protocol-definition vector to `ProtocolDefinition` while keeping its
 * concrete literal shape. The double-cast is required because `resolveJsonModule` infers arrays
 * (not the non-empty `$actions` tuple), so `satisfies` cannot express it; centralized here so the
 * single unsound cast lives in one reviewable place.
 */
export function asProtocolDefinition<T>(json: T): ProtocolDefinition & T {
  return json as unknown as ProtocolDefinition & T;
}
