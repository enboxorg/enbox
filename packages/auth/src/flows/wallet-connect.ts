/**
 * Wallet connect (OIDC/QR) flow.
 *
 * Connects to an external wallet via the WalletConnect relay protocol,
 * importing a delegated DID with permission grants.
 * This replaces the "Mode B/C" paths in Web5.connect().
 * @module
 */

import type { Web5UserAgent } from '@enbox/agent';
import { WalletConnect } from '@enbox/agent';
import { Web5 } from '@enbox/api';

import type { AuthEventEmitter } from '../events.js';
import type { StorageAdapter, SyncOption, WalletConnectOptions } from '../types.js';
import { AuthSession } from '../identity-session.js';
import { STORAGE_KEYS } from '../types.js';

/** @internal */
export interface WalletConnectContext {
  userAgent: Web5UserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  defaultSync?: SyncOption;
}

/**
 * Execute the wallet connect flow.
 *
 * 1. Builds permission requests from the provided protocol definitions.
 * 2. Calls `WalletConnect.initClient()` to run the full OIDC relay flow.
 * 3. Imports the delegate DID and processes grants.
 * 4. Sets up sync and returns an AuthSession.
 */
export async function walletConnect(
  ctx: WalletConnectContext,
  options: WalletConnectOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;

  if (sync === 'off') {
    throw new Error(
      '[@enbox/auth] Sync must be enabled when using wallet connect. ' +
      'Remove sync: "off" or set an interval like "15s".'
    );
  }

  // Build permission request objects from the user-friendly format.
  const walletPermissionRequests = options.permissionRequests.map(
    ({ protocolDefinition, permissions }) =>
      WalletConnect.createPermissionRequestForProtocol({
        definition  : protocolDefinition,
        permissions : permissions ?? ['read', 'write', 'delete', 'query', 'subscribe'],
      })
  );

  // Run the full OIDC wallet connect flow.
  const result = await WalletConnect.initClient({
    displayName        : options.displayName,
    connectServerUrl   : options.connectServerUrl,
    walletUri          : options.walletUri ?? 'web5://connect',
    permissionRequests : walletPermissionRequests,
    onWalletUriReady   : options.onWalletUriReady,
    validatePin        : options.validatePin,
  });

  if (!result) {
    throw new Error('[@enbox/auth] Wallet connect flow was cancelled or returned no result.');
  }

  const { delegatePortableDid, connectedDid, delegateGrants } = result;

  // Import the delegated DID as an Identity.
  let identity;
  try {
    identity = await userAgent.identity.import({
      portableIdentity: {
        portableDid : delegatePortableDid,
        metadata    : {
          connectedDid,
          name   : 'Default',
          uri    : delegatePortableDid.uri,
          tenant : userAgent.agentDid.uri,
        },
      },
    });

    // Process the connected grants.
    const connectedProtocols = await Web5.processConnectedGrants({
      agent       : userAgent,
      delegateDid : delegatePortableDid.uri,
      grants      : delegateGrants,
    });

    // Register sync for the connected identity.
    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : {
        delegateDid : delegatePortableDid.uri,
        protocols   : connectedProtocols,
      },
    });

    // Pull down existing messages from the connected DID's DWN.
    await userAgent.sync.sync('pull');
  } catch (error: unknown) {
    // Clean up on failure.
    if (identity) {
      try {
        await userAgent.did.delete({
          didUri    : identity.did.uri,
          tenant    : identity.metadata.tenant,
          deleteKey : true,
        });
      } catch { /* best effort */ }

      try {
        await userAgent.identity.delete({ didUri: identity.did.uri });
      } catch { /* best effort */ }
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[@enbox/auth] Wallet connect failed: ${message}`);
  }

  // Start sync.
  const syncMode = sync === undefined ? 'live' : 'poll';
  const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
  userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
    .catch((err: unknown) => {
      console.error('[@enbox/auth] Sync failed:', err);
    });

  // Build the Web5 instance.
  const delegateDid = delegatePortableDid.uri;
  const web5 = new Web5({ agent: userAgent, connectedDid, delegateDid });

  // Persist session info.
  await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
  await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);
  await storage.set(STORAGE_KEYS.DELEGATE_DID, delegateDid);
  await storage.set(STORAGE_KEYS.CONNECTED_DID, connectedDid);

  const identityInfo = {
    didUri       : connectedDid,
    name         : identity.metadata.name,
    connectedDid : identity.metadata.connectedDid,
  };

  const session = new AuthSession({
    web5,
    did: connectedDid,
    delegateDid,
    identity: identityInfo,
  });

  emitter.emit('identity-added', { identity: identityInfo });
  emitter.emit('session-start', {
    session: {
      did       : session.did,
      delegateDid,
      identity  : identityInfo,
    },
  });

  return session;
}
