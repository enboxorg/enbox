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

import type { AgentSession, BearerIdentity } from '@enbox/agent';

import type { FlowContext } from './lifecycle.js';
import type { RestoreFromPhraseOptions, SyncOption, VaultConnectOptions } from '../types.js';

import { normalizeDwnEndpointUrls } from '@enbox/dids';
import { publishServiceConfigNotice } from '@enbox/agent';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerDwnTenants } from '../registration.js';
import { createDefaultIdentity, ensureVaultReady, finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, resolvePassword, runAuthSessionLifecycle, startSyncInBackgroundIfEnabled } from './lifecycle.js';
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

  const { userAgent } = ctx;
  if (ctx.registration) {
    await registerDwnTenants(
      ctx,
      { dids: [userAgent.agentDid.uri], dwnEndpoints: replacementEndpoints },
      ctx.registration,
    );
    ctx.assertActive();
  }

  await ctx.runMutation(async (): Promise<void> => {
    await runAuthSessionLifecycle(async (): Promise<void> => {
      await userAgent.vault.resetPasswordWithRecoveryPhrase({
        recoveryPhrase,
        password,
        dwnEndpoints: replacementEndpoints,
      });
      userAgent.agentDid = await userAgent.vault.getDid();
    });
    await publishServiceConfigNotice({
      agent            : userAgent,
      currentEndpoints : replacementEndpoints,
      formerEndpoints  : advertisedEndpoints,
      ownerDid         : userAgent.agentDid.uri,
    }).catch((error: unknown): void => {
      console.error(`[@enbox/auth] Failed to announce vault DWN endpoint change: ${String(error)}`);
    });
  });
  await ctx.runMutation(() => registerAgentDidForSync(userAgent));
}

/** Prepare or resume the owner vault before identity recovery, selection or session creation. */
async function prepareOwnerVault(
  ctx: FlowContext,
  params: Omit<Parameters<typeof ensureVaultReady>[0], 'userAgent' | 'emitter'>,
  sync: SyncOption | undefined,
): Promise<{ recoveryPhrase: string | undefined; hasPendingSetup: boolean; advertisedVaultEndpoints: string[] | undefined }> {
  const { userAgent, emitter, storage } = ctx;
  const isRecovery = params.recoveryPhrase !== undefined;
  const replacementDwnEndpoints = isRecovery ? params.dwnEndpoints : undefined;
  const { password, recoveryPhrase: suppliedRecoveryPhrase } = params;
  // Initialize vault on first launch and start the agent.
  const initializedRecoveryPhrase = await ctx.runMutation(() => ensureVaultReady({ userAgent, emitter, ...params }));
  const pendingSetup = await ctx.runMutation(() => runAuthSessionLifecycle(() => userAgent.vault.getPendingSetup()));
  const recoveryPhrase = pendingSetup?.recoveryPhrase ?? initializedRecoveryPhrase;
  const hasPendingSetup = pendingSetup !== undefined;
  if (pendingSetup?.registrationRequired && ctx.registration === undefined) {
    throw new Error('vaultConnect: Vault setup requires tenant registration. Supply registration options and retry connectVault().');
  }

  if (userAgent.agentDid.metadata.published === false) {
    if (!isRecovery || replacementDwnEndpoints === undefined) {
      throw new Error('vaultConnect: Vault recovery endpoints are unpublished. Retry restoreFromPhrase() with explicit dwnEndpoints.');
    }
    await migrateVaultDwnEndpoints(ctx, password, suppliedRecoveryPhrase, [], replacementDwnEndpoints);
  }

  // Apply a stored local-node pairing when the agent was created in local mode.
  // In remote mode, discovery already ran before agent creation — skip.
  if (!userAgent.dwn.isRemoteMode) {
    await ctx.runMutation(() => applyLocalDwnDiscovery(userAgent, storage, emitter));
  }

  // Seed recovery needs the vault DID's advertised node even when tenant registration is disabled.
  const advertisedVaultEndpoints = isRecovery
    ? await userAgent.identity.getDwnEndpoints({
      didUri: userAgent.agentDid.uri,
    })
    : undefined;

  // Finish new owner tenancy, including setup interrupted after initialization.
  // Established and recovered vaults keep tenancy until explicitly repaired.
  if (((params.isFirstLaunch && !isRecovery) || hasPendingSetup) && ctx.registration) {
    const agentDwnEndpoints = await userAgent.identity.getDwnEndpoints({ didUri: userAgent.agentDid.uri });
    await registerDwnTenants(
      ctx,
      { dids: [userAgent.agentDid.uri], dwnEndpoints: agentDwnEndpoints },
      ctx.registration,
    );
    ctx.assertActive();
  }
  if (sync !== 'off' || isRecovery) {
    await ctx.runMutation(() => registerAgentDidForSync(userAgent));
  }

  return { recoveryPhrase, hasPendingSetup, advertisedVaultEndpoints };
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
): Promise<AgentSession> {
  const { userAgent, emitter, storage } = ctx;
  ctx.assertActive();

  const suppliedRecoveryPhrase = 'recoveryPhrase' in options ? options.recoveryPhrase : undefined;
  const isRecovery = suppliedRecoveryPhrase !== undefined;
  const onVaultPasswordCommitted = isRecovery && 'onVaultPasswordCommitted' in options
    ? options.onVaultPasswordCommitted
    : undefined;
  const explicitDwnEndpoints = options.dwnEndpoints === undefined
    ? undefined
    : normalizeDwnEndpoints(options.dwnEndpoints);
  const replacementDwnEndpoints = isRecovery ? explicitDwnEndpoints : undefined;
  const dwnEndpoints = isRecovery
    ? replacementDwnEndpoints
    : explicitDwnEndpoints ?? ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;

  // Resolve password through the standard chain.
  const isFirstLaunch = await userAgent.firstLaunch();
  ctx.assertActive();
  const password = await resolvePassword(ctx, options.password, isFirstLaunch);
  ctx.assertActive();

  const sync = options.sync ?? ctx.defaultSync;
  const identitySyncProtocols = options.identitySyncProtocols ?? ctx.defaultIdentitySyncProtocols;
  const shouldCreateIdentity = options.createIdentity === true;

  const { recoveryPhrase, hasPendingSetup, advertisedVaultEndpoints } = await prepareOwnerVault(ctx, {
    password,
    isFirstLaunch,
    recoveryPhrase            : suppliedRecoveryPhrase,
    pendingSetup              : isRecovery ? undefined : { registrationRequired: ctx.registration !== undefined },
    dwnEndpoints,
    onVaultPasswordCommitted,
    deferDwnEndpointBootstrap : isRecovery && ctx.registration !== undefined,
  }, sync);

  let identities: BearerIdentity[];
  let isNewIdentity = false;

  // Phrase restore performs its required one-shot pull even when live sync is disabled.
  if (isRecovery) {
    identities = await recoverIdentitiesFromRemote({
      userAgent,
      operationSignal : ctx.operationSignal,
      replacementDwnEndpoints,
      identitySyncProtocols,
      registration    : ctx.registration,
      assertActive    : ctx.assertActive,
      runMutation     : ctx.runMutation,
    });
    ctx.assertActive();
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
    identity = await ctx.runMutation(() => createDefaultIdentity(userAgent, dwnEndpoints, options.metadata?.name ?? 'Default'),
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
  if ((isNewIdentity || (hasPendingSetup && identity !== undefined && delegateDid === undefined)) && ctx.registration) {
    const identityDwnEndpoints = await userAgent.identity.getDwnEndpoints({ didUri: connectedDid });
    await registerDwnTenants(
      ctx,
      { dids: [connectedDid], dwnEndpoints: identityDwnEndpoints },
      ctx.registration,
    );
    ctx.assertActive();
  }
  return ctx.commitSession( async (): Promise<AgentSession> => {
    if ((identity !== undefined && sync !== 'off') || (!isNewIdentity && delegateDid !== undefined)) {
      // Persisted delegates repair their grant-derived scope even while sync is
      // off so revoked protocols cannot resume from stale registration later.
      await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid, identitySyncProtocols });
    }

    // Persist session info and build the AgentSession for the manager to publish.
    const session = await finalizeSession({
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

    startSyncInBackgroundIfEnabled(userAgent, sync, ctx.sessionSignal);
    return session;
  }, { completeVaultSetup: true });
}
