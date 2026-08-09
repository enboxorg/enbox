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

import { ConnectDeniedError } from '../errors.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { validateConnectResultGrants } from './validate-grants.js';
import { WalletConnect } from '../wallet-connect-client.js';
import { assertFlowActive, commitFlowSession, ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, refreshDwnEndpointsForConnection, resolvePassword, runFlowMutation } from './lifecycle.js';

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
    throw new ConnectDeniedError('[@enbox/auth] Connection was denied by the wallet.');
  }

  assertFlowActive(ctx);

  // Validate the returned grants before any local or provider-side mutation.
  validateConnectResultGrants(result, options.permissionRequests);
  const {
    delegatePortableDid, connectedDid, delegateGrants, sessionRevocations,
  } = result;

  // Resolve the wallet DID independently of the returned delegate snapshot. This keeps routing on
  // the wallet's current published topology even when registration callbacks are not configured.
  const dwnEndpoints = await refreshDwnEndpointsForConnection({
    userAgent,
    didUri   : connectedDid,
    required : true,
  });
  assertFlowActive(ctx);

  // Provider authentication may wait on application UI, so keep it outside the lifecycle mutex
  // and re-check teardown before importing the delegate.
  if (ctx.registration) {
    if (dwnEndpoints === undefined) {
      throw new Error(`[@enbox/auth] No DWN endpoints are available for registration of '${connectedDid}'.`);
    }
    await registerWithDwnEndpoints(
      {
        userAgent,
        targets      : [{ did: connectedDid, dwnEndpoints }],
        secretStore  : userAgent.secrets,
        storage,
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
      signal        : ctx.sessionSignal,
      delegateState : {
        sessionRevocations,
      },
    });
  });
}
