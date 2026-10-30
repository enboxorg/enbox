import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from './record-codec.js';

import { Did } from '@enbox/dids';
import { installedProtocolDefinitionsEqual } from './protocol-definition-utils.js';
import { recordCodecs } from './record-codec.js';

/** Reserved owner-only record path for durable shared-context following intent. */
export const CONTEXT_FOLLOW_PATH = 'enboxContextFollow';

/** One immutable recipient-owned decision to follow or forget a context. */
export type ContextFollowIntent = Readonly<{
  contextId: string;
  following: boolean;
  /** Name of a protocol.roleGroups entry; the actual role is verified again when restoring access. */
  group: string;
  ownerDid: string;
}>;

const CONTEXT_FOLLOW_SCHEMA = 'https://enbox.id/schemas/context-follow';

export const contextFollowCodec = Object.freeze(recordCodecs.json<ContextFollowIntent>({ validator: isContextFollowIntent }));

/** Add the private following journal without changing authored protocol objects. */
export function addContextFollowProtocol(
  definition : ProtocolDefinition,
  codecs : RecordCodecMap,
): { definition: ProtocolDefinition; codecs: RecordCodecMap } {
  return {
    definition: {
      ...definition,
      types: {
        ...definition.types,
        [CONTEXT_FOLLOW_PATH]: contextFollowType(),
      },
      structure: {
        ...definition.structure,
        [CONTEXT_FOLLOW_PATH]: contextFollowRule(),
      },
    },
    codecs: {
      ...codecs,
      [CONTEXT_FOLLOW_PATH]: contextFollowCodec,
    },
  };
}

/** Require the canonical private journal fragment and its codec on effective definitions. */
export function hasContextFollowProtocol(
  definition : ProtocolDefinition,
  codecs : RecordCodecMap,
): boolean {
  return installedProtocolDefinitionsEqual(definition.types[CONTEXT_FOLLOW_PATH], contextFollowType())
    && installedProtocolDefinitionsEqual(definition.structure[CONTEXT_FOLLOW_PATH], contextFollowRule())
    && codecs[CONTEXT_FOLLOW_PATH] === contextFollowCodec;
}

/** Validate stored intent coordinates before resolving its protocol-specific group and context. */
export function isContextFollowIntent(value: unknown): value is ContextFollowIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const intent = value as Partial<ContextFollowIntent>;
  return typeof intent.ownerDid === 'string'
    && Did.parse(intent.ownerDid)?.uri === intent.ownerDid
    && typeof intent.contextId === 'string'
    && intent.contextId.length > 0
    && typeof intent.group === 'string'
    && intent.group.length > 0
    && typeof intent.following === 'boolean';
}

/** Reject collisions even when only the type or structure path was authored. */
export function assertContextFollowNameAvailable(definition: ProtocolDefinition): void {
  if (Object.hasOwn(definition.types, CONTEXT_FOLLOW_PATH)
    || Object.hasOwn(definition.structure, CONTEXT_FOLLOW_PATH)) {
    throw new TypeError(`defineProtocol: '${CONTEXT_FOLLOW_PATH}' is reserved for shared-context following.`);
  }
}

function contextFollowType(): ProtocolDefinition['types'][string] {
  return {
    dataFormats        : ['application/json'],
    encryptionRequired : true,
    schema             : CONTEXT_FOLLOW_SCHEMA,
  };
}

/** No $actions grant access beyond the tenant owner and its authorized delegates. */
function contextFollowRule(): ProtocolDefinition['structure'][string] {
  return {
    $immutable : true,
    $size      : { max: 8_192 },
  };
}
