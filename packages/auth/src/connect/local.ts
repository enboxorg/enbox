/**
 * Local DID connect flow.
 *
 * Creates or reconnects a local identity with vault-protected keys.
 * This replaces the "Mode D/E" paths in Enbox.connect().
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { LocalConnectOptions } from '../types.js';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { createDefaultIdentity, ensureVaultReady, finalizeSession, resolveIdentityDids, resolvePassword, startSyncIfEnabled } from './lifecycle.js';

/**
 * Execute the local connect flow.
 *
 * - On first launch: initializes the vault, creates a new DID, returns recovery phrase.
 * - On subsequent launches: unlocks the vault and reconnects to the existing identity.
 */
export async function localConnect(
  ctx: FlowContext,
  options: LocalConnectOptions = {},
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;

  // Resolve password through the standard chain.
  const isFirstLaunch = await userAgent.firstLaunch();
  const password = await resolvePassword(ctx, options.password, isFirstLaunch);

  const sync = options.sync ?? ctx.defaultSync;
  const dwnEndpoints = options.dwnEndpoints ?? ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;

  // Initialize vault on first launch and start the agent.
  const recoveryPhrase = await ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch,
    recoveryPhrase: options.recoveryPhrase,
    dwnEndpoints,
  });

  // Apply local DWN discovery (browser redirect payload or persisted endpoint).
  // In remote mode, discovery already ran before agent creation — skip.
  if (!userAgent.dwn.isRemoteMode) {
    await applyLocalDwnDiscovery(userAgent, storage, emitter);
  }

  // Find or create the user identity.
  const identities = await userAgent.identity.list();
  let identity = identities[0];
  let isNewIdentity = false;

  if (!identity) {
    isNewIdentity = true;
    identity = await createDefaultIdentity(userAgent, dwnEndpoints, options.metadata?.name ?? 'Default');
  }

  const { connectedDid, delegateDid } = resolveIdentityDids(identity);

  // Register with DWN endpoints (if registration options are provided).
  if (ctx.registration) {
    await registerWithDwnEndpoints(
      {
        userAgent : userAgent,
        dwnEndpoints,
        agentDid  : userAgent.agentDid.uri,
        connectedDid,
        storage   : storage,
      },
      ctx.registration,
    );
  }

  // Register sync for new identities.
  if (isNewIdentity && sync !== 'off') {
    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : { delegateDid, protocols: [] },
    });
  }

  // Start sync.
  startSyncIfEnabled(userAgent, sync);

  // Persist session info, build AuthSession, and emit lifecycle events.
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    recoveryPhrase,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
  });
}
