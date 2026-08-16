import type { DwnInterface } from './types/dwn.js';
import type { PermissionsApi } from './types/permissions.js';

import { PermissionGrantNotFoundError } from './permissions-api.js';

/**
 * Resolves the delegate permission grant ID authorizing a DWN request.
 *
 * Owner requests and delegated requests without a matching grant return
 * `undefined`, allowing callers to fall back to public/owner authorization.
 * Only the expected missing-grant result is swallowed; storage, network,
 * revocation, and parsing failures continue to surface.
 */
export async function resolveDelegatePermissionGrantId(
  deps: { did: string; delegateDid?: string; permissionsApi?: PermissionsApi },
  messageType: DwnInterface,
  protocol: string,
): Promise<string | undefined> {
  if (deps.delegateDid === undefined || deps.permissionsApi === undefined) {
    return undefined;
  }

  try {
    const { grant } = await deps.permissionsApi.getPermissionForRequest({
      connectedDid : deps.did,
      delegateDid  : deps.delegateDid,
      protocol,
      messageType,
    });
    return grant.id;
  } catch (error: unknown) {
    if (error instanceof PermissionGrantNotFoundError) {
      return undefined;
    }
    throw error;
  }
}
