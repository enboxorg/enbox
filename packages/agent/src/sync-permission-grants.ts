import type { DwnInterface } from './types/dwn.js';
import type { GenericMessage, GenericSignaturePayload } from '@enbox/dwn-sdk-js';
import type { NonEmptyStringArray, SyncAuthorizationGrant } from './types/sync.js';
import type { PermissionGrantEntry, PermissionsApi } from './types/permissions.js';

import { Jws, Message, PermissionScopeMatcher } from '@enbox/dwn-sdk-js';

import { lexicographicalCompare } from './types/sync.js';
/** Returns a sorted, duplicate-free grant ID set, or `undefined` for owner requests. */
export function toMessagesPermissionGrantIds(permissionGrantIds: string[] | undefined): NonEmptyStringArray | undefined {
  if (permissionGrantIds === undefined || permissionGrantIds.length === 0) {
    return undefined;
  }
  return [...new Set(permissionGrantIds)].sort(lexicographicalCompare) as NonEmptyStringArray;
}

/**
 * Gets the active permission grant IDs that authorize a Messages operation.
 *
 * Owner-authored sync does not invoke grants. Delegate full sync requires at
 * least one active unscoped Messages.Read grant. Delegate protocol-set sync
 * requires each requested protocol to be covered by an active Messages.Read
 * grant, then invokes every active grant that participates in the projection.
 * This keeps the authorization epoch tied to grant churn without widening the
 * CID projection being compared.
 */
export async function getMessagesPermissionGrantsForScope({
  did,
  delegateDid,
  protocols,
  messageType,
  permissionsApi,
}: {
  did: string;
  delegateDid?: string;
  protocols?: NonEmptyStringArray;
  messageType: DwnInterface.MessagesRead | DwnInterface.MessagesSubscribe | DwnInterface.MessagesSync;
  permissionsApi: PermissionsApi;
}): Promise<PermissionGrantEntry[]> {
  if (!delegateDid) {
    return [];
  }

  const now = new Date().toISOString();
  const permissionGrants = (await permissionsApi.fetchGrants({
    author  : delegateDid,
    target  : delegateDid,
    grantor : did,
    grantee : delegateDid,
  })).filter(entry => isActiveMessagesGrant(entry, did, delegateDid, now));

  const requestedProtocols = protocols ?? [undefined];
  for (const protocol of requestedProtocols) {
    if (!permissionGrants.some(entry => grantMatchesProtocol(entry, protocol))) {
      throw new Error(`SyncPermissions: No active Messages.Read permission found for ${messageType}: ${protocol ?? 'all protocols'}`);
    }
  }

  return permissionGrants
    .filter(entry => grantParticipatesInProjection(entry, protocols))
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));
}

/** Converts permission grant entries into authorization epoch inputs. */
export function toSyncAuthorizationGrants(permissionGrants: PermissionGrantEntry[]): [SyncAuthorizationGrant, ...SyncAuthorizationGrant[]] {
  if (permissionGrants.length === 0) {
    throw new Error('SyncPermissions: delegate authorization requires at least one grant.');
  }
  return permissionGrants
    .map(({ grant }) => ({
      dateExpires : grant.dateExpires,
      dateGranted : grant.dateGranted,
      id          : grant.id,
    }))
    .sort((a, b) => lexicographicalCompare(a.id, b.id)) as [SyncAuthorizationGrant, ...SyncAuthorizationGrant[]];
}

function isActiveMessagesGrant(
  entry: PermissionGrantEntry,
  grantor: string,
  grantee: string,
  now: string,
): boolean {
  const { grant } = entry;
  if (grant.grantor !== grantor || grant.grantee !== grantee) {
    return false;
  }

  if (grant.dateGranted > now || grant.dateExpires <= now) {
    return false;
  }

  const scope = grant.scope;
  return scope.interface === 'Messages' &&
    scope.method === 'Read';
}

function grantMatchesProtocol(
  entry: PermissionGrantEntry,
  protocol: string | undefined,
): boolean {
  return PermissionScopeMatcher.matches(entry.grant.scope, { protocol });
}

function grantParticipatesInProjection(
  entry: PermissionGrantEntry,
  protocols: NonEmptyStringArray | undefined,
): boolean {
  return (protocols ?? [undefined]).some(protocol => grantMatchesProtocol(entry, protocol));
}

/** Returns sorted grant IDs from permission grant entries. */
export function permissionGrantIdsFromEntries(permissionGrants: PermissionGrantEntry[]): NonEmptyStringArray | undefined {
  return toMessagesPermissionGrantIds(permissionGrants.map(entry => entry.grant.id));
}

/**
 * Returns the permission grant IDs invoked by a message.
 *
 * Real DWN messages use the author signature payload as the source of truth.
 */
export function getInvokedPermissionGrantIds(message: GenericMessage): string[] {
  if (message.authorization === undefined) {
    return [];
  }

  try {
    const signaturePayload = Jws.decodePlainObjectPayload(message.authorization.signature) as GenericSignaturePayload;
    return Message.getPermissionGrantIds(signaturePayload);
  } catch {
    return [];
  }
}
