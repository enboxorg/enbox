/**
 * App-side connect orchestration.
 *
 * `ConnectClient` drives one handshake end-to-end over any
 * {@link ConnectTransport}: it mints the ephemeral client DID and a fresh
 * X25519 response key, builds and seals the request with the transport's
 * channel profile, delivers it, awaits the wallet's ciphertext, and opens the
 * response with the mandatory value checks before mapping it to a
 * {@link ConnectResult} for the auth completion seam.
 *
 * @module
 */

import type { Jwk } from '@enbox/crypto';
import type { PortableDid } from '@enbox/dids';
import type {
  ConnectClientMetadata,
  ConnectPermissionRequest,
  ConnectRequest,
  ConnectResponse,
  ConnectResult,
  ConnectTransport,
  WalletUriHandoff,
} from './types.js';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { CryptoUtils, X25519 } from '@enbox/crypto';

import { CONNECT_DENIED_TOKEN } from './types.js';
import { openResponse, sealRequest } from './envelope.js';

/** DID methods a connect client accepts for the connected identity by default. */
const DEFAULT_SUPPORTED_DID_METHODS = ['did:dht', 'did:jwk'];

/**
 * Returns a fresh random token: 16 random bytes, base64url-encoded.
 *
 * Used for the protocol-level correlators the client owns (`nonce`, `state`);
 * consumers can reuse it for other opaque identifiers (e.g. session IDs).
 */
export function randomToken(): string {
  return Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url();
}

/** Options for constructing a {@link ConnectClient}. */
export type ConnectClientOptions = {
  /** The channel transport that carries the sealed envelopes. */
  transport: ConnectTransport;

  /**
   * Called when the transport hands back a wallet URI (QR/deep-link
   * channels). The app should render it as a QR code or use it as a deep
   * link. Required when the transport produces a handoff.
   */
  onWalletUriReady?: (handoff: WalletUriHandoff) => Promise<void> | void;

  /**
   * Called to collect the PIN from the user on PIN-strengthened channels
   * (`transport.requiresPin`). Required for such transports.
   */
  requestPin?: () => Promise<string>;
};

/** Parameters for a single {@link ConnectClient.connect} handshake. */
export type ConnectClientConnectParams = {
  /** The user-friendly name of the app, displayed in the wallet consent UI. */
  appName: string;

  /** Optional icon URL for the app, displayed in the wallet consent UI. */
  appIcon?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /** DWN protocols and permission scopes being requested. */
  permissionRequests: ConnectPermissionRequest[];

  /** Preferred session TTL in seconds. Wallets may clamp this to their policy maximum. */
  requestedSessionTtlSeconds?: number;

  /**
   * Existing local delegate DID to request grants for. Keeps delegate signing
   * keys in the requesting process: its URI is sent as the request's
   * `delegateDid` and the wallet grants to it instead of minting and
   * returning a new delegate. Must include private keys.
   */
  delegatePortableDid?: PortableDid;

  /**
   * Supported DID methods for the connected identity.
   * @default ['did:dht', 'did:jwk']
   */
  supportedDidMethods?: string[];
};

/**
 * Drives the app side of the connect handshake over a channel transport.
 *
 * @example
 * ```ts
 * const client = new ConnectClient({
 *   transport        : new RelayClientTransport({ connectServerUrl, walletUri }),
 *   onWalletUriReady : (handoff) => renderQrCode(handoff.walletUri),
 *   requestPin       : () => promptUserForPin(),
 * });
 *
 * const result = await client.connect({ appName: 'My App', permissionRequests });
 * if (result === undefined) {
 *   // The user denied the request in the wallet.
 * }
 * ```
 */
export class ConnectClient {
  private readonly _transport: ConnectTransport;
  private readonly _onWalletUriReady?: (handoff: WalletUriHandoff) => Promise<void> | void;
  private readonly _requestPin?: () => Promise<string>;

  constructor(options: ConnectClientOptions) {
    this._transport = options.transport;
    this._onWalletUriReady = options.onWalletUriReady;
    this._requestPin = options.requestPin;
  }

  /**
   * Executes one connect handshake: build + sign + seal the request, deliver
   * it, await the wallet's ciphertext, open and value-check the response, and
   * map it to a {@link ConnectResult}.
   *
   * @param params - The handshake parameters.
   * @returns The delegated credentials, or `undefined` when the user denied
   *          the request in the wallet.
   */
  public async connect(params: ConnectClientConnectParams): Promise<ConnectResult | undefined> {
    // Ephemeral client DID (did:jwk) for request signing and response addressing.
    const clientDid = await DidJwk.create();

    // Fresh X25519 key pair for this handshake; the wallet seals its response
    // to the public half via ECDH-ES. Only the minimum key material
    // (kty, crv, x) is placed in the request to avoid leaking identifiers.
    const responsePrivateKey = await X25519.generateKey();
    const responsePublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x };

    // Protocol-level correlators owned by the client: the anti-replay nonce
    // and the request/response state echo (also the response JWE `apu` value).
    const nonce = randomToken();
    const state = randomToken();

    const profile = await this._transport.requestProfile(state);

    const request: ConnectRequest = {
      clientDid                  : clientDid.uri,
      appName                    : params.appName,
      appIcon                    : params.appIcon,
      clientMetadata             : params.clientMetadata,
      permissionRequests         : params.permissionRequests,
      requestedSessionTtlSeconds : params.requestedSessionTtlSeconds,
      delegateDid                : params.delegatePortableDid?.uri,
      supportedDidMethods        : params.supportedDidMethods ?? [...DEFAULT_SUPPORTED_DID_METHODS],
      nonce,
      state,
      responseKey                : responsePublicKey,
      reply                      : profile.reply,
    };

    const requestJwe = await sealRequest({ request, signer: clientDid, encryption: profile.encryption });

    const handoff = await this._transport.deliverRequest(requestJwe);
    if (handoff !== undefined) {
      if (this._onWalletUriReady === undefined) {
        throw new Error('Connect: transport produced a wallet URI but no `onWalletUriReady` callback was provided.');
      }
      await this._onWalletUriReady(handoff);
    }

    const responseCiphertext = await this._transport.awaitResponse();
    if (responseCiphertext === CONNECT_DENIED_TOKEN) {
      return undefined;
    }

    let pin: string | undefined;
    if (this._transport.requiresPin) {
      if (this._requestPin === undefined) {
        throw new Error('Connect: transport requires a PIN but no `requestPin` callback was provided.');
      }
      pin = await this._requestPin();
    }

    const response = await openResponse({
      jwe                 : responseCiphertext,
      recipientPrivateKey : responsePrivateKey,
      expected            : { clientDid: clientDid.uri, nonce, state },
      pin,
    });

    const delegatePortableDid = resolveDelegatePortableDid({
      localDelegatePortableDid: params.delegatePortableDid,
      response,
    });

    // Best-effort completion signal so the wallet side can flip its pairing
    // screen to a confirmed "connected" state. Fire-and-forget: it must
    // never delay or fail the handshake result.
    void this._transport.confirmComplete?.().catch((): undefined => undefined);

    return {
      delegatePortableDid,
      delegateGrants     : response.delegateGrants,
      connectedDid       : response.providerDid,
      sessionRevocations : response.sessionRevocations,
    };
  }
}

/**
 * Resolves which portable delegate DID a handshake yields: the locally
 * supplied one (which the wallet must have granted to) or the wallet-minted
 * one carried in the response.
 */
function resolveDelegatePortableDid({ localDelegatePortableDid, response }: {
  localDelegatePortableDid?: PortableDid;
  response: ConnectResponse;
}): PortableDid {
  if (localDelegatePortableDid !== undefined) {
    if (response.delegateDid !== localDelegatePortableDid.uri) {
      throw new Error(
        `Connect: wallet returned delegate DID '${response.delegateDid}', but '${localDelegatePortableDid.uri}' was requested. ` +
        'Revoke the just-approved session in the wallet and try again.'
      );
    }
    return localDelegatePortableDid;
  }

  if (response.delegatePortableDid === undefined) {
    throw new Error('Connect: wallet response omitted `delegatePortableDid`.');
  }

  return response.delegatePortableDid;
}
