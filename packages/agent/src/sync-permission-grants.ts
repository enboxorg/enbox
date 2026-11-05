import type { DwnInterface } from './types/dwn.js';
import type { GenericMessage, GenericSignaturePayload, MessagesPermissionScope } from '@enbox/dwn-sdk-js';
import type { NonEmptyStringArray, SyncAuthorizationGrant, syncScopeFromModules } from './types/sync.js';
import type { PermissionGrantEntry, PermissionsApi } from './types/permissions.js';

import { Jws, Message } from '@enbox/dwn-sdk-js';

import { lexicographicalCompare } from './types/sync.js';

type IdentitySyncScope = ReturnType<typeof syncScopeFromModules>;

export type MessagesScopeResolution = {
  scope: IdentitySyncScope;
  permissionGrants: PermissionGrantEntry[];
};

export class SyncModuleRootPermissionGrantMissingError extends Error {
  public readonly module?: string;

  public constructor(messageType: DwnInterface, module?: string) {
    super(module === undefined
      ? `SyncPermissions: No active Messages.Read permission found for ${messageType}: all modules`
      : `SyncPermissions: No active module-root Messages.Read permission found for ${messageType}: ${module}`);
    this.name = 'SyncModuleRootPermissionGrantMissingError';
    this.module = module;
  }
}

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
 * Owner-authored Messages feed access does not invoke grants. Delegate full
 * scope requires at least one active unscoped Messages.Read grant. Delegate
 * module-set scope requires each requested module root to be covered by an
 * active Messages.Read grant, then invokes every active grant that participates
 * in that root set. This keeps the authorization epoch tied to grant churn
 * without widening the CID set being compared.
 */
export async function getMessagesPermissionGrantsForScope({
  did,
  delegateDid,
  modules,
  messageType,
  permissionsApi,
}: {
  did: string;
  delegateDid?: string;
  modules?: NonEmptyStringArray;
  messageType: DwnInterface;
  permissionsApi: PermissionsApi;
}): Promise<PermissionGrantEntry[]> {
  const requestedScope: IdentitySyncScope = modules === undefined
    ? { kind: 'full' }
    : { kind: 'moduleSet', modules };
  const resolutions = await resolveMessagesScopes({
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
 * Resolves active Messages.Read grants into one or more Messages feed scopes.
 *
 * Exact modulePath and contextId grants do not authorize root log scopes
 * because they cover a strict subset of the messages in those scopes.
 */
export async function resolveMessagesScopes({
  did,
  delegateDid,
  requestedScope,
  messageType,
  permissionsApi,
}: {
  did: string;
  delegateDid?: string;
  requestedScope: IdentitySyncScope;
  messageType: DwnInterface;
  permissionsApi: PermissionsApi;
}): Promise<MessagesScopeResolution[]> {
  if (!delegateDid) {
    return [{ scope: requestedScope, permissionGrants: [] }];
  }

  const now = new Date().toISOString();
  const permissionGrants = (await permissionsApi.fetchGrants({
    author       : delegateDid,
    target       : delegateDid,
    grantor      : did,
    grantee      : delegateDid,
    checkRevoked : true,
  })).filter(entry => isActiveMessagesGrant(entry, did, delegateDid, now));

  if (requestedScope.kind === 'full') {
    return [resolveFullScope(permissionGrants, requestedScope, messageType)];
  }

  return [resolveModuleSetScope(permissionGrants, requestedScope, messageType)];
}

function resolveFullScope(
  permissionGrants: PermissionGrantEntry[],
  requestedScope: Extract<IdentitySyncScope, { kind: 'full' }>,
  messageType: DwnInterface,
): MessagesScopeResolution {
  const grants = permissionGrants
    .filter(grantMatchesFullRoot)
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));
  if (grants.length === 0) {
    throw new SyncModuleRootPermissionGrantMissingError(messageType);
  }

  return { scope: requestedScope, permissionGrants: grants };
}

function resolveModuleSetScope(
  permissionGrants: PermissionGrantEntry[],
  requestedScope: Extract<IdentitySyncScope, { kind: 'moduleSet' }>,
  messageType: DwnInterface,
): MessagesScopeResolution {
  for (const module of requestedScope.modules) {
    if (permissionGrants.some(entry => grantMatchesModuleRoot(entry, module))) {
      continue;
    }

    throw new SyncModuleRootPermissionGrantMissingError(messageType, module);
  }

  const grants = permissionGrants
    .filter(entry => grantParticipatesInModuleSet(entry, requestedScope.modules))
    .sort((a, b) => lexicographicalCompare(a.grant.id, b.grant.id));

  return { scope: requestedScope, permissionGrants: grants };
}

function isMessagesReadScope(scope: PermissionGrantEntry['grant']['scope']): scope is MessagesPermissionScope {
  return scope.interface === 'Messages' &&
    scope.method === 'Read';
}

function grantParticipatesInModuleSet(
  entry: PermissionGrantEntry,
  modules: NonEmptyStringArray,
): boolean {
  return modules.some(module => grantMatchesModuleRoot(entry, module));
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
    scope.module === undefined &&
    scope.modulePath === undefined &&
    scope.contextId === undefined;
}

function grantMatchesModuleRoot(
  entry: PermissionGrantEntry,
  module: string,
): boolean {
  if (grantMatchesFullRoot(entry)) {
    return true;
  }

  const scope = entry.grant.scope;
  return isMessagesReadScope(scope) &&
    scope.module === module &&
    scope.modulePath === undefined &&
    scope.contextId === undefined;
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
