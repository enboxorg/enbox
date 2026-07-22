/**
 * Vault connect flow.
 *
 * Creates or reconnects a local identity with vault-protected keys.
 * Used by wallets and CLI tools that own the HD identity vault directly
 * (as opposed to handler-based connect, which delegates credential
 * acquisition to an external wallet).
 *
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { VaultConnectOptions } from '../types.js';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { assertFlowActive, commitFlowSession, createDefaultIdentity, ensureVaultReady, finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, resolvePassword, runFlowMutation, startSyncIfEnabled } from './lifecycle.js';
import { recoverIdentitiesFromRemote, registerAgentDidForSync } from './recovery.js';

/**
 * Execute the vault connect flow.
 *
 * - On first launch: initializes the vault. Identity creation is opt-in via
 *   `options.createIdentity: true`.
 * - On subsequent launches: unlocks the vault and reconnects to the existing identity.
 * - On recovery: when `recoveryPhrase` is provided on a fresh vault, pulls
 *   identities and their data from the remote DWN before optionally creating
 *   a default identity.
 *
 * When no identities exist and `createIdentity` is not `true`, the session
 * is returned with the **agent DID** as the connected DID. This allows apps to
 * manage identity creation separately from vault setup.
 */
export async function vaultConnect(
  ctx: FlowContext,
  options: VaultConnectOptions = {},
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  assertFlowActive(ctx);

  // Resolve password through the standard chain.
  const isFirstLaunch = await userAgent.firstLaunch();
  assertFlowActive(ctx);
  const password = await resolvePassword(ctx, options.password, isFirstLaunch);
  assertFlowActive(ctx);

  const sync = options.sync ?? ctx.defaultSync;
  const identitySyncProtocols = options.identitySyncProtocols ?? ctx.defaultIdentitySyncProtocols;
  const dwnEndpoints = options.dwnEndpoints ?? ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
  const shouldCreateIdentity = options.createIdentity === true;

  // Initialize vault on first launch and start the agent.
  const recoveryPhrase = await runFlowMutation(ctx, () => ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch,
    recoveryPhrase: options.recoveryPhrase,
    dwnEndpoints,
  }));

  // Apply a stored local-node pairing when the agent was created in local mode.
  // In remote mode, discovery already ran before agent creation — skip.
  if (!userAgent.dwn.isRemoteMode) {
    await runFlowMutation(ctx, () => applyLocalDwnDiscovery(userAgent, storage, emitter));
  }

  // Register the agent DID as a DWN tenant and for sync early — both are
  // prerequisites for seed phrase recovery and for normal push/pull of
  // identity metadata after identity creation.
  if (ctx.registration) {
    await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints,
        agentDid     : userAgent.agentDid.uri,
        connectedDid : userAgent.agentDid.uri,
        secretStore  : userAgent.secrets,
        storage,
        assertActive : ctx.assertActive,
        runMutation  : ctx.runMutation,
      },
      ctx.registration,
    );
    assertFlowActive(ctx);
  }
  if (sync !== 'off') {
    await runFlowMutation(ctx, () => registerAgentDidForSync(userAgent));
  }

  // Find existing identities.
  let identities = await userAgent.identity.list();
  let identity = identities[0];
  let isNewIdentity = false;

  // Seed phrase recovery: when a recovery phrase was provided and no identities exist locally,
  // pull them from the remote DWN before deciding whether to create a new identity.
  if (!identity && options.recoveryPhrase && sync !== 'off') {
    try {
      identities = await recoverIdentitiesFromRemote({
        userAgent,
        dwnEndpoints,
        identitySyncProtocols,
        registration : ctx.registration,
        storage,
        assertActive : ctx.assertActive,
        runMutation  : ctx.runMutation,
      });
      identity = identities[0];
    } catch (err) {
      console.warn('[@enbox/auth] Seed phrase recovery failed:', err);
    }
    assertFlowActive(ctx);
  }

  // Create a default identity if none were found or recovered and the caller asked for one.
  if (!identity && shouldCreateIdentity) {
    isNewIdentity = true;
    identity = await runFlowMutation(
      ctx,
      () => createDefaultIdentity(userAgent, dwnEndpoints, options.metadata?.name ?? 'Default'),
    );
  }

  // When no identity exists (createIdentity: false on first launch), use the
  // agent DID as the session's connected DID. The session is still valid but
  // operates in the agent's context rather than a user identity's context.
  const identityDids = identity ? resolveIdentityDids(identity) : undefined;
  const connectedDid = identityDids?.connectedDid ?? userAgent.agentDid.uri;
  const delegateDid = identityDids?.delegateDid;

  // Register the new identity DID as a tenant and for sync.
  // Tenant registration must come before sync registration — with live
  // sync active, registerIdentity hot-adds a subscription that needs
  // the DID to be a recognised tenant on the remote DWN.
  if (isNewIdentity && ctx.registration) {
    await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints,
        agentDid     : userAgent.agentDid.uri,
        connectedDid,
        secretStore  : userAgent.secrets,
        storage      : storage,
        assertActive : ctx.assertActive,
        runMutation  : ctx.runMutation,
      },
      ctx.registration,
    );
    assertFlowActive(ctx);
  }
  return commitFlowSession(ctx, async (): Promise<AuthSession> => {
    if (isNewIdentity && sync !== 'off') {
      await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid, identitySyncProtocols });
    } else if (!isNewIdentity && delegateDid) {
      // Persisted delegate identities need their sync scope refreshed from
      // current grants so revoked protocols do not keep syncing after restore.
      await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid });
    } else if (!isNewIdentity && identity && sync !== 'off') {
      await registerSyncScopeForIdentity({ userAgent, connectedDid, identitySyncProtocols });
    }

    await startSyncIfEnabled(userAgent, sync);

    // Persist session info, build AuthSession, and emit lifecycle events.
    return finalizeSession({
      userAgent,
      emitter,
      storage,
      connectedDid,
      delegateDid,
      recoveryPhrase,
      signal               : ctx.sessionSignal,
      identityName         : identity?.metadata.name,
      identityConnectedDid : identity?.metadata.connectedDid,
    });
  });
}
