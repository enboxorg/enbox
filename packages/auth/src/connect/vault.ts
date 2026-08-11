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
import type { BearerIdentity } from '@enbox/agent';
import type { FlowContext } from './lifecycle.js';
import type { RestoreFromPhraseOptions, VaultConnectOptions } from '../types.js';

import { normalizeDwnEndpointUrls } from '@enbox/dids';
import { publishServiceConfigNotice } from '@enbox/agent';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { assertFlowActive, commitFlowSession, createDefaultIdentity, ensureVaultReady, finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, resolvePassword, runFlowMutation, startSyncIfEnabled } from './lifecycle.js';
import { recoverIdentitiesFromRemote, registerAgentDidForSync } from './recovery.js';

function normalizeDwnEndpoints(endpoints: string[]): string[] {
  const normalized = normalizeDwnEndpointUrls(endpoints);
  if (normalized === undefined) {
    throw new TypeError('vaultConnect: dwnEndpoints must be a non-empty array of HTTP(S) URLs without queries or fragments.');
  }
  return normalized;
}

function endpointsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((endpoint, index) => endpoint === right[index]);
}

async function migrateVaultDwnEndpoints(
  ctx: FlowContext,
  password: string,
  recoveryPhrase: string | undefined,
  advertisedEndpoints: string[] | undefined,
  replacementEndpoints: string[] | undefined,
): Promise<void> {
  if (replacementEndpoints === undefined
    || advertisedEndpoints === undefined
    || recoveryPhrase === undefined
    || endpointsEqual(advertisedEndpoints, replacementEndpoints)) {
    return;
  }

  const { userAgent, storage } = ctx;
  if (ctx.registration) {
    const isReplacementReady = await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints : replacementEndpoints,
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
    if (!isReplacementReady) {
      return;
    }
  }

  await runFlowMutation(ctx, async (): Promise<void> => {
    await userAgent.vault.resetPasswordWithRecoveryPhrase({
      recoveryPhrase,
      password,
      dwnEndpoints: replacementEndpoints,
    });
    userAgent.agentDid = await userAgent.vault.getDid();
    await publishServiceConfigNotice({
      agent            : userAgent,
      currentEndpoints : replacementEndpoints,
      formerEndpoints  : advertisedEndpoints,
      ownerDid         : userAgent.agentDid.uri,
    }).catch((error: unknown): void => {
      console.error(`[@enbox/auth] Failed to announce vault DWN endpoint change: ${String(error)}`);
    });
  });
  await runFlowMutation(ctx, () => registerAgentDidForSync(userAgent));
}

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
  options: VaultConnectOptions | RestoreFromPhraseOptions = {},
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  assertFlowActive(ctx);

  const suppliedRecoveryPhrase = 'recoveryPhrase' in options ? options.recoveryPhrase : undefined;
  const isRecovery = suppliedRecoveryPhrase !== undefined;
  const explicitDwnEndpoints = options.dwnEndpoints === undefined
    ? undefined
    : normalizeDwnEndpoints(options.dwnEndpoints);
  const replacementDwnEndpoints = isRecovery ? explicitDwnEndpoints : undefined;
  const dwnEndpoints = isRecovery
    ? replacementDwnEndpoints
    : explicitDwnEndpoints ?? ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;

  // Resolve password through the standard chain.
  const isFirstLaunch = await userAgent.firstLaunch();
  assertFlowActive(ctx);
  const password = await resolvePassword(ctx, options.password, isFirstLaunch);
  assertFlowActive(ctx);

  const sync = options.sync ?? ctx.defaultSync;
  const identitySyncProtocols = options.identitySyncProtocols ?? ctx.defaultIdentitySyncProtocols;
  const shouldCreateIdentity = options.createIdentity === true;

  // Initialize vault on first launch and start the agent.
  const recoveryPhrase = await runFlowMutation(ctx, () => ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch,
    recoveryPhrase: suppliedRecoveryPhrase,
    dwnEndpoints,
  }));

  // Apply a stored local-node pairing when the agent was created in local mode.
  // In remote mode, discovery already ran before agent creation — skip.
  if (!userAgent.dwn.isRemoteMode) {
    await runFlowMutation(ctx, () => applyLocalDwnDiscovery(userAgent, storage, emitter));
  }

  // Seed recovery needs the vault DID's advertised node even when tenant registration is disabled.
  const advertisedVaultEndpoints = isRecovery
    ? await userAgent.identity.getDwnEndpoints({
      didUri: userAgent.agentDid.uri,
    })
    : undefined;

  // Register the agent DID as a DWN tenant and for sync early — both are
  // prerequisites for seed phrase recovery and for normal push/pull of
  // identity metadata after identity creation.
  if (ctx.registration) {
    const agentDwnEndpoints = advertisedVaultEndpoints
      ?? await userAgent.identity.getDwnEndpoints({ didUri: userAgent.agentDid.uri });
    await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints : agentDwnEndpoints,
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
  if (sync !== 'off' || isRecovery) {
    await runFlowMutation(ctx, () => registerAgentDidForSync(userAgent));
  }

  let identities: BearerIdentity[];
  let isNewIdentity = false;

  // Phrase restore performs its required one-shot pull even when live sync is disabled.
  if (isRecovery) {
    identities = await recoverIdentitiesFromRemote({
      userAgent,
      replacementDwnEndpoints,
      identitySyncProtocols,
      registration : ctx.registration,
      storage,
      assertActive : ctx.assertActive,
      runMutation  : ctx.runMutation,
    });
    assertFlowActive(ctx);
  } else {
    identities = await userAgent.identity.list();
  }
  let identity = identities[0];

  // Migrate the vault DID only after identity recovery has read the
  // authoritative endpoints. A missing DID/service was already bootstrapped
  // during initialization when explicit endpoints were supplied.
  await migrateVaultDwnEndpoints(
    ctx,
    password,
    suppliedRecoveryPhrase,
    advertisedVaultEndpoints,
    replacementDwnEndpoints,
  );

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
  // sync active, setIdentityOptions hot-adds a subscription that needs
  // the DID to be a recognised tenant on the remote DWN.
  if (isNewIdentity && ctx.registration) {
    const identityDwnEndpoints = await userAgent.identity.getDwnEndpoints({ didUri: connectedDid });
    await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints : identityDwnEndpoints,
        agentDid     : connectedDid,
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
    if ((identity !== undefined && sync !== 'off') || (!isNewIdentity && delegateDid !== undefined)) {
      // Persisted delegates repair their grant-derived scope even while sync is
      // off so revoked protocols cannot resume from stale registration later.
      await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid, identitySyncProtocols });
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
