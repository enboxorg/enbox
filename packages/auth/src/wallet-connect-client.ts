/**
 * WalletConnect client — initiates the relay-mediated connect flow.
 *
 * Moved from `@enbox/agent/src/connect.ts` because `initClient` has zero
 * coupling to agent internals (no vault, no key store, no DWN processing,
 * no sync). Its only consumer is `auth/src/connect/wallet.ts`.
 *
 * The server-side counterpart (`EnboxConnectProtocol`) correctly stays in
 * `@enbox/agent` because it uses `agent.processDwnRequest()`,
 * `agent.sendDwnRequest()`, and `AgentPermissionsApi`.
 *
 * @module
 */

import type { Permission } from './types.js';
import type { PortableDid } from '@enbox/dids';
import type { PrivateKeyJwk } from '@enbox/crypto';
import type {
  ConnectClientMetadata,
  ConnectPermissionRequest,
  ConnectPushedResponse,
  DwnPermissionScope,
  DwnProtocolDefinition,
  EnboxConnectResponse,
} from '@enbox/agent';

import { DidJwk } from '@enbox/dids';
import { logger } from '@enbox/common';
import { CryptoUtils, Ed25519 } from '@enbox/crypto';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';
import { EnboxConnectProtocol, pollWithTtl } from '@enbox/agent';

/**
 * Options for initiating a wallet connect flow (remote, relay-mediated).
 *
 * This is the agent-level options type used by `initClient()`. The auth-level
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
   * permission scopes for each protocol. The key is the protocol URL and
   * the value is an object with the protocol definition and the permission scopes.
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
   * Called to collect the PIN from the user. The PIN is used as AAD
   * when decrypting the connect response from the relay.
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
 * a did from a provider.
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
  timeoutMs = 300_000,
  pollIntervalMs = 3000,
}: WalletConnectClientOptions): Promise<{
  delegateGrants: EnboxConnectResponse['delegateGrants'];
  delegatePortableDid: PortableDid;
  connectedDid: string;
  sessionRevocations?: EnboxConnectResponse['sessionRevocations'];
} | undefined> {
  // ephemeral client did for ECDH, signing, verification
  const clientDid = await DidJwk.create();
  const localDelegatePortableDid = await resolveLocalDelegatePortableDid({
    delegatePortableDid,
    preSupplyDelegateDid,
  });

  // TODO: properly implement PKCE. this implementation is lacking server side validations and more.
  // https://github.com/enboxorg/enbox/issues/829
  // Derive the code challenge based on the code verifier
  // const { codeChallengeBytes, codeChallengeBase64Url } =
  //   await Oidc.generateCodeChallenge();
  const encryptionKey = CryptoUtils.randomBytes(32);

  // Build callback URL for the connect request.
  const callbackEndpoint = EnboxConnectProtocol.buildConnectUrl({
    baseURL  : connectServerUrl,
    endpoint : 'callback',
  });

  // Build the connect request.
  const request = await EnboxConnectProtocol.createConnectRequest({
    clientDid          : clientDid.uri,
    callbackUrl        : callbackEndpoint,
    permissionRequests : permissionRequests,
    appName            : displayName,
    appIcon,
    clientMetadata,
    requestedSessionTtlSeconds,
    delegateDid        : localDelegatePortableDid?.uri,
  });

  // Sign the request as a JWT.
  const requestJwt = await EnboxConnectProtocol.signJwt({
    did  : clientDid,
    data : request,
  });

  if (!requestJwt) {
    throw new Error('Unable to sign requestObject');
  }
  // Encrypt the request JWT with the symmetric key.
  const requestObjectJwe = await EnboxConnectProtocol.encryptRequest({
    jwt: requestJwt,
    encryptionKey,
  });

  const pushedAuthorizationRequestEndpoint = EnboxConnectProtocol.buildConnectUrl({
    baseURL  : connectServerUrl,
    endpoint : 'pushedAuthorizationRequest',
  });

  const parResponse = await fetch(pushedAuthorizationRequestEndpoint, {
    body    : JSON.stringify({ request: requestObjectJwe }),
    method  : 'POST',
    headers : {
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!parResponse.ok) {
    throw new Error(`${parResponse.status}: ${parResponse.statusText}`);
  }

  const parData: ConnectPushedResponse = await parResponse.json();

  // a deeplink to a compatible wallet. if the wallet scans this link it should receive
  // a route to its Connect provider flow and the params of where to fetch the auth request.
  logger.log(`Wallet URI: ${walletUri}`);
  const generatedWalletUri = EnboxConnectProtocol.buildWalletConnectUri({
    walletUri,
    requestUri: parData.request_uri,
    encryptionKey,
  });

  // call user's callback so they can send the URI to the wallet as they see fit
  await onWalletUriReady(generatedWalletUri);

  const tokenUrl = EnboxConnectProtocol.buildConnectUrl({
    baseURL    : connectServerUrl,
    endpoint   : 'token',
    tokenParam : request.state,
  });

  // subscribe to receiving a response from the wallet. receive ciphertext of {@link EnboxConnectResponse}
  const authResponse = await pollWithTtl(
    () => fetch(tokenUrl, { signal: AbortSignal.timeout(30_000) }),
    pollIntervalMs,
    timeoutMs,
  );

  if (authResponse) {
    const jwe = await authResponse?.text();

    // Check for explicit denial from the wallet.
    if (jwe === 'DENIED') {
      return undefined;
    }

    // Get the PIN from the user and use it as AAD to decrypt.
    const pin = await validatePin();
    const jwt = await EnboxConnectProtocol.decryptResponse(clientDid, jwe, pin);
    const verifiedPayload = await EnboxConnectProtocol.verifyJwt({ jwt });
    // Runtime narrowing — see `assertConnectResponse` in @enbox/agent for
    // the shape validated. After this line `verifiedPayload` is narrowed
    // to `EnboxConnectResponse`.
    EnboxConnectProtocol.assertConnectResponse(verifiedPayload);
    const resolvedDelegatePortableDid = resolveDelegatePortableDid({
      localDelegatePortableDid,
      response: verifiedPayload,
    });

    return {
      delegateGrants      : verifiedPayload.delegateGrants,
      delegatePortableDid : resolvedDelegatePortableDid,
      connectedDid        : verifiedPayload.providerDid,
      sessionRevocations  : verifiedPayload.sessionRevocations,
    };
  }
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

async function prepareDelegatePortableDid(delegatePortableDid: PortableDid): Promise<PortableDid> {
  const privateKeys = [...(delegatePortableDid.privateKeys ?? [])];
  if (privateKeys.length === 0) {
    throw new Error('WalletConnect: delegatePortableDid must include private keys.');
  }

  const delegateEdPrivateKey = privateKeys.find((key) => key.crv === 'Ed25519');
  if (delegateEdPrivateKey === undefined) {
    throw new Error('WalletConnect: delegatePortableDid must include an Ed25519 private key.');
  }

  const hasX25519Key = privateKeys.some((key) => key.crv === 'X25519');
  if (!hasX25519Key) {
    const delegateX25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
      privateKey: delegateEdPrivateKey as PrivateKeyJwk,
    });
    privateKeys.push(delegateX25519PrivateKey);
  }

  return {
    ...delegatePortableDid,
    privateKeys,
  };
}

function resolveDelegatePortableDid({
  localDelegatePortableDid,
  response,
}: {
  localDelegatePortableDid?: PortableDid;
  response: EnboxConnectResponse;
}): PortableDid {
  if (localDelegatePortableDid !== undefined) {
    if (response.delegateDid !== localDelegatePortableDid.uri) {
      throw new Error(
        `WalletConnect: wallet returned delegate DID '${response.delegateDid}', but '${localDelegatePortableDid.uri}' was requested. ` +
        'Revoke the just-approved session in the wallet and try again.'
      );
    }
    return localDelegatePortableDid;
  }

  if (response.delegatePortableDid === undefined) {
    throw new Error('WalletConnect: wallet response omitted delegatePortableDid.');
  }

  return response.delegatePortableDid;
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
