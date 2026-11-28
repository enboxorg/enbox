/**
 * Relay connect runner — the dapp side of the QR/deep-link connect flow with
 * pre-approval ECDH SAS verification.
 *
 * Thin wrapper around the `@enbox/connect` kernel `ConnectClient` and
 * `RelayClientTransport`: uses a visibility-aware poll sleep (so mobile and
 * background tabs wake up immediately on return) and translates a caller's
 * cancellation promise into the transport's `AbortSignal`.
 *
 * @module
 */

import type { PortableDid } from '@enbox/dids';
import type {
  ConnectClientMetadata,
  ConnectPermissionRequest,
  ConnectRequestType,
  ConnectResult,
  ConnectTransport,
  ConnectVerificationSymbol,
  WalletUriHandoff,
} from '@enbox/connect';

import { ConnectClient, RelayClientTransport } from '@enbox/connect';

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

  /** Stable application identifier hint available to the wallet during approval. */
  applicationId?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /** DWN modules and permission scopes being requested. */
  permissionRequests: ConnectPermissionRequest[];

  /** Existing delegate credentials reused by a refresh request. */
  delegatePortableDid?: PortableDid;

  /** User-facing request purpose. Absent means a normal connect. */
  requestType?: Exclude<ConnectRequestType, 'authenticate'>;

  /** Wallet profile DID that a refresh must renew. */
  expectedProviderDid?: string;

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
   * Invoked once when the wallet publishes its ephemeral handshake key and the
   * 3 pre-approval SAS verification symbols are derived — display them so the
   * user can tap the matching 3 tiles in their wallet.
   */
  onVerificationReady?: (symbols: readonly ConnectVerificationSymbol[]) => void;

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
  }) => ConnectTransport;
}

/**
 * Sleep used between relay polls that ends early when the page returns to
 * the foreground. Browsers throttle — and mobile browsers freeze — timers in
 * background tabs, so a plain interval sleep can leave the user staring at a
 * stale stage; cutting the sleep short on `visibilitychange` makes the next
 * poll land the moment they switch back.
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
  if ((options.requestType as ConnectRequestType | undefined) === 'authenticate') {
    throw new Error('Connect: runRelayConnect creates data sessions; use ConnectClient.authenticate for identity-only requests.');
  }
  if (options.requestType === 'refresh' && options.delegatePortableDid === undefined) {
    throw new Error('Connect: refresh requests require an existing `delegatePortableDid`.');
  }

  const createTransport = options.createTransport
    ?? ((transportOptions): RelayClientTransport => new RelayClientTransport({
      ...transportOptions,
      sleep: visibilityAwareSleep,
    }));

  const cancellationController = options.cancelled === undefined ? undefined : new AbortController();
  if (options.cancelled !== undefined && cancellationController !== undefined) {
    void options.cancelled.catch((reason: unknown): void => {
      cancellationController.abort(reason);
    });
  }

  const transport = createTransport({
    connectServerUrl : options.connectServerUrl,
    walletUri        : options.walletUri,
    timeoutMs        : options.timeoutMs,
    pollIntervalMs   : options.pollIntervalMs,
    onClaimed        : options.onClaimed,
    signal           : cancellationController?.signal,
  });

  const client = new ConnectClient({
    transport,
    onWalletUriReady    : options.onWalletUriReady,
    onVerificationReady : options.onVerificationReady,
  });

  const handshakePromise = client.connect({
    appName             : options.appName,
    appIcon             : options.appIcon,
    applicationId       : options.applicationId,
    clientMetadata      : options.clientMetadata,
    permissionRequests  : options.permissionRequests,
    delegatePortableDid : options.delegatePortableDid,
    requestType         : options.requestType,
    expectedProviderDid : options.expectedProviderDid,
    supportedDidMethods : ['did:dht', 'did:jwk'],
  });

  if (options.cancelled === undefined) {
    return await handshakePromise;
  }

  try {
    return await Promise.race([handshakePromise, options.cancelled]);
  } catch (error) {
    cancellationController?.abort(error);
    // Avoid unhandled rejection if the underlying handshake settles after cancellation.
    handshakePromise.catch((): undefined => undefined);
    throw error;
  }
}
