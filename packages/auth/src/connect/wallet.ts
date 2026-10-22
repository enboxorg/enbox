/**
 * Wallet connect (Enbox Connect relay) flow.
 *
 * Connects to an external wallet via the Enbox Connect relay protocol,
 * importing a delegated DID with permission grants.
 * This implements the delegated path used by `AuthManager` and Enbox
 * connection stores.
 * @module
 */

import type { AgentSession } from '@enbox/agent';
import type { FlowContext } from './lifecycle.js';
import type { WalletConnectOptions } from '../types.js';

import { ConnectDeniedError } from '../errors.js';
import { validateConnectResultGrants } from './validate-grants.js';
import { WalletConnect } from '../wallet-connect-client.js';
import { ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, resolvePassword } from './lifecycle.js';

/**
 * Execute the wallet connect flow.
 *
 * 1. Passes the permission requests directly to `WalletConnect.initClient()`.
 * 2. Imports the delegate DID and processes grants.
 * 3. Sets up sync and returns an AgentSession.
 */
export async function walletConnect(
  ctx: FlowContext,
  options: WalletConnectOptions,
): Promise<AgentSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;
  ctx.assertActive();

  // Ensure the agent is initialized and started before the relay flow.
  const isFirstLaunch = await userAgent.firstLaunch();
  ctx.assertActive();
  const password = await resolvePassword(ctx, undefined, isFirstLaunch);
  ctx.assertActive();
  const prepareAgent = (): Promise<string | undefined> => ensureVaultReady({
    userAgent, emitter, password, isFirstLaunch,
  });
  await ctx.runMutation(prepareAgent);

  // Run the Enbox Connect relay flow.
  const result = await WalletConnect.initClient({
    displayName                : options.displayName,
    appIcon                    : options.appIcon,
    applicationId              : options.applicationId,
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

  ctx.assertActive();

  // Validate the returned grants before any local or provider-side mutation.
  validateConnectResultGrants(result, options.permissionRequests);
  const {
    delegatePortableDid, connectedDid, delegateGrants, sessionRevocations,
  } = result;

  return ctx.commitSession(async (): Promise<AgentSession> => {
    // Import delegate DID, process grants, and set up sync.
    const identity = await importDelegateAndSetupSync({
      userAgent, delegatePortableDid, connectedDid, delegateGrants,
      flowName: 'Wallet connect',
    });

    // Persist this approval's revocation metadata when finalizing the session.
    return finalizeDelegateSession({
      userAgent, emitter, storage, identity,
      connectedDid, delegateDid : delegatePortableDid.uri, sync,
      signal      : ctx.sessionSignal,
      sessionRevocations,
    });
  });
}
