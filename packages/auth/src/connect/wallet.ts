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
import { WalletConnect } from '../wallet-connect-client.js';
import { ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, resolvePassword } from './lifecycle.js';

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

  // Ensure the agent is initialized and started before the relay flow.
  const isFirstLaunch = await userAgent.firstLaunch();
  const password = await resolvePassword(ctx, undefined, isFirstLaunch);
  await ensureVaultReady({ userAgent, emitter, password, isFirstLaunch });

  // Run the Enbox Connect relay flow.
  const result = await WalletConnect.initClient({
    displayName        : options.displayName,
    connectServerUrl   : options.connectServerUrl,
    walletUri          : options.walletUri ?? 'enbox://connect',
    permissionRequests : options.permissionRequests,
    onWalletUriReady   : options.onWalletUriReady,
    validatePin        : options.validatePin,
  });

  if (!result) {
    throw new Error('[@enbox/auth] Wallet connect flow was cancelled or returned no result.');
  }

  // Import delegate DID, process grants, and set up sync.
  const { delegatePortableDid, connectedDid, delegateGrants, delegateDecryptionKeys, delegateContextKeys, delegateMultiPartyProtocols } = result;
  const identity = await importDelegateAndSetupSync({
    userAgent, delegatePortableDid, connectedDid, delegateGrants,
    delegateDecryptionKeys, delegateContextKeys, delegateMultiPartyProtocols,
    flowName: 'Wallet connect',
  });

  // Register with DWN endpoints (if registration options are provided).
  if (ctx.registration) {
    const dwnEndpoints = ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
    await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints,
        agentDid: userAgent.agentDid.uri,
        connectedDid,
        storage,
      },
      ctx.registration,
    );
  }

  // Finalize session.
  return finalizeDelegateSession({
    userAgent, emitter, storage, identity,
    connectedDid, delegateDid: delegatePortableDid.uri, sync,
  });
}
