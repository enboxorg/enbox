/**
 * Identity import flows.
 *
 * - Import from PortableIdentity JSON.
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { ImportFromPortableOptions } from '../types.js';

import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, startSyncIfEnabled } from './lifecycle.js';

/**
 * Import an identity from a PortableIdentity JSON object.
 *
 * The portable identity contains the DID's private keys and metadata,
 * allowing it to be used on this device.
 */
export async function importFromPortable(
  ctx: FlowContext,
  options: ImportFromPortableOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;

  const identity = await userAgent.identity.import({
    portableIdentity: options.portableIdentity,
  });

  const { connectedDid, delegateDid } = resolveIdentityDids(identity);

  // Register with DWN endpoints (if registration options are provided).
  // For portable imports, extract endpoints from the DID document's DWN service.
  if (ctx.registration) {
    const dwnEndpoints = ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
    await registerWithDwnEndpoints(
      {
        userAgent   : userAgent,
        dwnEndpoints,
        agentDid    : userAgent.agentDid.uri,
        connectedDid,
        secretStore : userAgent.secrets,
        storage     : storage,
      },
      ctx.registration,
    );
  }

  // Register sync. For delegates, derive scope from grants (not 'all').
  if (delegateDid) {
    await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid });
  } else if (sync !== 'off') {
    await registerSyncScopeForIdentity({ userAgent, connectedDid });
  }

  await startSyncIfEnabled(userAgent, sync);

  // Persist session info, build AuthSession, and emit lifecycle events.
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
  });
}
