/**
 * DWeb Connect client — the dapp side of the popup/postMessage connect flow.
 *
 * {@link PopupClientTransport} implements the `@enbox/connect` kernel's
 * `ConnectTransport` over a wallet popup:
 *
 * 1. The dapp opens `${walletUrl}/dweb-connect` as a popup window.
 * 2. The wallet emits a `loaded` beacon carrying a fresh ephemeral X25519
 *    public key and its origin.
 * 3. The kernel seals the signed connect request to that key (ECDH-ES,
 *    `apv` bound to the wallet origin) and the transport posts the
 *    ciphertext to the popup.
 * 4. The wallet posts back the sealed response JWE (or the deny token),
 *    which the kernel opens and value-checks.
 *
 * Only ciphertext crosses the postMessage channel. Every message is checked
 * against the wallet origin derived from the configured wallet URL (never
 * `'*'`), and against the popup window as `event.source`.
 *
 * @module
 */

import type { Jwk } from '@enbox/crypto';
import type {
  ConnectClientMetadata,
  ConnectPermissionRequest,
  ConnectRequestProfile,
  ConnectResult,
  ConnectTransport,
} from '@enbox/connect';

import { assertX25519PublicJwk, CONNECT_DENIED_TOKEN, ConnectClient } from '@enbox/connect';

import {
  DWEB_CONNECT_ACK_MESSAGE_TYPE,
  DWEB_CONNECT_LOADED_MESSAGE_TYPE,
  DWEB_CONNECT_PATH,
  DWEB_CONNECT_REQUEST_MESSAGE_TYPE,
  DWEB_CONNECT_RESPONSE_MESSAGE_TYPE,
  getTrustedMessage,
} from './dweb-connect-messages.js';

/** Default budget for the whole popup handshake (beacon + user consent + response). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Interval at which the transport checks whether the user closed the popup. */
const CLOSED_POLL_INTERVAL_MS = 500;

/**
 * Grace period after the popup is seen closed for an already-posted response
 * to finish delivery before the close is treated as a denial.
 */
const CLOSED_RESPONSE_GRACE_MS = 1_500;

/** Window name given to the wallet popup. */
const POPUP_WINDOW_NAME = 'enbox-dweb-connect';

/** Outer size of the wallet popup window. */
const POPUP_WIDTH = 500;
const POPUP_HEIGHT = 700;

/**
 * Builds the wallet popup's window features, centring it over the opener
 * window — without `left`/`top` browsers park the popup wherever they like
 * (usually offset into a corner). Falls back to centring on the screen when
 * the opener's metrics are unavailable, and lets the browser clamp
 * off-screen coordinates. Mobile browsers ignore the features entirely and
 * open a tab.
 */
function popupWindowFeatures(): string {
  const base = `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},menubar=no,toolbar=no,location=no,status=no`;

  // `screenX`/`outerWidth` describe the opener window; `screen.avail*`
  // describe its monitor — so the popup lands on the same display.
  const openerWidth = window.outerWidth > 0 ? window.outerWidth : (window.screen?.availWidth ?? 0);
  const openerHeight = window.outerHeight > 0 ? window.outerHeight : (window.screen?.availHeight ?? 0);
  if (openerWidth === 0 || openerHeight === 0) {
    return base;
  }

  const left = Math.max(0, Math.round((window.screenX ?? 0) + (openerWidth - POPUP_WIDTH) / 2));
  const top = Math.max(0, Math.round((window.screenY ?? 0) + (openerHeight - POPUP_HEIGHT) / 2));
  return `${base},left=${left},top=${top}`;
}

/** Guards against calling browser-only entry points outside a browser. */
function assertBrowserEnvironment(): void {
  if (typeof window === 'undefined') {
    throw new TypeError('[@enbox/browser] DWeb Connect is only available in browser environments.');
  }
}

/**
 * Thrown when the user closes the wallet popup before the wallet finished
 * loading (i.e. before its `loaded` beacon arrived). Callers typically treat
 * this the same as a user denial.
 */
export class PopupWindowClosedError extends Error {
  constructor() {
    super('[@enbox/browser] Wallet popup was closed before the wallet finished loading.');
    this.name = 'PopupWindowClosedError';
  }
}

/** Options for constructing a {@link PopupClientTransport}. */
export type PopupClientTransportOptions = {
  /** Base URL of the wallet app (e.g. `https://enbox-wallet.pages.dev`). */
  walletUrl: string;

  /**
   * Total budget in milliseconds for the popup handshake. The popup is closed
   * and the handshake rejected when the wallet has not responded in time.
   * @default 300_000 (5 minutes)
   */
  timeoutMs?: number;
};

/**
 * Popup/postMessage {@link ConnectTransport} for browser dapps.
 *
 * Single-use: construct a new transport per handshake. The **constructor**
 * opens the wallet popup synchronously — so `window.open` runs inside the user
 * gesture, ahead of the kernel's awaited key generation, and survives strict
 * popup blockers; `requestProfile()` then awaits the wallet's `loaded` beacon;
 * `deliverRequest()` posts the sealed request ciphertext; `awaitResponse()`
 * resolves with the sealed response JWE, or the deny token when the user denies
 * or closes the popup after the handshake was established.
 *
 * Security properties:
 * - `targetOrigin` of every outbound `postMessage` is pinned to the origin
 *   derived from `walletUrl` — never `'*'`.
 * - Inbound messages are dropped unless `event.origin` equals the pinned
 *   wallet origin AND `event.source` is the popup window this transport opened.
 * - The beacon's `walletOrigin` field must equal the pinned origin, and its
 *   `walletEpk` must be a public-only X25519 JWK; a malformed beacon from the
 *   genuine popup fails the handshake closed.
 */
export class PopupClientTransport implements ConnectTransport {
  /** {@inheritDoc ConnectTransport.requiresPin} */
  public readonly requiresPin: boolean = false;

  private readonly _walletOrigin: string;
  private readonly _timeoutMs: number;

  private readonly _popup: Window;
  private _settled = false;
  private _walletEpkReceived = false;
  private readonly _timeoutId?: ReturnType<typeof setTimeout>;
  private readonly _closedPollId?: ReturnType<typeof setInterval>;
  private _messageListener?: (event: MessageEvent) => void;

  private readonly _walletEpkPromise: Promise<Jwk>;
  private _resolveWalletEpk?: (walletEpk: Jwk) => void;
  private _rejectWalletEpk?: (error: Error) => void;

  private readonly _responsePromise: Promise<string>;
  private _resolveResponse?: (payload: string) => void;
  private _rejectResponse?: (error: Error) => void;

  constructor(options: PopupClientTransportOptions) {
    assertBrowserEnvironment();

    this._walletOrigin = new URL(options.walletUrl).origin;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Open the wallet popup SYNCHRONOUSLY, in the user-gesture call stack,
    // before the kernel's awaited `DidJwk.create()` / `X25519.generateKey()`
    // run. Strict popup blockers (Safari) reject a `window.open` issued once
    // the stack has yielded to a prior `await`, so opening it here — instead of
    // inside the awaited `requestProfile()` — is what keeps the flow usable.
    const popupUrl = new URL(DWEB_CONNECT_PATH, options.walletUrl).toString();
    const popup = window.open(popupUrl, POPUP_WINDOW_NAME, popupWindowFeatures());
    if (!popup) {
      throw new Error('[@enbox/browser] Popup blocked. Allow popups for this site to connect to a wallet.');
    }
    this._popup = popup;

    this._walletEpkPromise = new Promise<Jwk>((resolve, reject): void => {
      this._resolveWalletEpk = resolve;
      this._rejectWalletEpk = reject;
    });

    // Created up-front so a response (or deny) arriving before
    // `awaitResponse()` is called is never dropped. The no-op catch marks
    // early rejections (timeout, popup closed during load) as handled until
    // the kernel attaches its own handlers via `awaitResponse()`.
    this._responsePromise = new Promise<string>((resolve, reject): void => {
      this._resolveResponse = resolve;
      this._rejectResponse = reject;
    });
    this._responsePromise.catch((): undefined => undefined);

    // Listen synchronously, before the wallet page can emit its `loaded`
    // beacon, so the beacon is never missed while the kernel awaits key
    // generation ahead of `requestProfile()`.
    this._messageListener = (event: MessageEvent): void => { this.onMessage(event); };
    window.addEventListener('message', this._messageListener);

    this._timeoutId = setTimeout((): void => {
      this.fail(new Error('[@enbox/browser] DWeb Connect timed out waiting for wallet response.'));
    }, this._timeoutMs);

    this._closedPollId = setInterval((): void => { this.onClosedPoll(); }, CLOSED_POLL_INTERVAL_MS);
  }

  /**
   * Awaits the already-open popup's `loaded` beacon, then returns the popup
   * channel profile: ECDH-ES encryption to the beacon's ephemeral key with the
   * pinned wallet origin as the `apv` binding, a `post_message` reply
   * descriptor, and the client-supplied `state` correlator.
   *
   * The popup was opened synchronously at construction, so this method only
   * awaits the beacon — it never issues the blocker-sensitive `window.open`.
   *
   * @param state - The handshake correlator minted by the {@link ConnectClient}.
   * @throws If the user closes the popup before the beacon arrives
   *         ({@link PopupWindowClosedError}), the beacon is malformed, or on
   *         timeout.
   */
  public async requestProfile(state: string): Promise<ConnectRequestProfile> {
    const walletEpk = await this._walletEpkPromise;

    return {
      encryption : { mode: 'ecdh-es', walletEpk, walletOrigin: this._walletOrigin },
      reply      : { mode: 'post_message' },
      state,
    };
  }

  /**
   * Posts the sealed request ciphertext to the wallet popup with the
   * `targetOrigin` pinned to the wallet origin.
   */
  public async deliverRequest(jwe: string): Promise<void> {
    this._popup.postMessage({ type: DWEB_CONNECT_REQUEST_MESSAGE_TYPE, jwe }, this._walletOrigin);
  }

  /**
   * Awaits the wallet's response ciphertext: the sealed response JWE, or the
   * deny token when the user denies in the wallet or closes the popup.
   * Rejects on timeout.
   */
  public async awaitResponse(): Promise<string> {
    return await this._responsePromise;
  }

  /**
   * {@inheritDoc ConnectTransport.confirmComplete}
   *
   * Posts the payload-less ack to the wallet popup (pinned `targetOrigin`)
   * so a wallet still holding its "finishing up" screen can flip to a
   * confirmed "connected" state before closing itself. A popup the user
   * already closed is skipped silently.
   */
  public async confirmComplete(): Promise<void> {
    if (this._popup.closed === true) { return; }
    this._popup.postMessage({ type: DWEB_CONNECT_ACK_MESSAGE_TYPE }, this._walletOrigin);
  }

  private onMessage(event: MessageEvent): void {
    const message = getTrustedMessage(event, this._walletOrigin, this._popup);
    if (message === undefined) { return; }

    if (message.type === DWEB_CONNECT_LOADED_MESSAGE_TYPE) {
      this.onLoadedBeacon(message);
      return;
    }

    if (message.type === DWEB_CONNECT_RESPONSE_MESSAGE_TYPE) {
      this.onResponseMessage(message);
    }
  }

  private onLoadedBeacon(message: Record<string, unknown>): void {
    if (this._settled || this._walletEpkReceived) { return; }

    // The beacon passed the origin and source checks, so a malformed payload
    // is a protocol violation by the genuine popup — fail closed. The X25519
    // public-JWK shape check is delegated to the connect kernel.
    let walletEpk: Jwk;
    try {
      assertX25519PublicJwk(message.walletEpk);
      walletEpk = message.walletEpk;
    } catch {
      this.fail(new Error('[@enbox/browser] Wallet loaded beacon did not carry a valid X25519 public key.'));
      return;
    }

    if (message.walletOrigin !== this._walletOrigin) {
      this.fail(new Error('[@enbox/browser] Wallet loaded beacon origin does not match the configured wallet origin.'));
      return;
    }

    this._walletEpkReceived = true;
    this._resolveWalletEpk?.(walletEpk);
  }

  private onResponseMessage(message: Record<string, unknown>): void {
    if (this._settled) { return; }

    if (typeof message.payload !== 'string') {
      this.fail(new Error('[@enbox/browser] Wallet response message did not carry a ciphertext payload.'));
      return;
    }

    this._settled = true;
    this.cleanup();
    // No-op on the normal path; unblocks `requestProfile()` if a response
    // somehow arrives before the beacon.
    this._rejectWalletEpk?.(new Error('[@enbox/browser] Wallet responded before the handshake was established.'));
    this._resolveResponse?.(message.payload);
  }

  private onClosedPoll(): void {
    if (this._settled || this._popup.closed !== true) { return; }

    if (!this._walletEpkReceived) {
      // Closed before the wallet ever loaded — the handshake cannot proceed.
      this.fail(new PopupWindowClosedError());
      return;
    }

    // Closed after the handshake was established. A wallet that posts its
    // response and immediately closes itself can lose the race between that
    // final message and this poll — especially when this page was
    // backgrounded (mobile tabs) and both signals arrive together on
    // resume — so give a queued response a grace window before treating the
    // close as a user denial.
    clearInterval(this._closedPollId);
    setTimeout((): void => {
      if (this._settled) { return; }
      this._settled = true;
      this.cleanup();
      this._resolveResponse?.(CONNECT_DENIED_TOKEN);
    }, CLOSED_RESPONSE_GRACE_MS);
  }

  private fail(error: Error): void {
    if (this._settled) { return; }
    this._settled = true;
    this.cleanup();
    try { this._popup.close(); } catch { /* best effort */ }
    this._rejectWalletEpk?.(error);
    this._rejectResponse?.(error);
  }

  private cleanup(): void {
    clearTimeout(this._timeoutId);
    clearInterval(this._closedPollId);
    if (this._messageListener !== undefined) {
      window.removeEventListener('message', this._messageListener);
      this._messageListener = undefined;
    }
  }
}

/** Options for a one-shot {@link connectViaPopup} flow. */
export type PopupConnectOptions = {
  /** Base URL of the wallet app (e.g. `https://enbox-wallet.pages.dev`). */
  walletUrl: string;

  /** DWN protocols and permission scopes to request from the wallet. */
  permissionRequests: ConnectPermissionRequest[];

  /**
   * Timeout in milliseconds for the popup handshake.
   * @default 300_000 (5 minutes)
   */
  timeout?: number;

  /**
   * Display name of the requesting application, shown in the wallet's
   * consent screen. Defaults to the dapp's host.
   */
  appName?: string;

  /**
   * Icon URL of the requesting application, shown alongside the app name in
   * the wallet's consent screen.
   */
  appIcon?: string;
};

/** Collects self-reported environment hints for the wallet's session display. */
export function collectBrowserClientMetadata(): ConnectClientMetadata {
  const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
  const languages = Array.isArray(globalThis.navigator.languages)
    ? globalThis.navigator.languages.filter((language) => typeof language === 'string' && language.length > 0)
    : undefined;

  return {
    origin    : globalThis.location.origin,
    userAgent : globalThis.navigator.userAgent,
    platform  : globalThis.navigator.platform,
    language  : globalThis.navigator.language,
    ...(languages && languages.length > 0 ? { languages } : {}),
    ...(resolvedOptions.timeZone ? { timezone: resolvedOptions.timeZone } : {}),
  };
}

/**
 * Runs one DWeb Connect popup handshake end-to-end: opens the wallet popup,
 * drives the `@enbox/connect` kernel client over a {@link PopupClientTransport},
 * and returns the delegated credentials.
 *
 * @returns The delegate credentials, or `undefined` when the user denied the
 *          request or closed the popup.
 * @throws If the popup is blocked, the handshake times out, or the wallet
 *         returns an invalid response.
 */
export async function connectViaPopup(options: PopupConnectOptions): Promise<ConnectResult | undefined> {
  const transport = new PopupClientTransport({
    walletUrl : options.walletUrl,
    timeoutMs : options.timeout,
  });
  const client = new ConnectClient({ transport });

  try {
    return await client.connect({
      appName            : options.appName ?? globalThis.location.host,
      appIcon            : options.appIcon,
      clientMetadata     : collectBrowserClientMetadata(),
      permissionRequests : options.permissionRequests,
    });
  } catch (error) {
    if (error instanceof PopupWindowClosedError) {
      // The user closed the wallet before it loaded — same as a denial.
      return undefined;
    }
    throw error;
  }
}
