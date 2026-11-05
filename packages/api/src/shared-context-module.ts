import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from './record-codec.js';

import { Did } from '@enbox/dids';
import { installedModuleDefinitionsEqual } from './module-definition-utils.js';
import { isValidRecordContextId } from './record-query.js';
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
  path: string;
  preview: ContextInvitationPreview;
}>;

/** One immutable recipient-owned decision to follow or forget a context. */
export type ContextFollowIntent = Readonly<{
  contextId: string;
  ownerDid: string;
} & (
  | {
    following: true;
    /** Module path of the context root; actual access is verified when restoring. */
    path: string;
  }
  | { following: false }
)>;

export const contextInvitationCodec = Object.freeze(recordCodecs.json<ContextInvitationEnvelope>({ validator: isContextInvitationEnvelope }));
export const contextFollowCodec = Object.freeze(recordCodecs.json<ContextFollowIntent>({ validator: isContextFollowIntent }));

/** Add the invitation inbox and private following journal without changing authored module objects. */
export function addSharedContextModule(
  definition : ModuleDefinition,
  codecs : RecordCodecMap,
): { definition: ModuleDefinition; codecs: RecordCodecMap } {
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
export function hasSharedContextModule(definition: ModuleDefinition, codecs: RecordCodecMap): boolean {
  const shared = createSharedContextFragment();
  return codecs[CONTEXT_INVITATION_PATH] === contextInvitationCodec
    && codecs[CONTEXT_FOLLOW_PATH] === contextFollowCodec
    && SHARED_CONTEXT_PATHS.every(path =>
      installedModuleDefinitionsEqual(definition.types[path], shared.types[path])
      && installedModuleDefinitionsEqual(definition.structure[path], shared.structure[path]));
}

/** Reject collisions even when only the type or structure path was authored. */
export function assertSharedContextNamesAvailable(definition: ModuleDefinition): void {
  for (const path of SHARED_CONTEXT_PATHS) {
    if (Object.hasOwn(definition.types, path) || Object.hasOwn(definition.structure, path)) {
      const purpose = path === CONTEXT_FOLLOW_PATH ? 'following' : 'invitations';
      throw new TypeError(`defineModule: '${path}' is reserved for shared-context ${purpose}.`);
    }
  }
}

/** Validate one decoded invitation without trusting peer-authored application data. */
function isContextInvitationEnvelope(value: unknown): value is ContextInvitationEnvelope {
  if (!isObject(value)
    || typeof value.contextId !== 'string'
    || value.contextId.length === 0
    || !isCanonicalModulePath(value.path)
    || !isObject(value.preview)) {
    return false;
  }
  return Object.values(value.preview).every(entry => typeof entry === 'string');
}

/** Validate stored intent coordinates before resolving its module context root. */
export function isContextFollowIntent(value: unknown): value is ContextFollowIntent {
  return isObject(value)
    && typeof value.ownerDid === 'string'
    && Did.parse(value.ownerDid)?.uri === value.ownerDid
    && isValidRecordContextId(value.contextId)
    && (value.following === false || (value.following === true
      && isCanonicalModulePath(value.path)));
}

function isCanonicalModulePath(value: unknown): value is string {
  return typeof value === 'string' && value.split('/').every(segment => segment !== '' && !segment.startsWith('$'));
}

/** Return the collision-safe identity for one owner-scoped module context. */
export function moduleContextKey(ownerDid: string, contextId: string): string {
  return JSON.stringify([ownerDid, contextId]);
}

function isObject(value: unknown): value is globalThis.Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Each effective module owns fresh fragments so application changes cannot alter another module. */
function createSharedContextFragment(): Pick<ModuleDefinition, 'types' | 'structure'> {
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
