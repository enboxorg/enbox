/**
 * Wallet connect (Enbox Connect relay) flow.
 *
 * Connects to an external wallet via the Enbox Connect relay protocol,
 * importing a delegated DID with permission grants.
 * This replaces the "Mode B/C" paths in Enbox.connect().
 * @module
 */

import type { DwnDataEncodedRecordsWriteMessage, DwnMessagesPermissionScope, DwnRecordsPermissionScope, EnboxUserAgent } from '@enbox/agent';

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { WalletConnectOptions } from '../types.js';

import { Convert } from '@enbox/common';
import { registerWithDwnEndpoints } from '../registration.js';
import { WalletConnect } from '../wallet-connect-client.js';
import { DEFAULT_DWN_ENDPOINTS, STORAGE_KEYS } from '../types.js';
import { DwnInterface, DwnPermissionGrant } from '@enbox/agent';
import { ensureVaultReady, finalizeSession, resolvePassword, startSyncIfEnabled } from './lifecycle.js';

/**
 * Process connected grants by storing them in the local DWN as the owner.
 *
 * This is the agent-level equivalent of `Enbox.processConnectedGrants()`.
 * It stores each grant, signed as owner, and returns the deduplicated
 * list of protocol URIs represented by the grants.
 *
 * @internal
 */
export async function processConnectedGrants(params: {
  agent: EnboxUserAgent;
  delegateDid: string;
  grants: DwnDataEncodedRecordsWriteMessage[];
}): Promise<string[]> {
  const { agent, delegateDid, grants } = params;
  const connectedProtocols = new Set<string>();

  for (const grantMessage of grants) {
    const grant = DwnPermissionGrant.parse(grantMessage);

    // Store the grant as the owner of the DWN so the delegateDid
    // can use it when impersonating the connectedDid.
    const { encodedData, ...rawMessage } = grantMessage;
    const dataStream = new Blob([Convert.base64Url(encodedData).toUint8Array() as BlobPart]);

    const { reply } = await agent.processDwnRequest({
      store       : true,
      author      : delegateDid,
      target      : delegateDid,
      messageType : DwnInterface.RecordsWrite,
      signAsOwner : true,
      rawMessage,
      dataStream,
    });

    if (reply.status.code !== 202) {
      throw new Error(
        `[@enbox/auth] Failed to process connected grant: ${reply.status.detail}`
      );
    }

    const protocol = (grant.scope as DwnMessagesPermissionScope | DwnRecordsPermissionScope).protocol;
    if (protocol) {
      connectedProtocols.add(protocol);
    }
  }

  return [...connectedProtocols];
}

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

  if (sync === 'off') {
    throw new Error(
      '[@enbox/auth] Sync must be enabled when using wallet connect. ' +
      'Remove sync: "off" or set an interval like "15s".'
    );
  }

  // Ensure the agent is initialized and started before the relay flow.
  const isFirstLaunch = await userAgent.firstLaunch();
  const password = await resolvePassword(ctx, undefined, isFirstLaunch);

  await ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch,
  });

  // Run the Enbox Connect relay flow.
  // permissionRequests are already agent-level ConnectPermissionRequest objects.
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

    // Process the connected grants using agent primitives.
    const connectedProtocols = await processConnectedGrants({
      agent       : userAgent,
      delegateDid : delegatePortableDid.uri,
      grants      : delegateGrants,
    });

    // Register with DWN endpoints (if registration options are provided).
    if (ctx.registration) {
      const dwnEndpoints = ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
      await registerWithDwnEndpoints(
        {
          userAgent : userAgent,
          dwnEndpoints,
          agentDid  : userAgent.agentDid.uri,
          connectedDid,
          storage   : storage,
        },
        ctx.registration,
      );
    }

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

  const delegateDid = delegatePortableDid.uri;

  // Start sync.
  startSyncIfEnabled(userAgent, sync);

  // Persist session info, build AuthSession, and emit lifecycle events.
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
