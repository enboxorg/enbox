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

import { extractDwnServiceEndpointUrls } from '@enbox/dids';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { assertFlowActive, commitFlowSession, createDefaultIdentity, ensureVaultReady, finalizeSession, refreshDwnEndpointsForConnection, registerSyncScopeForIdentity, resolveIdentityDids, resolvePassword, runFlowMutation, startSyncIfEnabled } from './lifecycle.js';
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
  const newDidDwnEndpoints = options.dwnEndpoints ?? ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
  const replaceRecoveredDwnEndpoints = options.recoveryPhrase !== undefined
    && options.dwnEndpoints !== undefined;
  const shouldCreateIdentity = options.createIdentity === true;

  // Initialize vault on first launch and start the agent.
  const recoveryPhrase = await runFlowMutation(ctx, () => ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch,
    recoveryPhrase      : options.recoveryPhrase,
    dwnEndpoints        : newDidDwnEndpoints,
    replaceDwnEndpoints : replaceRecoveredDwnEndpoints,
  }));

  // Apply a stored local-node pairing when the agent was created in local mode.
  // In remote mode, discovery already ran before agent creation — skip.
  if (!userAgent.dwn.isRemoteMode) {
    await runFlowMutation(ctx, () => applyLocalDwnDiscovery(userAgent, storage, emitter));
  }

  // Resolve the agent DID before either tenant registration or sync can use it. Initialization and
  // recovery already stored an authoritative document; a regular unlock bypasses stale cache state.
  let agentDwnEndpoints: string[] | undefined;
  if (ctx.registration !== undefined || sync !== 'off') {
    agentDwnEndpoints = isFirstLaunch || options.recoveryPhrase !== undefined
      ? extractDwnServiceEndpointUrls(userAgent.agentDid.document)
      : await refreshDwnEndpointsForConnection({
        userAgent,
        didUri   : userAgent.agentDid.uri,
        required : true,
      });
    assertFlowActive(ctx);
  }

  // Register the agent DID as a DWN tenant and for sync early — both are prerequisites for seed
  // phrase recovery and for normal push/pull of identity metadata after identity creation.
  if (ctx.registration) {
    if (agentDwnEndpoints === undefined) {
      throw new Error(`[@enbox/auth] No DWN endpoints are available for registration of '${userAgent.agentDid.uri}'.`);
    }
    await registerWithDwnEndpoints(
      {
        userAgent,
        targets      : [{ did: userAgent.agentDid.uri, dwnEndpoints: agentDwnEndpoints }],
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
  let isRecoveredIdentity = false;

  // Seed phrase recovery: when a recovery phrase was provided and no identities exist locally,
  // pull them from the remote DWN before deciding whether to create a new identity.
  if (!identity && options.recoveryPhrase && sync !== 'off') {
    identities = await recoverIdentitiesFromRemote({
      userAgent,
      identitySyncProtocols,
      registration : ctx.registration,
      storage,
      assertActive : ctx.assertActive,
      runMutation  : ctx.runMutation,
    });
    identity = identities[0];
    isRecoveredIdentity = identity !== undefined;
    assertFlowActive(ctx);
  }

  // Create a default identity if none were found or recovered and the caller asked for one.
  if (!identity && shouldCreateIdentity) {
    isNewIdentity = true;
    identity = await runFlowMutation(
      ctx,
      () => createDefaultIdentity(userAgent, newDidDwnEndpoints, options.metadata?.name ?? 'Default'),
    );
  }

  // When no identity exists (createIdentity: false on first launch), use the
  // agent DID as the session's connected DID. The session is still valid but
  // operates in the agent's context rather than a user identity's context.
  const identityDids = identity ? resolveIdentityDids(identity) : undefined;
  const connectedDid = identityDids?.connectedDid ?? userAgent.agentDid.uri;
  const delegateDid = identityDids?.delegateDid;

  // Resolve an existing identity independently of its stored DID snapshot. Recovery already
  // refreshed every recovered identity, while a freshly created identity uses the document that
  // was just published.
  let identityDwnEndpoints: string[] | undefined;
  if (identity && !isNewIdentity && !isRecoveredIdentity) {
    identityDwnEndpoints = await refreshDwnEndpointsForConnection({
      userAgent,
      didUri   : connectedDid,
      required : ctx.registration !== undefined || sync !== 'off',
    });
    assertFlowActive(ctx);
  } else if (identity && isNewIdentity && ctx.registration) {
    identityDwnEndpoints = await userAgent.identity.getDwnEndpoints({ didUri: connectedDid });
  }

  // Register the selected persisted identity DID as a tenant, not only newly created identities.
  // Recovered identities were already registered individually during the recovery phase.
  // Tenant registration must come before sync registration — with live
  // sync active, registerIdentity hot-adds a subscription that needs
  // the DID to be a recognised tenant on the remote DWN.
  if (identity && !isRecoveredIdentity && ctx.registration) {
    if (identityDwnEndpoints === undefined) {
      throw new Error(`[@enbox/auth] No DWN endpoints are available for registration of '${connectedDid}'.`);
    }
    await registerWithDwnEndpoints(
      {
        userAgent,
        targets      : [{ did: connectedDid, dwnEndpoints: identityDwnEndpoints }],
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

    // Persist session info and build the AuthSession for the manager to publish.
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
