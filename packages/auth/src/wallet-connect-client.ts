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
import type {
  ConnectAuthenticationParams,
  ConnectAuthenticationResult,
  ConnectClientMetadata,
  ConnectClientOptions,
  ConnectPermissionRequest,
  ConnectRequestType,
  ConnectResult,
} from '@enbox/connect';
import type { DwnModuleDefinition, DwnPermissionScope } from '@enbox/agent';

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

  /** Stable application identifier hint available to the wallet during approval. */
  applicationId?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /**
   * Advisory preferred session TTL in seconds. The provider-approved lifetime
   * is authoritative and may be shorter or longer, subject to provider policy.
   */
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

  /** Explicit wallet UI signal. Omitted for an initial connect. */
  requestType?: Exclude<ConnectRequestType, 'authenticate'>;

  /** Wallet profile DID that the approval must use. */
  expectedProviderDid?: string;

  /** Optional owner authentication requested alongside DWN delegation. */
  authentication?: ConnectAuthenticationParams;

  /** DID resolver used to verify the owner's authentication key. */
  authenticationResolver?: ConnectClientOptions['authenticationResolver'];

  /** Register the full authentication request with the service before wallet delivery. */
  onAuthenticationRequest?: ConnectClientOptions['onAuthenticationRequest'];

  /** The URL of the connect server which relays messages between the app and wallet. */
  connectServerUrl: string;

  /**
   * The URI of the wallet app. Fragment params (`request_uri`, `encryption_key`)
   * are appended and passed to `onWalletUriReady`.
   * @example `enbox://connect` or `http://localhost:3000/`
   */
  walletUri: string;

  /**
   * The modules of permissions requested, along with the definition and
   * permission scopes for each module.
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
 * Identity-only relay authentication. This does not create a delegate or an
 * AuthManager session. Authentication-enabled wallets must trust the relay's
 * request origin according to their own requester policy.
 */
export type WalletAuthenticationClientOptions = Omit<WalletConnectClientOptions,
  'permissionRequests' | 'preSupplyDelegateDid' | 'delegatePortableDid' | 'requestType' |
  'requestedSessionTtlSeconds' | 'authentication'> & {
    authentication: ConnectAuthenticationParams;
  };

/**
 * The options for creating a permission request for a given module.
 */
export type ModulePermissionOptions = {
  /** The module definition for the module being requested */
  definition: DwnModuleDefinition;

  /** The permissions being requested for the module */
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
  applicationId,
  clientMetadata,
  requestedSessionTtlSeconds,
  preSupplyDelegateDid,
  delegatePortableDid,
  requestType,
  expectedProviderDid,
  authentication,
  authenticationResolver,
  onAuthenticationRequest,
  connectServerUrl,
  walletUri,
  permissionRequests,
  onWalletUriReady,
  validatePin,
  timeoutMs,
  pollIntervalMs,
}: WalletConnectClientOptions): Promise<ConnectResult | undefined> {
  if ((requestType as ConnectRequestType | undefined) === 'authenticate') {
    throw new Error('Connect: use WalletConnect.initAuthentication for an authentication-only request.');
  }
  if (requestType === 'refresh' && delegatePortableDid === undefined) {
    throw new Error('Connect: refresh requests require an existing `delegatePortableDid`.');
  }

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
    authenticationResolver,
    onAuthenticationRequest,
  });

  return await client.connect({
    appName             : displayName,
    appIcon,
    applicationId,
    clientMetadata,
    permissionRequests,
    requestedSessionTtlSeconds,
    delegatePortableDid : localDelegatePortableDid,
    requestType,
    expectedProviderDid,
    authentication,
  });
}

/** Run a relay login without importing credentials or creating an AgentSession. */
async function initAuthentication(options: WalletAuthenticationClientOptions): Promise<ConnectAuthenticationResult | undefined> {
  const client = new ConnectClient({
    transport: new RelayClientTransport({
      connectServerUrl : options.connectServerUrl,
      walletUri        : options.walletUri,
      timeoutMs        : options.timeoutMs,
      pollIntervalMs   : options.pollIntervalMs,
    }),
    onWalletUriReady        : async (handoff): Promise<void> => { await options.onWalletUriReady(handoff.walletUri); },
    requestPin              : options.validatePin,
    authenticationResolver  : options.authenticationResolver,
    onAuthenticationRequest : options.onAuthenticationRequest,
  });
  return await client.authenticate({
    appName             : options.displayName,
    appIcon             : options.appIcon,
    applicationId       : options.applicationId,
    clientMetadata      : options.clientMetadata,
    expectedProviderDid : options.expectedProviderDid,
    authentication      : options.authentication,
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
 * Creates a set of Dwn Permission Scopes to request for a given module.
 *
 * If no permissions are provided, the default permissions from
 * {@link DEFAULT_PERMISSIONS} are used (read, write, delete). Module configuration
 * is wallet-owned; app delegates request record access, not permission to configure
 * modules themselves.
 */
function createPermissionRequestForModule({ definition, permissions }: ModulePermissionOptions): ConnectPermissionRequest {
  const requests: DwnPermissionScope[] = [];

  requests.push(
    // Add the ability to query for the specific module
    {
      module    : definition.module,
      interface : DwnInterfaceName.Modules,
      method    : DwnMethodName.Query,
    },
    // A Messages.Read grant is a unified scope for module message feeds and
    // real-time subscriptions.
    {
      module    : definition.module,
      interface : DwnInterfaceName.Messages,
      method    : DwnMethodName.Read,
    },
  );

  // We also request any additional permissions the user has requested for this module
  for (const permission of permissions) {
    switch (permission) {
      case 'write':
        requests.push({
          module    : definition.module,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
        });
        break;
      case 'read':
        requests.push({
          module    : definition.module,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
        });
        break;
      case 'delete':
        requests.push({
          module    : definition.module,
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
    moduleDefinition : definition,
    permissionScopes : requests,
  };
}

export const WalletConnect = { initClient, initAuthentication, createPermissionRequestForModule };
