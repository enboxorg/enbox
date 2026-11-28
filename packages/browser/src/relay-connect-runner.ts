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

import type {
  ConnectClientConnectParams,
  ConnectRequestType,
  ConnectResult,
  ConnectTransport,
  ConnectVerificationSymbol,
  RelayClientTransportOptions,
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
export type RelayConnectOptions =
  Pick<
    ConnectClientConnectParams,
    | 'appName'
    | 'appIcon'
    | 'applicationId'
    | 'clientMetadata'
    | 'permissionRequests'
    | 'delegatePortableDid'
    | 'requestType'
    | 'expectedProviderDid'
  >
  & Pick<RelayClientTransportOptions, 'connectServerUrl' | 'walletUri' | 'timeoutMs' | 'pollIntervalMs' | 'onClaimed'>
  & {
    /** Receives the wallet URI handoff (with the request pointer TTL) as soon as delivered. */
    onWalletUriReady: (handoff: WalletUriHandoff) => void;

    /** Invoked once when the wallet publishes its ephemeral handshake key and SAS symbols are derived. */
    onVerificationReady: (symbols: readonly ConnectVerificationSymbol[]) => void;

    /** Cancellation signal: when it settles, polling stops and the handshake rejects. */
    cancelled?: Promise<never>;

    /** Transport factory override (tests). */
    createTransport?: (options: Pick<
      RelayClientTransportOptions,
      'connectServerUrl' | 'walletUri' | 'timeoutMs' | 'pollIntervalMs' | 'onClaimed' | 'signal'
    >) => ConnectTransport;
  };

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
