/**
 * DWeb Connect flow.
 *
 * Connects to an external wallet via a browser popup and postMessage,
 * importing a delegated DID with permission grants. This is the
 * browser-native alternative to the relay-mediated wallet connect flow.
 *
 * @module
 */

import type { DwnProtocolDefinition } from '@enbox/agent';

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { ConnectPermissionRequest, DWebConnectOptions, ProtocolRequest, WalletOption } from '../types.js';

import { DWebConnect } from '../dweb-connect-client.js';
import { processConnectedGrants } from './wallet.js';
import { showWalletSelector } from '../ui/wallet-selector.js';
import { WalletConnect } from '../wallet-connect-client.js';
import { DEFAULT_PERMISSIONS, DEFAULT_WALLETS, STORAGE_KEYS } from '../types.js';
import { ensureVaultReady, finalizeSession, resolvePassword, startSyncIfEnabled } from './lifecycle.js';

/**
 * Normalize a simplified `ProtocolRequest` into the agent-level
 * `ConnectPermissionRequest` format expected by the wallet.
 */
function normalizeProtocolRequests(
  protocols: ProtocolRequest[] | undefined,
): ConnectPermissionRequest[] {
  if (!protocols || protocols.length === 0) {return [];}

  return protocols.map((entry) => {
    let definition: DwnProtocolDefinition;
    let permissions: string[];

    if ('protocol' in entry && 'types' in entry && 'structure' in entry) {
      // Bare protocol definition — use default permissions.
      definition = entry as DwnProtocolDefinition;
      permissions = [...DEFAULT_PERMISSIONS];
    } else {
      // Object with explicit permissions.
      const explicit = entry as { definition: DwnProtocolDefinition; permissions: string[] };
      definition = explicit.definition;
      permissions = explicit.permissions;
    }

    return WalletConnect.createPermissionRequestForProtocol({
      definition,
      permissions: permissions as Parameters<typeof WalletConnect.createPermissionRequestForProtocol>[0]['permissions'],
    });
  });
}

/**
 * Execute the DWeb Connect flow.
 *
 * 1. Initializes the vault (agent-only, no identity).
 * 2. Normalizes protocol permission requests.
 * 3. Shows the wallet selector modal (or uses provided walletUrl).
 * 4. Opens the wallet popup and runs the postMessage flow.
 * 5. Imports the delegate DID and processes grants.
 * 6. Starts sync and returns an AuthSession.
 */
export async function dwebConnect(
  ctx: FlowContext,
  options: DWebConnectOptions = {},
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;

  if (sync === 'off') {
    throw new Error(
      '[@enbox/auth] Sync must be enabled for DWeb Connect. ' +
      'Remove sync: "off" or set an interval like "15s".'
    );
  }

  // 1. Ensure the vault is initialized (agent-only, no identity).
  const isFirstLaunch = await userAgent.firstLaunch();
  const password = await resolvePassword(ctx, undefined, isFirstLaunch);

  await ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch,
  });

  // 2. Normalize protocol requests.
  const permissionRequests = normalizeProtocolRequests(options.protocols);

  // 3. Determine wallet URL.
  let walletUrl = options.walletUrl;

  if (!walletUrl) {
    const wallets: WalletOption[] = ctx.wallets ?? DEFAULT_WALLETS;
    walletUrl = await showWalletSelector(wallets);
  }

  // 4. Run the DWeb Connect popup flow.
  const result = await DWebConnect.initClient({
    walletUrl,
    permissionRequests,
    timeout: options.timeout,
  });

  if (!result) {
    throw new Error('[@enbox/auth] DWeb Connect was denied or cancelled by the user.');
  }

  const { delegatePortableDid, connectedDid, delegateGrants } = result;

  // 5. Import the delegate DID as a BearerIdentity.
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

    // 6. Process the delegated grants.
    const connectedProtocols = await processConnectedGrants({
      agent       : userAgent,
      delegateDid : delegatePortableDid.uri,
      grants      : delegateGrants,
    });

    // 7. Register sync for the connected identity.
    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : {
        delegateDid : delegatePortableDid.uri,
        protocols   : connectedProtocols,
      },
    });

    // 8. Pull existing messages from the connected DID's DWN.
    await userAgent.sync.sync('pull');
  } catch (error: unknown) {
    // Clean up the imported identity on failure.
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
    throw new Error(`[@enbox/auth] DWeb Connect failed: ${message}`);
  }

  const delegateDid = delegatePortableDid.uri;

  // 9. Start sync.
  startSyncIfEnabled(userAgent, sync);

  // 10. Persist session info and return AuthSession.
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
    extraStorageKeys     : {
      [STORAGE_KEYS.DELEGATE_DID]  : delegateDid,
      [STORAGE_KEYS.CONNECTED_DID] : connectedDid,
    },
  });
}
