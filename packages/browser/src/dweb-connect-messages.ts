/**
 * Wire shapes for the DWeb Connect popup/postMessage channel.
 *
 * The dapp and the wallet exchange exactly three message kinds over
 * `window.postMessage`:
 *
 * 1. `loaded` beacon (wallet → dapp): announces the wallet page is ready and
 *    carries a fresh ephemeral X25519 public key plus the wallet's origin.
 * 2. `request` (dapp → wallet): the sealed connect request JWE — ciphertext
 *    only, encrypted to the beacon key with ECDH-ES and the wallet origin
 *    bound into the JWE `apv` header.
 * 3. `response` (wallet → dapp): the sealed connect response JWE, or the
 *    literal deny token — again ciphertext only.
 *
 * Plaintext never crosses the channel, and both sides pin `targetOrigin`
 * and verify `event.origin` / `event.source` on every message.
 *
 * @module
 */

import type { Jwk } from '@enbox/crypto';

/** Path of the wallet's DWeb Connect page, opened as a popup by the dapp. */
export const DWEB_CONNECT_PATH = '/dweb-connect';

/** Message type of the wallet's `loaded` beacon (wallet → dapp). */
export const DWEB_CONNECT_LOADED_MESSAGE_TYPE = 'enbox-connect-loaded';

/** Message type carrying the sealed connect request JWE (dapp → wallet). */
export const DWEB_CONNECT_REQUEST_MESSAGE_TYPE = 'enbox-connect-request';

/** Message type carrying the sealed connect response JWE or deny token (wallet → dapp). */
export const DWEB_CONNECT_RESPONSE_MESSAGE_TYPE = 'enbox-connect-response';

/**
 * The wallet's readiness beacon. Emitted to `window.opener` once the wallet's
 * DWeb Connect page has generated its per-session ephemeral X25519 key.
 */
export type DWebConnectLoadedMessage = {
  type: typeof DWEB_CONNECT_LOADED_MESSAGE_TYPE;

  /** Fresh ephemeral X25519 public JWK the dapp seals the request to. */
  walletEpk: Jwk;

  /** The wallet's own origin; must match the origin the dapp has pinned. */
  walletOrigin: string;
};

/** The dapp's sealed connect request, posted to the wallet popup. */
export type DWebConnectRequestMessage = {
  type: typeof DWEB_CONNECT_REQUEST_MESSAGE_TYPE;

  /** The sealed connect request as a Compact JWE string. */
  jwe: string;
};

/** The wallet's sealed connect response, posted back to the opener. */
export type DWebConnectResponseMessage = {
  type: typeof DWEB_CONNECT_RESPONSE_MESSAGE_TYPE;

  /** The sealed connect response JWE, or the literal `CONNECT_DENIED_TOKEN`. */
  payload: string;
};

/**
 * Applies the shared inbound-message trust filter for the popup channel:
 * pins the message to the expected `event.origin`, pins its `event.source` to
 * the expected window, and requires a non-null object payload.
 *
 * Returns the payload cast to a plain record when every check passes, or
 * `undefined` when the message must be dropped. Both the dapp-side and
 * wallet-side transports early-return on `undefined` before inspecting any
 * message field — this is the security-critical filter that keeps hostile
 * origins and stray windows off the channel.
 */
export function getTrustedMessage(
  event: MessageEvent,
  expectedOrigin: string,
  expectedSource: Window | undefined,
): Record<string, unknown> | undefined {
  // Origin pinning: only messages from the expected origin count.
  if (event.origin !== expectedOrigin) { return undefined; }

  // Source pinning: the message must come from the expected window.
  if (event.source !== expectedSource) { return undefined; }

  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) { return undefined; }

  return data as Record<string, unknown>;
}
