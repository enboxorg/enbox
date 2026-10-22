/**
 * Identity import flows.
 *
 * - Import from PortableIdentity JSON.
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { ImportFromPortableOptions } from '../types.js';

import { assertFlowActive, commitFlowSession, finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, runFlowMutation, startSyncInBackgroundIfEnabled } from './lifecycle.js';

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
  const identitySyncProtocols = options.identitySyncProtocols ?? ctx.defaultIdentitySyncProtocols;
  assertFlowActive(ctx);

  const identity = await runFlowMutation(ctx, () => userAgent.identity.import({
    portableIdentity: options.portableIdentity,
  }));

  const { connectedDid, delegateDid } = resolveIdentityDids(identity);

  return commitFlowSession(ctx, async (): Promise<AuthSession> => {
    // Register sync. For delegates, derive scope from grants (not 'all').
    if (delegateDid !== undefined || sync !== 'off') {
      await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid, identitySyncProtocols });
    }

    // Persist session info and build the AuthSession for the manager to publish.
    const session = await finalizeSession({
      userAgent,
      emitter,
      storage,
      connectedDid,
      delegateDid,
      signal               : ctx.sessionSignal,
      identityName         : identity.metadata.name,
      identityConnectedDid : identity.metadata.connectedDid,
    });

    startSyncInBackgroundIfEnabled(userAgent, sync, ctx.sessionSignal);
    return session;
  });
}
