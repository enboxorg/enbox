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

import { IdentityProtocolDefinition, JwkProtocolDefinition } from '@enbox/agent';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { recoverIdentitiesFromRemote } from './recovery.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { createDefaultIdentity, ensureVaultReady, finalizeSession, resolveIdentityDids, resolvePassword, startSyncIfEnabled } from './lifecycle.js';

/**
 * Internal protocols that store recovery-critical data in the agent DID's DWN.
 * These must be synced so that seed phrase recovery can pull identity metadata,
 * portable DIDs, and encrypted private keys from the remote DWN.
 */
const AGENT_DID_SYNC_PROTOCOLS: [string, ...string[]] = [
  IdentityProtocolDefinition.protocol,
  JwkProtocolDefinition.protocol,
];

/**
 * Execute the vault connect flow.
 *
 * - On first launch: initializes the vault. Identity creation is opt-in via
 *   `options.createIdentity: true`.
 * - On subsequent launches: unlocks the vault and reconnects to the existing identity.
 * - On recovery: when `recoveryPhrase` is provided on a fresh vault, pulls
 *   identities and their data from the remote DWN before falling back to
 *   identity creation.
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

  // Resolve password through the standard chain.
  const isFirstLaunch = await userAgent.firstLaunch();
  const password = await resolvePassword(ctx, options.password, isFirstLaunch);

  const sync = options.sync ?? ctx.defaultSync;
  const dwnEndpoints = options.dwnEndpoints ?? ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
  const shouldCreateIdentity = options.createIdentity === true;

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
      },
      ctx.registration,
    );
  }
  if (sync !== 'off') {
    try {
      await userAgent.sync.registerIdentity({
        did     : userAgent.agentDid.uri,
        options : { protocols: AGENT_DID_SYNC_PROTOCOLS },
      });
    } catch {
      // Already registered from a previous session.
    }
  }

  // Find existing identities.
  let identities = await userAgent.identity.list();
  let identity = identities[0];
  let isNewIdentity = false;

  // Seed phrase recovery: when a recovery phrase was provided on a fresh
  // vault and no identities exist locally, pull them from the remote DWN.
  if (!identity && isFirstLaunch && options.recoveryPhrase && sync !== 'off') {
    try {
      identities = await recoverIdentitiesFromRemote({ userAgent, dwnEndpoints, registration: ctx.registration, storage });
      identity = identities[0];
    } catch (err) {
      console.warn('[@enbox/auth] Seed phrase recovery failed:', err);
    }
  }

  // Create a default identity if none were found or recovered.
  if (!identity && shouldCreateIdentity) {
    isNewIdentity = true;
    identity = await createDefaultIdentity(userAgent, dwnEndpoints, options.metadata?.name ?? 'Default');
  }

  // When no identity exists (createIdentity: false on first launch), use the
  // agent DID as the session's connected DID. The session is still valid but
  // operates in the agent's context rather than a user identity's context.
  const connectedDid = identity
    ? resolveIdentityDids(identity).connectedDid
    : userAgent.agentDid.uri;

  const delegateDid = identity
    ? resolveIdentityDids(identity).delegateDid
    : undefined;

  // Register the new identity DID as a tenant and for sync.
  // Tenant registration must come before sync registration — with live
  // sync active, registerIdentity hot-adds a subscription that needs
  // the DID to be a recognised tenant on the remote DWN.
  if (isNewIdentity && ctx.registration) {
    await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints,
        agentDid    : userAgent.agentDid.uri,
        connectedDid,
        secretStore : userAgent.secrets,
        storage,
      },
      ctx.registration,
    );
  }
  if (isNewIdentity && sync !== 'off') {
    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : { delegateDid, protocols: 'all' },
    });
  }

  // Start sync.
  await startSyncIfEnabled(userAgent, sync);

  // Persist session info, build AuthSession, and emit lifecycle events.
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    recoveryPhrase,
    identityName         : identity?.metadata.name,
    identityConnectedDid : identity?.metadata.connectedDid,
  });
}
