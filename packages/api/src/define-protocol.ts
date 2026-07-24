/**
 * Factory function for creating typed protocol definitions.
 *
 * `defineProtocol()` pairs a standard {@link ProtocolDefinition} with the
 * runtime codecs used by {@link TypedEnbox} for application values.
 */

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { ProtocolPathTypeNames, ProtocolRecordCodecs, TypedProtocol } from './protocol-types.js';
import type { RecordCodec, RecordCodecMap } from './record-codec.js';

import { getTypeName } from '@enbox/dwn-sdk-js';
import { assertTypedProtocolStructureSupported, collectProtocolPaths } from './protocol-paths.js';

type ExactProtocolCodecs<
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
> = Exclude<Extract<keyof C, string>, ProtocolPathTypeNames<D>> extends never ? C : never;

/**
 * Creates a {@link TypedProtocol} from a plain DWN protocol definition and
 * the codecs that define each typed record's application value.
 *
 * @param definition - A standard `ProtocolDefinition` object.
 * @param codecs - One runtime codec for every type reachable through the structure.
 * @returns A `TypedProtocol` containing the definition and codecs.
 *
 * @example
 * ```ts
 * const socialGraph = defineProtocol(SocialGraphDefinition, {
 *   friend : recordCodecs.json<{ did: string; alias?: string }>(),
 *   block  : recordCodecs.json<{ did: string; reason?: string }>(),
 * });
 *
 * // socialGraph.definition is the raw ProtocolDefinition
 * // TypedEnbox infers paths like 'friend' | 'friend/message' and
 * // data types from the codecs.
 * ```
 */
export function defineProtocol<
  const D extends ProtocolDefinition,
  const C extends ProtocolRecordCodecs<D>,
>(
  definition : D,
  codecs : ExactProtocolCodecs<D, C>,
): TypedProtocol<D, C> {
  assertTypedProtocolStructureSupported(definition.structure);
  const requiredTypeNames = new Set(
    [...collectProtocolPaths(definition.structure)].map((path) => getTypeName(path)),
  );
  const suppliedTypeNames = Object.keys(codecs);
  const missing = [...requiredTypeNames].filter((typeName) => !Object.hasOwn(codecs, typeName));
  const extra = suppliedTypeNames.filter((typeName) => !requiredTypeNames.has(typeName));
  const invalid = suppliedTypeNames.filter((typeName) => !isRecordCodec(codecs[typeName]));

  if (missing.length > 0 || extra.length > 0 || invalid.length > 0) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing: ${missing.sort().join(', ')}`]),
      ...(extra.length === 0 ? [] : [`unexpected: ${extra.sort().join(', ')}`]),
      ...(invalid.length === 0 ? [] : [`invalid: ${invalid.sort().join(', ')}`]),
    ];
    throw new TypeError(`defineProtocol: codecs must exactly match reachable protocol types (${details.join('; ')}).`);
  }

  return { definition, codecs };
}

function isRecordCodec(value: unknown): value is RecordCodec<unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<RecordCodec<unknown>>;
  return typeof candidate.encode === 'function' && typeof candidate.decode === 'function';
}
