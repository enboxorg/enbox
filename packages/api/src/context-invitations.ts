import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from './record-codec.js';

import { installedProtocolDefinitionsEqual } from './protocol-definition-utils.js';
import { recordCodecs } from './record-codec.js';

/** Reserved record type used by the shared-context invitation inbox. */
export const CONTEXT_INVITATION_PATH = 'enboxContextInvitation';

/** Small, non-sensitive application metadata displayed before a context is accepted. */
export type ContextInvitationPreview = Readonly<globalThis.Record<string, string>>;

/** Data stored in one signed invitation record. */
type ContextInvitationEnvelope = Readonly<{
  contextId: string;
  group: string;
  preview: ContextInvitationPreview;
}>;

const CONTEXT_INVITATION_SCHEMA = 'https://enbox.id/schemas/context-invitation';
const CONTEXT_INVITATION_DATA_FORMAT = 'application/json';

export const contextInvitationCodec = Object.freeze(recordCodecs.json<ContextInvitationEnvelope>());

/** Add the isolated invitation inbox to a copied application protocol definition. */
export function addContextInvitationProtocol(
  definition : ProtocolDefinition,
  codecs : RecordCodecMap,
): { definition: ProtocolDefinition; codecs: RecordCodecMap } {
  return {
    definition: {
      ...definition,
      types: {
        ...definition.types,
        [CONTEXT_INVITATION_PATH]: contextInvitationType(),
      },
      structure: {
        ...definition.structure,
        [CONTEXT_INVITATION_PATH]: contextInvitationRule(),
      },
    },
    codecs: {
      ...codecs,
      [CONTEXT_INVITATION_PATH]: contextInvitationCodec,
    },
  };
}

/** Confirm that a typed protocol's effective definition contains the reserved inbox exactly once. */
export function hasContextInvitationProtocol(
  definition : ProtocolDefinition,
  codecs : RecordCodecMap,
): boolean {
  const type = definition.types[CONTEXT_INVITATION_PATH];
  const rule = definition.structure[CONTEXT_INVITATION_PATH];
  return installedProtocolDefinitionsEqual(type, contextInvitationType())
    && installedProtocolDefinitionsEqual(rule, contextInvitationRule())
    && codecs[CONTEXT_INVITATION_PATH] === contextInvitationCodec;
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

/** Reject collisions even when only one side of the reserved path was declared. */
export function assertContextInvitationNameAvailable(definition: ProtocolDefinition): void {
  if (Object.hasOwn(definition.types, CONTEXT_INVITATION_PATH)
    || Object.hasOwn(definition.structure, CONTEXT_INVITATION_PATH)) {
    throw new TypeError(
      `defineProtocol: '${CONTEXT_INVITATION_PATH}' is reserved for shared-context invitations.`,
    );
  }
}

function isObject(value: unknown): value is globalThis.Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contextInvitationType(): ProtocolDefinition['types'][string] {
  return {
    schema      : CONTEXT_INVITATION_SCHEMA,
    dataFormats : [CONTEXT_INVITATION_DATA_FORMAT],
  };
}

/**
 * `who: 'anyone'` is load-bearing: a stranger must be able to offer a context
 * before any relationship exists. It also makes this an open write endpoint.
 * `$size` and `$immutable` bound each record, but the record COUNT is
 * deliberately uncapped: a global `$recordLimit` would let one writer fill the
 * cap and block real invitations, and per-author limits do not help because
 * fresh DIDs are free. Discovery therefore treats the inbox as untrusted and
 * bounded input — see `projectContextInvitations`. Closing the exposure needs
 * an admission decision Enbox does not have yet; do not "fix" it with a cap.
 */
function contextInvitationRule(): ProtocolDefinition['structure'][string] {
  return {
    $immutable : true,
    $size      : { max: 8_192 },
    $actions   : [{ who: 'anyone', can: ['create'] }],
  };
}
