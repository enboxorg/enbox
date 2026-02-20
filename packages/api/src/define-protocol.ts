/**
 * Factory function for creating typed protocol definitions.
 *
 * `defineProtocol()` wraps a standard {@link ProtocolDefinition} with
 * compile-time type metadata so that {@link TypedWeb5} can provide
 * path autocompletion, data-shape inference, and tag type safety.
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { SchemaMap, TypedProtocol } from './protocol-types.js';

/**
 * Creates a {@link TypedProtocol} from a plain DWN protocol definition and
 * an optional schema map that associates TypeScript types with protocol type
 * names.
 *
 * The `definition` argument is returned as-is (no cloning). The schema map
 * is a phantom type parameter — it exists only at compile time to thread
 * type information through to `TypedWeb5`.
 *
 * @param definition - A standard `ProtocolDefinition` object.
 * @param _schemaMap - A phantom value (e.g. `{} as MySchemaMap`) that carries
 *   the TypeScript type mapping. The runtime value is ignored.
 * @returns A `TypedProtocol` containing the definition and inferred types.
 *
 * @example
 * ```ts
 * const socialGraph = defineProtocol(SocialGraphDefinition, {} as {
 *   friend : { did: string; alias?: string };
 *   block  : { did: string; reason?: string };
 * });
 *
 * // socialGraph.definition is the raw ProtocolDefinition
 * // TypedWeb5 infers paths like 'friend' | 'friend/message' and
 * // data types from the schema map.
 * ```
 */
export function defineProtocol<
  D extends ProtocolDefinition,
  M extends SchemaMap = SchemaMap,
>(
  definition : D,

  _schemaMap?: M,
): TypedProtocol<D, M> {
  return { definition } as TypedProtocol<D, M>;
}
