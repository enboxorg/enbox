import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordCodecMap } from './record-codec.js';
import type { RecordView, RecordViewState } from './record-view.js';

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

/** Immutable state of one protocol's pending context invitations. */
export type ContextInvitationViewState<Invitation> = Readonly<{
  invitations: readonly Invitation[];
}> & Readonly<
  | { status: 'loading' | 'ready' | 'stale'; error?: never }
  | { status: 'error'; error: Error }
>;

/** Closeable materialized view of pending shared-context invitations. */
export interface ContextInvitationView<Invitation> {
  getState: () => ContextInvitationViewState<Invitation>;
  subscribe(listener: (state: ContextInvitationViewState<Invitation>) => void): () => void;
  close(): Promise<void>;
}

const CONTEXT_INVITATION_SCHEMA = 'https://enbox.id/schemas/context-invitation';
const CONTEXT_INVITATION_DATA_FORMAT = 'application/json';

export const contextInvitationCodec = Object.freeze(recordCodecs.json<ContextInvitationEnvelope>());

/** Rename the generic records collection at the invitation boundary without copying its lifecycle. */
export function projectContextInvitationView<Invitation>(
  view: RecordView<Invitation>,
): ContextInvitationView<Invitation> {
  const project = (state: RecordViewState<Invitation>): ContextInvitationViewState<Invitation> => Object.freeze({
    ...(state.status === 'error' ? { error: state.error } : {}),
    invitations : state.records,
    status      : state.status,
  }) as ContextInvitationViewState<Invitation>;

  let source = view.getState();
  let state = project(source);
  const update = (next: RecordViewState<Invitation>): ContextInvitationViewState<Invitation> => {
    if (next !== source) {
      source = next;
      state = project(next);
    }
    return state;
  };

  return Object.freeze({
    close     : (): Promise<void> => view.close(),
    getState  : (): ContextInvitationViewState<Invitation> => update(view.getState()),
    subscribe : (listener: (state: ContextInvitationViewState<Invitation>) => void): (() => void) =>
      view.subscribe(next => { listener(update(next)); }),
  });
}

/** Add the isolated invitation inbox to a copied application protocol definition. */
export function addContextInvitationProtocol(
  definition : ProtocolDefinition,
  codecs : RecordCodecMap,
): { definition: ProtocolDefinition; codecs: RecordCodecMap } {
  assertContextInvitationNameAvailable(definition);
  return {
    definition: {
      ...definition,
      types: {
        ...definition.types,
        [CONTEXT_INVITATION_PATH]: {
          schema      : CONTEXT_INVITATION_SCHEMA,
          dataFormats : [CONTEXT_INVITATION_DATA_FORMAT],
        },
      },
      structure: {
        ...definition.structure,
        [CONTEXT_INVITATION_PATH]: {
          $immutable : true,
          $size      : { max: 8_192 },
          $actions   : [{ who: 'anyone', can: ['create'] }],
        },
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
  const action = rule?.$actions?.[0];
  return hasExactKeys(type, ['schema', 'dataFormats'])
    && type.schema === CONTEXT_INVITATION_SCHEMA
    && type.dataFormats?.length === 1
    && type.dataFormats[0] === CONTEXT_INVITATION_DATA_FORMAT
    && hasExactKeys(rule, ['$immutable', '$size', '$actions'])
    && rule.$immutable === true
    && hasExactKeys(rule.$size, ['max'])
    && rule.$size?.max === 8_192
    && rule.$actions?.length === 1
    && hasExactKeys(action, ['who', 'can'])
    && action.who === 'anyone'
    && action.can.length === 1
    && action.can[0] === 'create'
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

function hasExactKeys(value: unknown, keys: readonly string[]): value is globalThis.Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
