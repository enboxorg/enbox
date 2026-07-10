/**
 * WalletConnect client — initiates the relay-mediated connect flow.
 *
 * Thin adapter over the `@enbox/connect` kernel: it normalizes the
 * auth-level options into a kernel `ConnectClient` handshake carried by the
 * `RelayClientTransport`, surfaces the wallet URI to the caller (QR code /
 * deep link seam), collects the PIN through the existing `validatePin` seam,
 * and returns the kernel `ConnectResult` for the shared auth completion path
 * (`validateConnectResultGrants` → `importDelegateAndSetupSync` →
 * `finalizeDelegateSession`).
 *
 * Pre-supplied delegate DIDs are augmented here (Ed25519 → X25519 private-key
 * derivation) before entering the kernel — the kernel never touches key
 * material.
 *
 * @module
 */

import type { Permission } from './types.js';
import type { PortableDid } from '@enbox/dids';
import type { ConnectClientMetadata, ConnectPermissionRequest, ConnectResult } from '@enbox/connect';
import type { DwnPermissionScope, DwnProtocolDefinition } from '@enbox/agent';

import { DidJwk } from '@enbox/dids';
import { ensureDelegateX25519PrivateKey } from '@enbox/agent';
import { ConnectClient, RelayClientTransport } from '@enbox/connect';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

/**
 * Options for initiating a wallet connect flow (remote, relay-mediated).
 *
 * This is the client-level options type used by `initClient()`. The auth-level
 * `WalletConnectOptions` (in `types.ts`) wraps this with additional fields
 * like `sync`.
 */
export type WalletConnectClientOptions = {
  /** The user-friendly name of the app, displayed in the wallet consent UI. */
  displayName: string;

  /** Optional icon URL for the app, displayed in the wallet consent UI. */
  appIcon?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /** Preferred session TTL in seconds. Wallets may clamp this to their policy maximum. */
  requestedSessionTtlSeconds?: number;

  /**
   * Generate a local delegate DID and send its URI in the connect request.
   *
   * This keeps delegate signing keys in the requesting process. If omitted,
   * the wallet mints and returns the delegate DID as before.
   */
  preSupplyDelegateDid?: boolean;

  /**
   * Existing local delegate DID to request grants for. Takes precedence over
   * `preSupplyDelegateDid` and must include private keys so auth can import it.
   */
  delegatePortableDid?: PortableDid;

  /** The URL of the connect server which relays messages between the app and wallet. */
  connectServerUrl: string;

  /**
   * The URI of the wallet app. Fragment params (`request_uri`, `encryption_key`)
   * are appended and passed to `onWalletUriReady`.
   * @example `enbox://connect` or `http://localhost:3000/`
   */
  walletUri: string;

  /**
   * The protocols of permissions requested, along with the definition and
   * permission scopes for each protocol.
   */
  permissionRequests: ConnectPermissionRequest[];

  /**
   * Called with the wallet URI carrying fragment params (`request_uri`, `encryption_key`).
   * The app should render this as a QR code or use it as a deep link.
   *
   * @param uri - The wallet URI with connect payload.
   */
  onWalletUriReady: (uri: string) => Promise<void> | void;

  /**
   * Called to collect the PIN from the user. The PIN strengthens the
   * decryption key for the connect response from the relay.
   *
   * @returns A promise that resolves to the PIN as a string.
   */
  validatePin: () => Promise<string>;

  /**
   * Milliseconds to poll the relay for a wallet response.
   * @default 300_000
   */
  timeoutMs?: number;

  /**
   * Milliseconds between relay polling attempts.
   * @default 3000
   */
  pollIntervalMs?: number;
};

/**
 * The options for creating a permission request for a given protocol.
 */
export type ProtocolPermissionOptions = {
  /** The protocol definition for the protocol being requested */
  definition: DwnProtocolDefinition;

  /** The permissions being requested for the protocol */
  permissions: Permission[];
};

/**
 * Initiates the wallet connect process. Used when a client wants to obtain
 * a delegated DID from a provider.
 *
 * @returns The kernel `ConnectResult`, or `undefined` when the user denied
 *          the request in the wallet.
 */
async function initClient({
  displayName,
  appIcon,
  clientMetadata,
  requestedSessionTtlSeconds,
  preSupplyDelegateDid,
  delegatePortableDid,
  connectServerUrl,
  walletUri,
  permissionRequests,
  onWalletUriReady,
  validatePin,
  timeoutMs,
  pollIntervalMs,
}: WalletConnectClientOptions): Promise<ConnectResult | undefined> {
  const localDelegatePortableDid = await resolveLocalDelegatePortableDid({
    delegatePortableDid,
    preSupplyDelegateDid,
  });

  const client = new ConnectClient({
    transport: new RelayClientTransport({
      connectServerUrl,
      walletUri,
      timeoutMs,
      pollIntervalMs,
    }),
    onWalletUriReady : async (handoff): Promise<void> => { await onWalletUriReady(handoff.walletUri); },
    requestPin       : validatePin,
  });

  return await client.connect({
    appName             : displayName,
    appIcon,
    clientMetadata,
    permissionRequests,
    requestedSessionTtlSeconds,
    delegatePortableDid : localDelegatePortableDid,
  });
}

async function resolveLocalDelegatePortableDid({
  delegatePortableDid,
  preSupplyDelegateDid,
}: {
  delegatePortableDid?: PortableDid;
  preSupplyDelegateDid?: boolean;
}): Promise<PortableDid | undefined> {
  if (delegatePortableDid !== undefined) {
    return prepareDelegatePortableDid(delegatePortableDid);
  }

  if (preSupplyDelegateDid === true) {
    return createDelegatePortableDid();
  }

  return undefined;
}

async function createDelegatePortableDid(): Promise<PortableDid> {
  const delegateBearerDid = await DidJwk.create();
  return prepareDelegatePortableDid(await delegateBearerDid.export());
}

/**
 * Ensures a caller-supplied delegate DID carries an X25519 private key,
 * deriving one from its Ed25519 private key when missing. DWN record-level
 * encryption requires an X25519 key-agreement key on the delegate.
 */
async function prepareDelegatePortableDid(delegatePortableDid: PortableDid): Promise<PortableDid> {
  const { portableDid } = await ensureDelegateX25519PrivateKey(delegatePortableDid);
  return portableDid;
}

/**
 * Creates a set of Dwn Permission Scopes to request for a given protocol.
 *
 * If no permissions are provided, the default permissions from
 * {@link DEFAULT_PERMISSIONS} are used (read, write, delete). Protocol configuration
 * is wallet-owned; app delegates request record access, not permission to configure
 * protocols themselves.
 */
function createPermissionRequestForProtocol({ definition, permissions }: ProtocolPermissionOptions): ConnectPermissionRequest {
  const requests: DwnPermissionScope[] = [];

  // Add the ability to query for the specific protocol
  requests.push({
    protocol  : definition.protocol,
    interface : DwnInterfaceName.Protocols,
    method    : DwnMethodName.Query,
  });

  // A Messages.Read grant is a unified scope for protocol message feeds and
  // real-time subscriptions.
  requests.push({
    protocol  : definition.protocol,
    interface : DwnInterfaceName.Messages,
    method    : DwnMethodName.Read,
  });

  // We also request any additional permissions the user has requested for this protocol
  for (const permission of permissions) {
    switch (permission) {
      case 'write':
        requests.push({
          protocol  : definition.protocol,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
        });
        break;
      case 'read':
        requests.push({
          protocol  : definition.protocol,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
        });
        break;
      case 'delete':
        requests.push({
          protocol  : definition.protocol,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Delete,
        });
        break;
      default:
        throw new Error(
          `Unsupported connect permission '${String(permission)}'. Supported permissions: read, write, delete.`
        );
    }
  }

  return {
    protocolDefinition : definition,
    permissionScopes   : requests,
  };
}

export const WalletConnect = { initClient, createPermissionRequestForProtocol };
