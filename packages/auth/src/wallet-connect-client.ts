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

import type { ConnectPermissionRequest, DwnPermissionScope, DwnProtocolDefinition } from '@enbox/agent';
import type { ConnectPushedResponse, EnboxConnectResponse } from '@enbox/agent';

import { CryptoUtils } from '@enbox/crypto';
import { DidJwk } from '@enbox/dids';
import { Convert, logger } from '@enbox/common';
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

  /** The URL of the connect server which relays messages between the app and wallet. */
  connectServerUrl: string;

  /**
   * The URI of the wallet app. Query params (`request_uri`, `encryption_key`)
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
   * Called with the wallet URI including query params (`request_uri`, `encryption_key`).
   * The app should render this as a QR code or use it as a deep link.
   *
   * @param uri - The wallet URI with connect payload.
   */
  onWalletUriReady: (uri: string) => void;

  /**
   * Called to collect the PIN from the user. The PIN is used as AAD
   * when decrypting the connect response from the relay.
   *
   * @returns A promise that resolves to the PIN as a string.
   */
  validatePin: () => Promise<string>;
};

/**
 * Shorthand for the types of permissions that can be requested.
 */
export type Permission = 'write' | 'read' | 'delete' | 'query' | 'subscribe' | 'configure';

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
  connectServerUrl,
  walletUri,
  permissionRequests,
  onWalletUriReady,
  validatePin,
}: WalletConnectClientOptions): Promise<{
  delegateGrants: EnboxConnectResponse['delegateGrants'];
  delegatePortableDid: EnboxConnectResponse['delegatePortableDid'];
  connectedDid: string;
} | undefined> {
  // ephemeral client did for ECDH, signing, verification
  const clientDid = await DidJwk.create();

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
  });

  // Sign the request as a JWT.
  const requestJwt = await EnboxConnectProtocol.signJwt({
    did  : clientDid,
    data : request as unknown as Record<string, unknown>,
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
  const generatedWalletUri = new URL(walletUri);
  generatedWalletUri.searchParams.set('request_uri', parData.request_uri);
  generatedWalletUri.searchParams.set(
    'encryption_key',
    Convert.uint8Array(encryptionKey).toBase64Url()
  );

  // call user's callback so they can send the URI to the wallet as they see fit
  onWalletUriReady(generatedWalletUri.toString());

  const tokenUrl = EnboxConnectProtocol.buildConnectUrl({
    baseURL    : connectServerUrl,
    endpoint   : 'token',
    tokenParam : request.state,
  });

  // subscribe to receiving a response from the wallet with default TTL. receive ciphertext of {@link EnboxConnectResponse}
  const authResponse = await pollWithTtl(() => fetch(tokenUrl, { signal: AbortSignal.timeout(30_000) }));

  if (authResponse) {
    const jwe = await authResponse?.text();

    // Get the PIN from the user and use it as AAD to decrypt.
    const pin = await validatePin();
    const jwt = await EnboxConnectProtocol.decryptResponse(clientDid, jwe, pin);
    const verifiedResponse = (await EnboxConnectProtocol.verifyJwt({
      jwt,
    })) as unknown as EnboxConnectResponse;

    return {
      delegateGrants      : verifiedResponse.delegateGrants,
      delegatePortableDid : verifiedResponse.delegatePortableDid,
      connectedDid        : verifiedResponse.providerDid,
    };
  }
}

/**
 * Creates a set of Dwn Permission Scopes to request for a given protocol.
 *
 * If no permissions are provided, the default is to request all relevant record permissions (write, read, delete, query, subscribe).
 * 'configure' is not included by default, as this gives the application a lot of control over the protocol.
 */
function createPermissionRequestForProtocol({ definition, permissions }: ProtocolPermissionOptions): ConnectPermissionRequest {
  const requests: DwnPermissionScope[] = [];

  // Add the ability to query for the specific protocol
  requests.push({
    protocol  : definition.protocol,
    interface : DwnInterfaceName.Protocols,
    method    : DwnMethodName.Query,
  });

  // A Messages.Read grant is a unified scope that covers MessagesRead, MessagesSync, and MessagesSubscribe.
  // This single grant enables sync and real-time subscriptions for the protocol.
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
      case 'query':
        requests.push({
          protocol  : definition.protocol,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Query,
        });
        break;
      case 'subscribe':
        requests.push({
          protocol  : definition.protocol,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Subscribe,
        });
        break;
      case 'configure':
        requests.push({
          protocol  : definition.protocol,
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Configure,
        });
        break;
    }
  }

  return {
    protocolDefinition : definition,
    permissionScopes   : requests,
  };
}

export const WalletConnect = { initClient, createPermissionRequestForProtocol };
