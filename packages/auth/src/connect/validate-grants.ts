import type { ConnectPermissionRequest } from '@enbox/connect';
import type { ConnectResult } from '../types.js';
import type { DwnPermissionScope } from '@enbox/agent';

import { DwnPermissionGrant, DwnPermissionsProtocol } from '@enbox/agent';

/**
 * Validates that a wallet's connect result grants exactly what was requested.
 *
 * Every returned grant must target the delegate DID, and every grant scope —
 * session-revocation grants excluded via the `sessionRevocations` mapping —
 * must be a subset of a requested permission scope. A wallet that returns a
 * grant for a different grantee or a broader scope than requested fails the
 * connect, with an instruction to revoke the just-approved session (grants
 * are written to the owner's DWN at approve time, before the client can
 * check anything).
 *
 * Runs for every connect transport: the handler flow (browser popup, CLI
 * relay) and the direct relay flow alike.
 */
export function validateConnectResultGrants(
  result: ConnectResult,
  permissionRequests: ConnectPermissionRequest[],
): void {
  const delegateDid = result.delegatePortableDid.uri;
  const revocationGrantIds = new Map<string, string>();

  for (const revocation of result.sessionRevocations ?? []) {
    revocationGrantIds.set(revocation.revocationGrantId, revocation.grantId);
  }

  for (const grantMessage of result.delegateGrants) {
    const grant = DwnPermissionGrant.parse(grantMessage);

    if (grant.grantee !== delegateDid) {
      throw new Error(
        `[@enbox/auth] Wallet returned a grant for '${grant.grantee}', but the delegate DID is '${delegateDid}'. ` +
        'Revoke the approved session in your wallet.'
      );
    }

    if (isSessionRevocationGrant(grant, revocationGrantIds)) {
      continue;
    }

    if (!isRequestedScope(grant.scope, permissionRequests)) {
      throw new Error('[@enbox/auth] Wallet returned a grant outside the requested permission scope. Revoke the approved session in your wallet.');
    }
  }
}

function isSessionRevocationGrant(
  grant: ReturnType<typeof DwnPermissionGrant.parse>,
  revocationGrantIds: Map<string, string>,
): boolean {
  const revokedGrantId = revocationGrantIds.get(grant.id);
  if (revokedGrantId === undefined) {
    return false;
  }

  return grant.scope.interface === 'Records' &&
    grant.scope.method === 'Write' &&
    'protocol' in grant.scope &&
    grant.scope.protocol === DwnPermissionsProtocol.uri &&
    'contextId' in grant.scope &&
    grant.scope.contextId === revokedGrantId;
}

function isRequestedScope(grantScope: DwnPermissionScope, permissionRequests: ConnectPermissionRequest[]): boolean {
  return permissionRequests.some((permissionRequest) =>
    permissionRequest.permissionScopes.some((requestedScope) => isScopeSubset(grantScope, requestedScope))
  );
}

function isScopeSubset(grantScope: DwnPermissionScope, requestedScope: DwnPermissionScope): boolean {
  if (grantScope.interface !== requestedScope.interface || grantScope.method !== requestedScope.method) {
    return false;
  }

  const requested = requestedScope as Record<string, unknown>;
  const granted = grantScope as Record<string, unknown>;
  for (const [key, requestedValue] of Object.entries(requested)) {
    if (!isEqualScopeValue(granted[key], requestedValue)) {
      return false;
    }
  }

  return true;
}

function isEqualScopeValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (left === undefined || right === undefined) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}
