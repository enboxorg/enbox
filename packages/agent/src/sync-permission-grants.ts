import type { DwnInterface } from './types/dwn.js';
import type { GenericMessage, GenericSignaturePayload, MessagesPermissionScope } from '@enbox/dwn-sdk-js';
import type { NonEmptyStringArray, SyncAuthorizationGrant, SyncScope } from './types/sync.js';
import type { PermissionGrantEntry, PermissionsApi } from './types/permissions.js';

import { Jws, Message } from '@enbox/dwn-sdk-js';

import { lexicographicalCompare } from './types/sync.js';

export type MessagesSyncScopeResolution = {
  scope: SyncScope;
  permissionGrants: PermissionGrantEntry[];
};

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
 * requires each requested protocol root to be covered by an active
 * Messages.Read grant, then invokes every active grant that participates in
 * that root set. This keeps the authorization epoch tied to grant churn
 * without widening the CID set being compared.
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
  messageType: DwnInterface;
  permissionsApi: PermissionsApi;
}): Promise<PermissionGrantEntry[]> {
  const requestedScope: SyncScope = protocols === undefined
    ? { kind: 'full' }
    : { kind: 'protocolSet', protocols };
  const resolutions = await resolveMessagesSyncScopes({
    did,
    delegateDid,
    requestedScope,
    messageType,
    permissionsApi,
  });
  return resolutions
    .flatMap(resolution => resolution.permissionGrants)
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));
}

/**
 * Resolves active Messages.Read grants into one or more sync targets.
 *
 * Full/protocol sync only compares StateIndex roots. Exact protocolPath and
 * contextId grants do not authorize those roots because they cover a strict
 * subset that this sync mechanism no longer tries to project.
 */
export async function resolveMessagesSyncScopes({
  did,
  delegateDid,
  requestedScope,
  messageType,
  permissionsApi,
}: {
  did: string;
  delegateDid?: string;
  requestedScope: SyncScope;
  messageType: DwnInterface;
  permissionsApi: PermissionsApi;
}): Promise<MessagesSyncScopeResolution[]> {
  if (!delegateDid) {
    return [{ scope: requestedScope, permissionGrants: [] }];
  }

  const now = new Date().toISOString();
  const permissionGrants = (await permissionsApi.fetchGrants({
    author  : delegateDid,
    target  : delegateDid,
    grantor : did,
    grantee : delegateDid,
  })).filter(entry => isActiveMessagesGrant(entry, did, delegateDid, now));

  if (requestedScope.kind === 'full') {
    return [resolveFullScope(permissionGrants, requestedScope, messageType)];
  }

  return [resolveProtocolSetScope(permissionGrants, requestedScope, messageType)];
}

function resolveFullScope(
  permissionGrants: PermissionGrantEntry[],
  requestedScope: Extract<SyncScope, { kind: 'full' }>,
  messageType: DwnInterface,
): MessagesSyncScopeResolution {
  const grants = permissionGrants
    .filter(grantMatchesFullRoot)
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));
  if (grants.length === 0) {
    throw new Error(`SyncPermissions: No active Messages.Read permission found for ${messageType}: all protocols`);
  }

  return { scope: requestedScope, permissionGrants: grants };
}

function resolveProtocolSetScope(
  permissionGrants: PermissionGrantEntry[],
  requestedScope: Extract<SyncScope, { kind: 'protocolSet' }>,
  messageType: DwnInterface,
): MessagesSyncScopeResolution {
  for (const protocol of requestedScope.protocols) {
    if (permissionGrants.some(entry => grantMatchesProtocolRoot(entry, protocol))) {
      continue;
    }

    throw new Error(`SyncPermissions: No active protocol-root Messages.Read permission found for ${messageType}: ${protocol}`);
  }

  const grants = permissionGrants
    .filter(entry => grantParticipatesInProtocolSet(entry, requestedScope.protocols))
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));

  return { scope: requestedScope, permissionGrants: grants };
}

function isMessagesReadScope(scope: PermissionGrantEntry['grant']['scope']): scope is MessagesPermissionScope {
  return scope.interface === 'Messages' &&
    scope.method === 'Read';
}

function grantParticipatesInProtocolSet(
  entry: PermissionGrantEntry,
  protocols: NonEmptyStringArray,
): boolean {
  return protocols.some(protocol => grantMatchesProtocolRoot(entry, protocol));
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

function grantMatchesFullRoot(entry: PermissionGrantEntry): boolean {
  const scope = entry.grant.scope;
  return isMessagesReadScope(scope) &&
    scope.protocol === undefined;
}

function grantMatchesProtocolRoot(
  entry: PermissionGrantEntry,
  protocol: string,
): boolean {
  const scope = entry.grant.scope;
  return isMessagesReadScope(scope) && (
    scope.protocol === undefined ||
    (
      scope.protocol === protocol &&
      scope.protocolPath === undefined &&
      scope.contextId === undefined
    )
  );
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
