/**
 * Relay channel transport for the connect handshake.
 *
 * The relay is an untrusted store-and-forward server (the dwn-server connect
 * routes) that only ever sees ciphertext:
 *
 * - `POST /connect/par` — the app pushes the sealed request (RFC 9126-style
 *   Pushed Authorization Request) and receives a single-use `request_uri`.
 * - `GET /connect/authorize/{requestId}.jwt` — the wallet fetches the sealed
 *   request; the pointer is single-use and expires server-side.
 * - `POST /connect/callback` — the wallet posts the sealed response (or the
 *   literal `DENIED` token) keyed by the request `state`.
 * - `GET /connect/token/{state}.jwt` — the app polls for the response.
 *
 * The single-use request encryption key travels only in the wallet URI
 * fragment (see the uri module) — never in query strings or logs.
 *
 * @module
 */

import type { ConnectRequestProfile, ConnectTransport, WalletUriHandoff } from './types.js';

import { CryptoUtils } from '@enbox/crypto';
import { concatenateUrl, sleep } from '@enbox/common';

import { buildWalletConnectUri } from './uri.js';

/** Per-request abort budget applied to every relay HTTP call. */
const RELAY_HTTP_TIMEOUT_MS = 30_000;

/** Default interval between response polling attempts. */
const RELAY_DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Default total budget for awaiting the wallet response. */
const RELAY_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Minimal fetch signature used by the relay transport and helpers.
 * Injectable so tests (and non-standard hosts) can supply their own.
 */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Default {@link FetchFn}: defers to the ambient global `fetch` at call time. */
const defaultFetch: FetchFn = (input, init): Promise<Response> => globalThis.fetch(input, init);

/** Options for constructing a {@link RelayClientTransport}. */
export type RelayClientTransportOptions = {
  /**
   * Base URL of the relay's connect routes (e.g. `https://dwn.example/connect`).
   * The transport appends `par`, `token/{state}.jwt`, and `callback`.
   */
  connectServerUrl: string;

  /**
   * The wallet app URI the request pointer is attached to as fragment
   * parameters (e.g. `enbox://connect` or `https://wallet.example/connect/app`).
   */
  walletUri: string;

  /**
   * Milliseconds between relay polling attempts.
   * @default 3000
   */
  pollIntervalMs?: number;

  /**
   * Total milliseconds to poll the relay for a wallet response.
   * @default 300_000
   */
  timeoutMs?: number;

  /** Fetch implementation override; defaults to the global `fetch`. */
  fetchFn?: FetchFn;

  /** Clock override used by the polling deadline; defaults to `Date.now`. */
  now?: () => number;

  /** Sleep override used between polling attempts; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;

  /**
   * Invoked once, from the `awaitResponse()` poll loop, when the relay
   * reports the pushed request has been claimed (fetched) by a wallet.
   * Lets the app show live progress ("phone connected") before the
   * approval lands. Status polling only happens when this is provided;
   * relays without the status route degrade silently (the callback simply
   * never fires).
   */
  onClaimed?: () => void;
};

/**
 * App-side {@link ConnectTransport} over the relay HTTP channel.
 *
 * `requestProfile()` mints the single-use fragment key and records the
 * client-supplied `state` correlator; `deliverRequest()` pushes the sealed
 * request and returns the wallet URI handoff for QR/deep-link display;
 * `awaitResponse()` polls the token route until the wallet responds, the user
 * denies, or the poll budget is exhausted. Relay responses are
 * PIN-strengthened, so `requiresPin` is always `true`.
 */
export class RelayClientTransport implements ConnectTransport {
  /** {@inheritDoc ConnectTransport.requiresPin} */
  public readonly requiresPin: boolean = true;

  private readonly _connectServerUrl: string;
  private readonly _walletUri: string;
  private readonly _pollIntervalMs: number;
  private readonly _timeoutMs: number;
  private readonly _fetch: FetchFn;
  private readonly _now: () => number;
  private readonly _sleep: (ms: number) => Promise<void>;

  private _requestKey?: Uint8Array;
  private _state?: string;
  private _requestUri?: string;
  private readonly _onClaimed?: () => void;

  constructor(options: RelayClientTransportOptions) {
    this._connectServerUrl = options.connectServerUrl;
    this._walletUri = options.walletUri;
    this._pollIntervalMs = options.pollIntervalMs ?? RELAY_DEFAULT_POLL_INTERVAL_MS;
    this._timeoutMs = options.timeoutMs ?? RELAY_DEFAULT_TIMEOUT_MS;
    this._fetch = options.fetchFn ?? defaultFetch;
    this._now = options.now ?? ((): number => Date.now());
    this._sleep = options.sleep ?? sleep;
    this._onClaimed = options.onClaimed;
  }

  /** {@inheritDoc ConnectTransport.requestProfile} */
  public async requestProfile(state: string): Promise<ConnectRequestProfile> {
    this._requestKey = CryptoUtils.randomBytes(32);
    this._state = state;

    return {
      encryption : { mode: 'dir', requestKey: this._requestKey },
      reply      : { mode: 'direct_post', callbackUrl: concatenateUrl(this._connectServerUrl, 'callback') },
      state,
    };
  }

  /**
   * Pushes the sealed request to the relay (`POST /connect/par`) and returns
   * the wallet URI handoff carrying the returned `request_uri` and the
   * fragment encryption key.
   */
  public async deliverRequest(jwe: string): Promise<WalletUriHandoff> {
    if (this._requestKey === undefined) {
      throw new Error('Connect: call `requestProfile()` before `deliverRequest()`.');
    }

    const parUrl = concatenateUrl(this._connectServerUrl, 'par');
    const response = await this._fetch(parUrl, {
      body    : JSON.stringify({ request: jwe }),
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      signal  : AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Connect: pushed authorization request failed with HTTP ${response.status}.`);
    }

    const parData = await response.json() as { request_uri?: unknown; expires_in?: unknown };
    if (typeof parData.request_uri !== 'string' || typeof parData.expires_in !== 'number') {
      throw new Error('Connect: pushed authorization response is missing `request_uri` or `expires_in`.');
    }

    const walletUri = buildWalletConnectUri({
      walletUri     : this._walletUri,
      requestUri    : parData.request_uri,
      encryptionKey : this._requestKey,
    });

    this._requestUri = parData.request_uri;

    return { walletUri, requestUri: parData.request_uri, expiresIn: parData.expires_in };
  }

  /**
   * Polls `GET /connect/token/{state}.jwt` every `pollIntervalMs` until the
   * relay returns a body (the sealed response JWE or the `DENIED` token) or
   * the `timeoutMs` budget is exhausted.
   */
  public async awaitResponse(): Promise<string> {
    if (this._state === undefined) {
      throw new Error('Connect: call `requestProfile()` before `awaitResponse()`.');
    }

    const tokenUrl = concatenateUrl(this._connectServerUrl, `token/${this._state}.jwt`);
    const deadline = this._now() + this._timeoutMs;

    // Claimed observation is best-effort and only runs when the app asked
    // for it. The request ID rides in the `request_uri` returned by the PAR.
    const requestId = this._onClaimed !== undefined && this._requestUri !== undefined
      ? /\/connect\/authorize\/([^/]+)\.jwt$/.exec(this._requestUri)?.[1]
      : undefined;
    const statusUrl = requestId !== undefined
      ? concatenateUrl(this._connectServerUrl, `status/${requestId}`)
      : undefined;
    let claimedNotified = false;

    while (this._now() < deadline) {
      const response = await this._fetch(tokenUrl, { signal: AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS) });
      if (response.ok) {
        return await response.text();
      }
      // Release the unread body so keep-alive sockets are not pinned across polls.
      await response.body?.cancel().catch((): void => {});

      if (statusUrl !== undefined && !claimedNotified) {
        try {
          const statusResponse = await this._fetch(statusUrl, { signal: AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS) });
          if (statusResponse.ok) {
            const status = await statusResponse.json() as { claimed?: unknown };
            if (status.claimed === true) {
              claimedNotified = true;
              this._onClaimed?.();
            }
          } else {
            await statusResponse.body?.cancel().catch((): void => {});
          }
        } catch {
          // Older relays without the status route (or transient failures)
          // degrade silently — progress display is optional.
        }
      }

      await this._sleep(this._pollIntervalMs);
    }

    throw new Error(`Connect: timed out after ${this._timeoutMs}ms waiting for the wallet response.`);
  }
}

/**
 * Wallet-side helper: fetches the sealed request JWE from the relay
 * `request_uri` carried by the wallet connect URI fragment. The pointer is
 * single-use — the relay deletes the request on first retrieval — so a
 * non-OK status means the pointer was already consumed or has expired.
 *
 * @param params - The fetch parameters.
 * @param params.requestUri - The relay `request_uri` from the wallet URI fragment.
 * @param params.fetchFn - Fetch implementation override.
 * @param params.timeoutMs - Per-request abort budget; defaults to 30 s.
 * @returns A promise resolving to the sealed request as a Compact JWE string.
 */
export async function fetchRelayRequest({ requestUri, fetchFn, timeoutMs }: {
  requestUri: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}): Promise<string> {
  const doFetch = fetchFn ?? defaultFetch;
  const response = await doFetch(requestUri, { signal: AbortSignal.timeout(timeoutMs ?? RELAY_HTTP_TIMEOUT_MS) });

  if (!response.ok) {
    throw new Error(`Connect: failed to fetch the pushed request (HTTP ${response.status}); request pointers are single-use and expire.`);
  }

  return await response.text();
}

/**
 * Wallet-side helper: posts the sealed response JWE — or the literal
 * `DENIED` token — to the request's `callbackUrl` (`POST /connect/callback`)
 * as an `application/x-www-form-urlencoded` body with `id_token` and `state`
 * fields, matching the frozen dwn-server route contract.
 *
 * @param params - The post parameters.
 * @param params.callbackUrl - The `callbackUrl` from the request's reply descriptor.
 * @param params.state - The request `state` correlator.
 * @param params.idToken - The sealed response JWE, or the `DENIED` token.
 * @param params.fetchFn - Fetch implementation override.
 * @param params.timeoutMs - Per-request abort budget; defaults to 30 s.
 */
export async function postRelayResponse({ callbackUrl, state, idToken, fetchFn, timeoutMs }: {
  callbackUrl: string;
  state: string;
  idToken: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}): Promise<void> {
  const doFetch = fetchFn ?? defaultFetch;
  const body = new URLSearchParams({ id_token: idToken, state }).toString();

  const response = await doFetch(callbackUrl, {
    body,
    method  : 'POST',
    headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal  : AbortSignal.timeout(timeoutMs ?? RELAY_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Connect: callback POST failed with HTTP ${response.status}.`);
  }
}
