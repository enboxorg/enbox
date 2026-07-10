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
 * Validates an untrusted value as an X25519 **public** JWK and returns a
 * minimal copy (`kty`/`crv`/`x` only). Returns `undefined` when the value is
 * not a plain object, is not an X25519 OKP key, or carries private key
 * material.
 */
export function parseX25519PublicJwk(value: unknown): Jwk | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const jwk = value as Jwk;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519' || typeof jwk.x !== 'string' || jwk.d !== undefined) {
    return undefined;
  }

  return { kty: 'OKP', crv: 'X25519', x: jwk.x };
}
