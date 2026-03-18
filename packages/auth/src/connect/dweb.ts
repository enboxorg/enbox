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
import { showWalletSelector } from '../ui/wallet-selector.js';
import { WalletConnect } from '../wallet-connect-client.js';
import { DEFAULT_PERMISSIONS, DEFAULT_WALLETS } from '../types.js';
import { ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, resolvePassword } from './lifecycle.js';

/**
 * Normalize a simplified `ProtocolRequest` into the agent-level
 * `ConnectPermissionRequest` format expected by the wallet.
 */
export function normalizeProtocolRequests(
  protocols: ProtocolRequest[] | undefined,
): ConnectPermissionRequest[] {
  if (!protocols || protocols.length === 0) { return []; }

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
 * 5. Imports the delegate DID, processes grants, and sets up sync.
 * 6. Returns an AuthSession.
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
  await ensureVaultReady({ userAgent, emitter, password, isFirstLaunch });

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

  // 5. Import delegate DID, process grants, and set up sync.
  const { delegatePortableDid, connectedDid, delegateGrants } = result;
  const identity = await importDelegateAndSetupSync({
    userAgent, delegatePortableDid, connectedDid, delegateGrants,
    flowName: 'DWeb Connect',
  });

  // 6. Finalize session.
  return finalizeDelegateSession({
    userAgent, emitter, storage, identity,
    connectedDid, delegateDid: delegatePortableDid.uri, sync,
  });
}
