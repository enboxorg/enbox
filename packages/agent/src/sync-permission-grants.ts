import type { DwnInterface } from './types/dwn.js';
import type { GenericMessage, GenericSignaturePayload, MessagesPermissionScope, RecordsProjectionScope } from '@enbox/dwn-sdk-js';
import type { NonEmptyStringArray, SyncAuthorizationGrant, SyncScope } from './types/sync.js';
import type { PermissionGrantEntry, PermissionsApi } from './types/permissions.js';

import { Jws, Message, PermissionScopeMatcher } from '@enbox/dwn-sdk-js';

import { lexicographicalCompare, syncScopeFromRecordsProjectionScopes } from './types/sync.js';

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
 * Broad protocol coverage remains on StateIndex full/protocol roots. Exact
 * protocolPath and contextId grants are grouped into a Records-primary
 * projection target so a narrow grant never authorizes a broad protocol root.
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

  if (requestedScope.kind === 'protocolSet') {
    return resolveProtocolSetScope(permissionGrants, requestedScope, messageType);
  }

  return [resolveRecordsProjectionScope(permissionGrants, requestedScope, messageType)];
}

function resolveFullScope(
  permissionGrants: PermissionGrantEntry[],
  requestedScope: Extract<SyncScope, { kind: 'full' }>,
  messageType: DwnInterface,
): MessagesSyncScopeResolution {
  const grants = permissionGrants
    .filter(entry => grantMatchesProtocol(entry, undefined))
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
): MessagesSyncScopeResolution[] {
  const broadProtocols: string[] = [];
  const narrowScopes: RecordsProjectionScope[] = [];

  for (const protocol of requestedScope.protocols) {
    if (permissionGrants.some(entry => grantMatchesProtocol(entry, protocol))) {
      broadProtocols.push(protocol);
      continue;
    }

    const protocolNarrowScopes = permissionGrants
      .map(entry => grantProjectionScopeForProtocol(entry, protocol))
      .filter((scope): scope is RecordsProjectionScope => scope !== undefined);
    if (protocolNarrowScopes.length === 0) {
      throw new Error(`SyncPermissions: No active Messages.Read permission found for ${messageType}: ${protocol}`);
    }
    narrowScopes.push(...protocolNarrowScopes);
  }

  return [
    ...broadProtocolResolution(permissionGrants, broadProtocols),
    ...recordsProjectionResolution(permissionGrants, narrowScopes, messageType),
  ];
}

function resolveRecordsProjectionScope(
  permissionGrants: PermissionGrantEntry[],
  requestedScope: Extract<SyncScope, { kind: 'recordsProjection' }>,
  messageType: DwnInterface,
): MessagesSyncScopeResolution {
  if (!requestedScope.scopes.every(scope => isProjectionScopeCovered(permissionGrants, scope))) {
    throw new Error(`SyncPermissions: No active Messages.Read permission found for ${messageType}: projected Records scope`);
  }

  const grants = permissionGrants
    .filter(entry => requestedScope.scopes.some(scope => PermissionScopeMatcher.matches(entry.grant.scope, scope)))
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));

  return { scope: requestedScope, permissionGrants: grants };
}

function isProjectionScopeCovered(
  permissionGrants: PermissionGrantEntry[],
  scope: RecordsProjectionScope,
): boolean {
  return permissionGrants.some(entry => PermissionScopeMatcher.matches(entry.grant.scope, scope));
}

function broadProtocolResolution(
  permissionGrants: PermissionGrantEntry[],
  broadProtocols: string[],
): MessagesSyncScopeResolution[] {
  if (broadProtocols.length === 0) {
    return [];
  }

  const protocols = [...new Set(broadProtocols)].sort(lexicographicalCompare) as NonEmptyStringArray;
  const grants = permissionGrants
    .filter(entry => grantParticipatesInProtocolSet(entry, protocols))
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));

  return [{
    scope: {
      kind: 'protocolSet',
      protocols,
    },
    permissionGrants: grants,
  }];
}

function recordsProjectionResolution(
  permissionGrants: PermissionGrantEntry[],
  projectionScopes: RecordsProjectionScope[],
  messageType: DwnInterface,
): MessagesSyncScopeResolution[] {
  const [firstScope, ...remainingScopes] = projectionScopes;
  if (firstScope === undefined) {
    return [];
  }

  const requestedScope = syncScopeFromRecordsProjectionScopes([firstScope, ...remainingScopes]);
  return [resolveRecordsProjectionScope(permissionGrants, requestedScope, messageType)];
}

function grantProjectionScopeForProtocol(
  entry: PermissionGrantEntry,
  protocol: string,
): RecordsProjectionScope | undefined {
  const scope = entry.grant.scope;
  if (!isMessagesReadScope(scope) || scope.protocol !== protocol) {
    return undefined;
  }
  if (scope.protocolPath !== undefined) {
    return { protocol, protocolPath: scope.protocolPath };
  }
  if (scope.contextId !== undefined) {
    return { protocol, contextId: scope.contextId };
  }
}

function isMessagesReadScope(scope: PermissionGrantEntry['grant']['scope']): scope is MessagesPermissionScope {
  return scope.interface === 'Messages' &&
    scope.method === 'Read';
}

function grantParticipatesInProtocolSet(
  entry: PermissionGrantEntry,
  protocols: NonEmptyStringArray,
): boolean {
  return protocols.some(protocol => grantMatchesProtocol(entry, protocol));
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
