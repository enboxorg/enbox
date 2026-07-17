/**
 * Relay connect runner — the dapp side of the QR/deep-link connect flow,
 * with interactive PIN retry.
 *
 * This mirrors the `@enbox/connect` kernel `ConnectClient` step-for-step and
 * is composed entirely from the kernel's exported primitives (`sealRequest`,
 * `openResponse`, `RelayClientTransport`); no cryptography is reimplemented
 * here. It exists as a separate orchestrator for one reason the kernel
 * client cannot express today: **PIN retry against the delivered response**.
 * `ConnectClient` collects the PIN once and opens the response once, so a
 * mistyped code fails the whole handshake — the wallet user would have to
 * scan and approve again. The connect modal instead keeps the sealed
 * response and re-runs `openResponse` per attempt, which is safe because
 * opening is a pure decrypt-and-verify step.
 *
 * If the kernel later grows a PIN-attempts seam, this module collapses into
 * `ConnectClient` usage.
 *
 * @module
 */

import type { Jwk } from '@enbox/crypto';
import type { PortableDid } from '@enbox/dids';
import type {
  ConnectClientMetadata,
  ConnectPermissionRequest,
  ConnectRequest,
  ConnectRequestType,
  ConnectResult,
  WalletUriHandoff,
} from '@enbox/connect';

import { DidJwk } from '@enbox/dids';
import { X25519 } from '@enbox/crypto';
import {
  CONNECT_DENIED_TOKEN,
  openResponse,
  randomToken,
  RelayClientTransport,
  resolveDelegatePortableDid,
  sealRequest,
} from '@enbox/connect';

/** Maximum interactive PIN attempts before the handshake fails. */
export const MAX_PIN_ATTEMPTS = 6;

/** Thrown internally when a relay handshake is cancelled by the UI. */
export class RelayConnectCancelledError extends Error {
  constructor() {
    super('[@enbox/browser] Relay connect cancelled.');
    this.name = 'RelayConnectCancelledError';
  }
}

/** Options for {@link runRelayConnect}. */
export interface RelayConnectOptions {
  /** Relay base URL (the wallet's `connectServerUrl`). */
  connectServerUrl: string;

  /** Wallet URI the request pointer is attached to (QR / deep-link target). */
  walletUri: string;

  /** The user-friendly name of the app, shown in the wallet consent UI. */
  appName: string;

  /** Optional icon URL for the app, shown in the wallet consent UI. */
  appIcon?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /** DWN protocols and permission scopes being requested. */
  permissionRequests: ConnectPermissionRequest[];

  /** Existing delegate credentials reused by a refresh request. */
  delegatePortableDid?: PortableDid;

  /** User-facing request purpose. Absent means a normal connect. */
  requestType?: ConnectRequestType;

  /** Total milliseconds to poll the relay for a wallet response. */
  timeoutMs?: number;

  /** Milliseconds between relay polling attempts. */
  pollIntervalMs?: number;

  /**
   * Receives the wallet URI handoff (with the request pointer TTL) as soon
   * as the request is delivered — render it as a QR code or deep link.
   */
  onWalletUriReady: (handoff: WalletUriHandoff) => void;

  /**
   * Collects one PIN attempt from the user. Called again (with the attempt
   * number, 1-based, and the previous failure) after a wrong code, up to
   * {@link MAX_PIN_ATTEMPTS} times.
   */
  requestPin: (attempt: number, previousError?: Error) => Promise<string>;

  /**
   * Cancellation signal: when it settles, polling stops and the handshake
   * rejects with {@link RelayConnectCancelledError}.
   */
  cancelled?: Promise<never>;

  /**
   * Invoked once when the relay reports the wallet has claimed (fetched)
   * the pushed request — the app can show "phone connected" progress.
   */
  onClaimed?: () => void;

  /** Transport factory override (tests). */
  createTransport?: (options: {
    connectServerUrl: string;
    walletUri: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onClaimed?: () => void;
    signal?: AbortSignal;
  }) => Pick<RelayClientTransport, 'requestProfile' | 'deliverRequest' | 'awaitResponse' | 'requiresPin'>
    & Partial<Pick<RelayClientTransport, 'confirmComplete'>>;
}

/**
 * Sleep used between relay polls that ends early when the page returns to
 * the foreground. Browsers throttle — and mobile browsers freeze — timers in
 * background tabs, so a plain interval sleep can leave the user staring at a
 * stale stage after approving in the wallet tab; cutting the sleep short on
 * `visibilitychange` makes the next poll (and with it the pairing-code
 * prompt) land the moment they switch back. Falls back to a plain sleep
 * outside DOM environments.
 */
export function visibilityAwareSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      setTimeout(resolve, ms);
      return;
    }

    const finish = (): void => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resolve();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        finish();
      }
    };
    const timer = setTimeout(finish, ms);
    document.addEventListener('visibilitychange', onVisibilityChange);
  });
}

/**
 * Runs one relay-mediated connect handshake end-to-end and returns the
 * delegated credentials, or `undefined` when the user denied in the wallet.
 */
export async function runRelayConnect(options: RelayConnectOptions): Promise<ConnectResult | undefined> {
  if (options.requestType === 'refresh' && options.delegatePortableDid === undefined) {
    throw new Error('Connect: refresh requests require an existing `delegatePortableDid`.');
  }

  const createTransport = options.createTransport
    ?? ((transportOptions): RelayClientTransport => new RelayClientTransport({
      ...transportOptions,
      sleep: visibilityAwareSleep,
    }));

  const cancellationController = options.cancelled === undefined ? undefined : new AbortController();
  const transport = createTransport({
    connectServerUrl : options.connectServerUrl,
    walletUri        : options.walletUri,
    timeoutMs        : options.timeoutMs,
    pollIntervalMs   : options.pollIntervalMs,
    onClaimed        : options.onClaimed,
    signal           : cancellationController?.signal,
  });

  // Ephemeral client DID for request signing and response addressing, and a
  // fresh X25519 pair the wallet seals the response to — same shape as the
  // kernel `ConnectClient`.
  const clientDid = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();
  const responsePublicKey: Jwk = { kty: 'OKP', crv: 'X25519', x: responsePrivateKey.x };

  const nonce = randomToken();
  const state = randomToken();

  const profile = await transport.requestProfile(state);

  const request: ConnectRequest = {
    clientDid           : clientDid.uri,
    appName             : options.appName,
    appIcon             : options.appIcon,
    clientMetadata      : options.clientMetadata,
    permissionRequests  : options.permissionRequests,
    delegateDid         : options.delegatePortableDid?.uri,
    requestType         : options.requestType,
    supportedDidMethods : ['did:dht', 'did:jwk'],
    nonce,
    state,
    responseKey         : responsePublicKey,
    reply               : profile.reply,
  };

  const requestJwe = await sealRequest({ request, signer: clientDid, encryption: profile.encryption });

  const handoff = await transport.deliverRequest(requestJwe);
  if (handoff !== undefined) {
    options.onWalletUriReady(handoff);
  }

  const race = options.cancelled === undefined
    ? transport.awaitResponse()
    : Promise.race([transport.awaitResponse(), options.cancelled]);

  let responseCiphertext: string;
  try {
    responseCiphertext = await race;
  } catch (error) {
    cancellationController?.abort();
    throw error;
  }
  if (responseCiphertext === CONNECT_DENIED_TOKEN) {
    return undefined;
  }

  // Interactive PIN loop: opening is a pure decrypt-and-verify step, so a
  // wrong code costs one more attempt, not a whole new wallet approval.
  // Errors raised by the kernel's value checks carry a 'Connect:' prefix and
  // indicate a protocol violation, not a mistyped code — those fail closed.
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_PIN_ATTEMPTS; attempt++) {
    const pin = await (options.cancelled === undefined
      ? options.requestPin(attempt, lastError)
      : Promise.race([options.requestPin(attempt, lastError), options.cancelled]));

    try {
      const response = await openResponse({
        jwe                 : responseCiphertext,
        recipientPrivateKey : responsePrivateKey,
        expected            : { clientDid: clientDid.uri, nonce, state },
        pin,
      });

      const delegatePortableDid = resolveDelegatePortableDid({
        localDelegatePortableDid: options.delegatePortableDid,
        response,
      });

      // Best-effort completion signal so the wallet can flip its pairing
      // screen to a confirmed "connected" state instead of leaving the user
      // to dismiss it blind. Fire-and-forget — mirrors the kernel client.
      transport.confirmComplete?.().catch((): undefined => undefined);

      return {
        delegatePortableDid,
        delegateGrants     : response.delegateGrants,
        connectedDid       : response.providerDid,
        sessionRevocations : response.sessionRevocations,
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure.message.startsWith('Connect:')) {
        // Structural/value-check failure — retrying the PIN cannot help.
        throw failure;
      }
      lastError = failure;
    }
  }

  throw new Error(`[@enbox/browser] The pairing code did not match after ${MAX_PIN_ATTEMPTS} attempts.`);
}
