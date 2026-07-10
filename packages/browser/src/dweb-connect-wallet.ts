/**
 * DWeb Connect wallet transport — the wallet side of the popup/postMessage
 * connect flow, exported for wallet apps (e.g. the Enbox web wallet).
 *
 * A wallet's `/dweb-connect` page creates one transport per session:
 *
 * 1. `create()` generates a fresh ephemeral X25519 key pair and emits the
 *    `loaded` beacon (public key + wallet origin) to the opener window with a
 *    pinned `targetOrigin`.
 * 2. `awaitRequest()` receives the sealed request ciphertext and opens it via
 *    the `@enbox/connect` kernel (`ConnectProvider.openRequest`), which
 *    value-checks the `apv` origin binding against this wallet's origin.
 * 3. After the consent ceremony, the wallet posts the sealed response JWE via
 *    `sendResponse()` — or the deny token via `deny()` — back to the opener,
 *    again with a pinned `targetOrigin`.
 *
 * The dapp origin is never assumed: it is taken from an explicit option or
 * derived from `document.referrer`, and `create()` fails when neither is
 * available. `'*'` is never used as a `targetOrigin`.
 *
 * @module
 */

import type { ConnectRequest } from '@enbox/connect';
import type { Jwk } from '@enbox/crypto';

import { ConnectProvider } from '@enbox/connect';
import { X25519 } from '@enbox/crypto';

import {
  DWEB_CONNECT_LOADED_MESSAGE_TYPE,
  DWEB_CONNECT_REQUEST_MESSAGE_TYPE,
  DWEB_CONNECT_RESPONSE_MESSAGE_TYPE,
} from './dweb-connect-messages.js';

/** Default budget for awaiting the dapp's sealed request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** Options for creating a {@link WalletPostMessageTransport}. */
export type WalletPostMessageTransportOptions = {
  /**
   * Origin of the dapp that opened this wallet popup. When omitted, it is
   * derived from `document.referrer`; creation fails when neither is
   * available — the transport never falls back to `'*'`.
   */
  dappOrigin?: string;

  /**
   * The dapp window to exchange messages with.
   * @default window.opener
   */
  dappWindow?: Window;

  /**
   * Budget in milliseconds for awaiting the dapp's sealed request.
   * @default 300_000 (5 minutes)
   */
  timeoutMs?: number;
};

/**
 * Wallet-side postMessage transport for the DWeb Connect popup flow.
 *
 * Security properties:
 * - `targetOrigin` of every outbound `postMessage` (beacon and response) is
 *   pinned to the dapp origin — never `'*'`.
 * - Inbound messages are dropped unless `event.origin` equals the pinned dapp
 *   origin AND `event.source` is the dapp window.
 * - The ephemeral X25519 private key never leaves the transport; the request
 *   JWE is opened by the kernel with the `apv` header value-checked against
 *   this wallet's own origin.
 */
export class WalletPostMessageTransport {
  private readonly _dappOrigin: string;
  private readonly _dappWindow: Window;
  private readonly _recipientPrivateKey: Jwk;

  private _requestReceived = false;
  private _timeoutId?: ReturnType<typeof setTimeout>;
  private _messageListener?: (event: MessageEvent) => void;

  private readonly _requestPromise: Promise<ConnectRequest>;
  private _resolveRequest?: (request: ConnectRequest) => void;
  private _rejectRequest?: (error: Error) => void;

  private constructor(params: { dappOrigin: string; dappWindow: Window; recipientPrivateKey: Jwk; timeoutMs: number }) {
    this._dappOrigin = params.dappOrigin;
    this._dappWindow = params.dappWindow;
    this._recipientPrivateKey = params.recipientPrivateKey;

    this._requestPromise = new Promise<ConnectRequest>((resolve, reject): void => {
      this._resolveRequest = resolve;
      this._rejectRequest = reject;
    });
    // Mark early rejections (timeout before `awaitRequest()` is called) as
    // handled until the wallet attaches its own handlers.
    this._requestPromise.catch((): undefined => undefined);

    this._messageListener = (event: MessageEvent): void => { this.onMessage(event); };
    window.addEventListener('message', this._messageListener);

    this._timeoutId = setTimeout((): void => {
      this.close();
      this._rejectRequest?.(new Error('[@enbox/browser] Timed out waiting for the connect request from the dapp.'));
    }, params.timeoutMs);
  }

  /**
   * Creates the transport for one connect session: resolves and pins the dapp
   * origin, generates a fresh ephemeral X25519 key pair, starts listening for
   * the sealed request, and emits the `loaded` beacon to the dapp window.
   *
   * @throws If not in a browser, if no dapp window is available, or if the
   *         dapp origin can neither be supplied nor derived from the referrer.
   */
  public static async create(options: WalletPostMessageTransportOptions = {}): Promise<WalletPostMessageTransport> {
    if (typeof window === 'undefined') {
      throw new Error('[@enbox/browser] WalletPostMessageTransport is only available in browser environments.');
    }

    const dappWindow = options.dappWindow ?? window.opener as Window | null;
    if (!dappWindow) {
      throw new Error('[@enbox/browser] No opener window: the DWeb Connect page must be opened as a popup by the dapp.');
    }

    const dappOrigin = resolveDappOrigin(options.dappOrigin);

    const recipientPrivateKey = await X25519.generateKey();
    const walletEpk: Jwk = { kty: 'OKP', crv: 'X25519', x: recipientPrivateKey.x };

    const transport = new WalletPostMessageTransport({
      dappOrigin,
      dappWindow,
      recipientPrivateKey,
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    // The listener is registered, so the beacon cannot race the request.
    dappWindow.postMessage({
      type         : DWEB_CONNECT_LOADED_MESSAGE_TYPE,
      walletEpk,
      walletOrigin : globalThis.location.origin,
    }, dappOrigin);

    return transport;
  }

  /** The pinned origin of the dapp this transport exchanges messages with. */
  public get dappOrigin(): string {
    return this._dappOrigin;
  }

  /**
   * Awaits the dapp's sealed request and opens it via the kernel: ECDH-ES
   * decryption with this session's ephemeral key, `apv` value-checked against
   * this wallet's origin, JWT signature verification, and payload shape
   * assertion. Rejects on timeout, on an unopenable request, or when the
   * request does not use the `post_message` reply mode.
   */
  public async awaitRequest(): Promise<ConnectRequest> {
    return await this._requestPromise;
  }

  /**
   * Posts the sealed response JWE (or the deny token) back to the dapp window
   * with the `targetOrigin` pinned to the dapp origin, then closes the
   * transport.
   *
   * @param idToken - The sealed response JWE, or the literal deny token.
   */
  public sendResponse(idToken: string): void {
    this._dappWindow.postMessage({
      type    : DWEB_CONNECT_RESPONSE_MESSAGE_TYPE,
      payload : idToken,
    }, this._dappOrigin);
    this.close();
  }

  /** Posts the deny token back to the dapp — the user rejected the request. */
  public deny(): void {
    this.sendResponse(ConnectProvider.denyToken());
  }

  /** Stops listening and releases the session's timers. Idempotent. */
  public close(): void {
    clearTimeout(this._timeoutId);
    if (this._messageListener !== undefined) {
      window.removeEventListener('message', this._messageListener);
      this._messageListener = undefined;
    }
  }

  private onMessage(event: MessageEvent): void {
    // Origin pinning: only messages from the pinned dapp origin count.
    if (event.origin !== this._dappOrigin) { return; }

    // Source pinning: the message must come from the dapp window.
    if (event.source !== this._dappWindow) { return; }

    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) { return; }
    const message = data as Record<string, unknown>;

    if (message.type !== DWEB_CONNECT_REQUEST_MESSAGE_TYPE || this._requestReceived) { return; }
    this._requestReceived = true;

    if (typeof message.jwe !== 'string') {
      this.settleRequest(new Error('[@enbox/browser] Connect request message did not carry a ciphertext payload.'));
      return;
    }

    void this.openRequest(message.jwe);
  }

  private async openRequest(jwe: string): Promise<void> {
    try {
      const request = await ConnectProvider.openRequest({
        jwe,
        decryption: {
          mode                : 'ecdh-es',
          recipientPrivateKey : this._recipientPrivateKey,
          walletOrigin        : globalThis.location.origin,
        },
      });

      if (request.reply.mode !== 'post_message') {
        this.settleRequest(new Error('[@enbox/browser] Connect request over the popup channel must use the `post_message` reply mode.'));
        return;
      }

      this.settleRequest(request);
    } catch (error) {
      this.settleRequest(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private settleRequest(outcome: ConnectRequest | Error): void {
    clearTimeout(this._timeoutId);
    if (outcome instanceof Error) {
      this.close();
      this._rejectRequest?.(outcome);
      return;
    }
    this._resolveRequest?.(outcome);
  }
}

/**
 * Resolves the dapp origin to pin: the explicit option when provided,
 * otherwise the origin of `document.referrer`. Never falls back to `'*'`.
 */
function resolveDappOrigin(explicitOrigin: string | undefined): string {
  if (explicitOrigin !== undefined) {
    return new URL(explicitOrigin).origin;
  }

  if (document.referrer) {
    return new URL(document.referrer).origin;
  }

  throw new Error(
    '[@enbox/browser] Unable to determine the dapp origin: no `dappOrigin` option was provided and `document.referrer` is empty.'
  );
}
