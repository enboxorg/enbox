/**
 * Identity import flows.
 *
 * - Import from PortableIdentity JSON.
 * @module
 */

import type { AgentSession } from '@enbox/agent';
import type { FlowContext } from './lifecycle.js';
import type { ImportFromPortableOptions } from '../types.js';

import { finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, startSyncInBackgroundIfEnabled } from './lifecycle.js';

/**
 * Import an identity from a PortableIdentity JSON object.
 *
 * The portable identity contains the DID's private keys and metadata,
 * allowing it to be used on this device.
 */
export async function importFromPortable(
  ctx: FlowContext,
  options: ImportFromPortableOptions,
): Promise<AgentSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;
  const identitySyncProtocols = options.identitySyncProtocols ?? ctx.defaultIdentitySyncProtocols;
  ctx.assertActive();

  const identity = await ctx.runMutation(() => userAgent.identity.import({
    portableIdentity: options.portableIdentity,
  }));

  const { connectedDid, delegateDid } = resolveIdentityDids(identity);

  return ctx.commitSession(async (): Promise<AgentSession> => {
    // Register sync. For delegates, derive scope from grants (not 'all').
    if (delegateDid !== undefined || sync !== 'off') {
      await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid, identitySyncProtocols });
    }

    // Persist session info and build the AgentSession for the manager to publish.
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
