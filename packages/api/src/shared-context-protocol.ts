import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from './record-codec.js';

import { Did } from '@enbox/dids';
import { installedProtocolDefinitionsEqual } from './protocol-definition-utils.js';
import { recordCodecs } from './record-codec.js';

/** Reserved record type used by the shared-context invitation inbox. */
export const CONTEXT_INVITATION_PATH = 'enboxContextInvitation';
/** Reserved owner-only record path for durable shared-context following intent. */
export const CONTEXT_FOLLOW_PATH = 'enboxContextFollow';

const SHARED_CONTEXT_PATHS = [CONTEXT_FOLLOW_PATH, CONTEXT_INVITATION_PATH] as const;

/** Small, non-sensitive application metadata displayed before a context is accepted. */
export type ContextInvitationPreview = Readonly<globalThis.Record<string, string>>;

/** Data stored in one signed invitation record. */
type ContextInvitationEnvelope = Readonly<{
  contextId: string;
  group: string;
  preview: ContextInvitationPreview;
}>;

/** One immutable recipient-owned decision to follow or forget a context. */
export type ContextFollowIntent = Readonly<{
  contextId: string;
  ownerDid: string;
} & (
  | {
    following: true;
    /** Name of a protocol.roleGroups entry; actual access is verified when restoring. */
    group: string;
  }
  | { following: false }
)>;

export const contextInvitationCodec = Object.freeze(recordCodecs.json<ContextInvitationEnvelope>());
export const contextFollowCodec = Object.freeze(recordCodecs.json<ContextFollowIntent>({ validator: isContextFollowIntent }));

/** Add the invitation inbox and private following journal without changing authored protocol objects. */
export function addSharedContextProtocol(
  definition : ProtocolDefinition,
  codecs : RecordCodecMap,
): { definition: ProtocolDefinition; codecs: RecordCodecMap } {
  const shared = createSharedContextFragment();
  return {
    definition: {
      ...definition,
      types     : { ...definition.types, ...shared.types },
      structure : { ...definition.structure, ...shared.structure },
    },
    codecs: {
      ...codecs,
      [CONTEXT_INVITATION_PATH] : contextInvitationCodec,
      [CONTEXT_FOLLOW_PATH]     : contextFollowCodec,
    },
  };
}

/** Require both canonical shared-context paths and their codecs on effective definitions. */
export function hasSharedContextProtocol(definition: ProtocolDefinition, codecs: RecordCodecMap): boolean {
  const shared = createSharedContextFragment();
  return codecs[CONTEXT_INVITATION_PATH] === contextInvitationCodec
    && codecs[CONTEXT_FOLLOW_PATH] === contextFollowCodec
    && SHARED_CONTEXT_PATHS.every(path =>
      installedProtocolDefinitionsEqual(definition.types[path], shared.types[path])
      && installedProtocolDefinitionsEqual(definition.structure[path], shared.structure[path]));
}

/** Reject collisions even when only the type or structure path was authored. */
export function assertSharedContextNamesAvailable(definition: ProtocolDefinition): void {
  for (const path of SHARED_CONTEXT_PATHS) {
    if (Object.hasOwn(definition.types, path) || Object.hasOwn(definition.structure, path)) {
      const purpose = path === CONTEXT_FOLLOW_PATH ? 'following' : 'invitations';
      throw new TypeError(`defineProtocol: '${path}' is reserved for shared-context ${purpose}.`);
    }
  }
}

/** Validate one decoded invitation without trusting peer-authored application data. */
export function isContextInvitationEnvelope(value: unknown): value is ContextInvitationEnvelope {
  if (!isObject(value)
    || typeof value.contextId !== 'string'
    || value.contextId.length === 0
    || typeof value.group !== 'string'
    || value.group.length === 0
    || !isObject(value.preview)) {
    return false;
  }
  return Object.values(value.preview).every(entry => typeof entry === 'string');
}

/** Validate stored intent coordinates before resolving its protocol-specific group and context. */
export function isContextFollowIntent(value: unknown): value is ContextFollowIntent {
  return isObject(value)
    && typeof value.ownerDid === 'string'
    && Did.parse(value.ownerDid)?.uri === value.ownerDid
    && typeof value.contextId === 'string'
    && value.contextId.length > 0
    && (value.following === false || (value.following === true
      && typeof value.group === 'string' && value.group.length > 0));
}

/** Return the collision-safe identity for one owner-scoped protocol context. */
export function protocolContextKey(ownerDid: string, contextId: string): string {
  return JSON.stringify([ownerDid, contextId]);
}

function isObject(value: unknown): value is globalThis.Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Each effective protocol owns fresh fragments so application changes cannot alter another protocol. */
function createSharedContextFragment(): Pick<ProtocolDefinition, 'types' | 'structure'> {
  return {
    types: {
      [CONTEXT_INVITATION_PATH]: {
        schema      : 'https://enbox.id/schemas/context-invitation',
        dataFormats : ['application/json'],
      },
      [CONTEXT_FOLLOW_PATH]: {
        schema             : 'https://enbox.id/schemas/context-follow',
        dataFormats        : ['application/json'],
        encryptionRequired : true,
      },
    },
    structure: {
      // A stranger can offer a context before any relationship exists. Size and
      // immutability bound each record, but a global record cap would let one
      // writer block real invitations; per-author limits are ineffective when
      // DIDs are free. The inbox remains untrusted, bounded discovery input —
      // see projectContextInvitations — until Enbox has an admission policy.
      [CONTEXT_INVITATION_PATH]: {
        $immutable : true,
        $size      : { max: 8_192 },
        $actions   : [{ who: 'anyone', can: ['create'] }],
      },
      // No $actions grant journal access beyond the tenant owner and authorized delegates.
      [CONTEXT_FOLLOW_PATH]: {
        $immutable : true,
        $size      : { max: 8_192 },
      },
    },
  };
}
