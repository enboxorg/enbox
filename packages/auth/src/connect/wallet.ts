/**
 * Wallet connect (Enbox Connect relay) flow.
 *
 * Connects to an external wallet via the Enbox Connect relay protocol,
 * importing a delegated DID with permission grants.
 * This replaces the "Mode B/C" paths in Enbox.connect().
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { WalletConnectOptions } from '../types.js';

import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { validateConnectResultGrants } from './validate-grants.js';
import { WalletConnect } from '../wallet-connect-client.js';
import { assertFlowActive, commitFlowSession, ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, resolvePassword, runFlowMutation } from './lifecycle.js';

// Re-export for backward compatibility — processConnectedGrants moved to lifecycle.ts.
export { processConnectedGrants } from './lifecycle.js';

/**
 * Execute the wallet connect flow.
 *
 * 1. Passes the permission requests directly to `WalletConnect.initClient()`.
 * 2. Imports the delegate DID and processes grants.
 * 3. Sets up sync and returns an AuthSession.
 */
export async function walletConnect(
  ctx: FlowContext,
  options: WalletConnectOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;
  assertFlowActive(ctx);

  // Ensure the agent is initialized and started before the relay flow.
  const isFirstLaunch = await userAgent.firstLaunch();
  assertFlowActive(ctx);
  const password = await resolvePassword(ctx, undefined, isFirstLaunch);
  assertFlowActive(ctx);
  const prepareAgent = (): Promise<string | undefined> => ensureVaultReady({
    userAgent, emitter, password, isFirstLaunch,
  });
  await runFlowMutation(ctx, prepareAgent);

  // Run the Enbox Connect relay flow.
  const result = await WalletConnect.initClient({
    displayName                : options.displayName,
    appIcon                    : options.appIcon,
    clientMetadata             : options.clientMetadata,
    requestedSessionTtlSeconds : options.requestedSessionTtlSeconds,
    preSupplyDelegateDid       : options.preSupplyDelegateDid,
    delegatePortableDid        : options.delegatePortableDid,
    connectServerUrl           : options.connectServerUrl,
    walletUri                  : options.walletUri ?? 'enbox://connect',
    permissionRequests         : options.permissionRequests,
    onWalletUriReady           : options.onWalletUriReady,
    validatePin                : options.validatePin,
    timeoutMs                  : options.timeoutMs,
    pollIntervalMs             : options.pollIntervalMs,
  });

  if (!result) {
    throw new Error('[@enbox/auth] Connection was denied by the wallet.');
  }

  assertFlowActive(ctx);

  // Validate the returned grants before any local or provider-side mutation.
  validateConnectResultGrants(result, options.permissionRequests);
  const {
    delegatePortableDid, connectedDid, delegateGrants, sessionRevocations,
  } = result;

  // Provider authentication may wait on application UI, so keep it outside
  // the lifecycle mutex and re-check teardown before importing the delegate.
  if (ctx.registration) {
    const dwnEndpoints = ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
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
    // Import delegate DID, process grants, and set up sync.
    const identity = await importDelegateAndSetupSync({
      userAgent, delegatePortableDid, connectedDid, delegateGrants,
      flowName: 'Wallet connect',
    });

    // Finalize session. Pass the transient delegate state explicitly so
    // `persistOrClearDelegateSecrets` doesn't have to read it back off
    // the identity object (which was the old `(identity as any)._foo`
    // smuggling pattern).
    return finalizeDelegateSession({
      userAgent, emitter, storage, identity,
      connectedDid, delegateDid   : delegatePortableDid.uri, sync,
      delegateState : {
        sessionRevocations,
      },
    });
  });
}
