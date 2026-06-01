import type { DwnInterface } from './types/dwn.js';
import type { PermissionsApi } from './types/permissions.js';
import type { GenericMessage, GenericSignaturePayload } from '@enbox/dwn-sdk-js';

import { Jws, Message } from '@enbox/dwn-sdk-js';

/**
 * Converts the sync planner's current single selected grant into the Messages
 * wire shape. MessagesRead, MessagesSubscribe, and MessagesSync always carry
 * grant invocations as `permissionGrantIds`.
 */
export function toMessagesPermissionGrantIds(permissionGrantId: string | undefined): string[] | undefined {
  // TODO(sync Phase 5): current sync requests resolve one grant per scoped request.
  // Replace this boundary adapter when canonical scope-union sync builds true grant sets.
  return permissionGrantId === undefined ? undefined : [permissionGrantId];
}

/**
 * Gets the permission grant ID for a single-scope Messages operation.
 * Owner-authored requests do not need a grant, so no delegate DID returns
 * `undefined`.
 */
export async function getMessagesPermissionGrantId({
  did,
  delegateDid,
  protocol,
  messageType,
  permissionsApi,
}: {
  did: string;
  delegateDid?: string;
  protocol?: string;
  messageType: DwnInterface.MessagesRead | DwnInterface.MessagesSubscribe | DwnInterface.MessagesSync;
  permissionsApi: PermissionsApi;
}): Promise<string | undefined> {
  if (!delegateDid) {
    return undefined;
  }

  const grant = await permissionsApi.getPermissionForRequest({
    connectedDid : did,
    messageType,
    delegateDid,
    protocol,
    cached       : true
  });
  return grant.grant.id;
}

/**
 * Returns the permission grant IDs invoked by a message.
 *
 * Real DWN messages use the author signature payload as the source of truth.
 * Unsigned in-memory fixtures fall back to descriptor fields so dependency
 * helpers can remain small and deterministic in unit tests.
 */
export function getInvokedPermissionGrantIds(message: GenericMessage): string[] {
  if (message.authorization === undefined) {
    return Message.getPermissionGrantIds(message.descriptor as unknown as GenericSignaturePayload);
  }

  try {
    const signaturePayload = Jws.decodePlainObjectPayload(message.authorization.signature) as GenericSignaturePayload;
    return Message.getPermissionGrantIds(signaturePayload);
  } catch {
    return [];
  }
}
