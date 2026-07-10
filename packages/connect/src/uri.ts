/**
 * Wallet connect URI building and parsing for QR / deep-link handoff.
 *
 * The request pointer and the single-use symmetric encryption key travel in
 * the URI **fragment**, never in the query string: the fragment stays on the
 * local channel (terminal → camera, or entirely within the opening browser)
 * and is never sent to the wallet's web server, so the key cannot surface in
 * server or CDN logs on the deep-link path.
 *
 * @module
 */

import { Convert } from '@enbox/common';

/** Byte length required of the single-use symmetric request key (XC20P). */
const ENCRYPTION_KEY_BYTE_LENGTH = 32;

/**
 * Builds the wallet URI handed to the user (QR code or deep link) for a
 * pushed connect request. Both parameters are carried fragment-only.
 *
 * @param params - The URI building parameters.
 * @param params.walletUri - The wallet app URI (typically ending in the
 *   connect route, e.g. `https://wallet.example/connect/app`).
 * @param params.requestUri - The relay `request_uri` returned by the pushed
 *   authorization request.
 * @param params.encryptionKey - The single-use 32-byte symmetric key
 *   protecting the pushed request.
 * @returns The wallet URI with `request_uri` and `encryption_key` fragment
 *          parameters.
 */
export function buildWalletConnectUri({ walletUri, requestUri, encryptionKey }: {
  walletUri: string;
  requestUri: string;
  encryptionKey: Uint8Array;
}): string {
  if (encryptionKey.length !== ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new Error(`Connect: wallet URI encryption key must be ${ENCRYPTION_KEY_BYTE_LENGTH} bytes.`);
  }

  const uri = new URL(walletUri);
  const fragmentParams = new URLSearchParams();
  fragmentParams.set('request_uri', requestUri);
  fragmentParams.set('encryption_key', Convert.uint8Array(encryptionKey).toBase64Url());
  uri.hash = fragmentParams.toString();
  return uri.toString();
}

/**
 * Parses a wallet connect URI produced by {@link buildWalletConnectUri},
 * returning the relay request pointer and the decoded request encryption key.
 *
 * Only the URI **fragment** is consulted — connect parameters in the query
 * string are ignored by design. Returns `undefined` when the URI is not a
 * valid URL, does not carry both connect parameters, or carries an
 * `encryption_key` that is not a base64url-encoded 32-byte value.
 *
 * @param uri - The wallet URI to parse.
 * @returns The request pointer and encryption key, or `undefined` when the
 *          URI does not carry valid connect parameters.
 */
export function parseWalletConnectUri(uri: string): {
  requestUri: string;
  encryptionKey: Uint8Array;
} | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }

  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(fragment);
  const requestUri = params.get('request_uri');
  const encryptionKeyBase64Url = params.get('encryption_key');
  if (!requestUri || !encryptionKeyBase64Url) {
    return undefined;
  }

  let encryptionKey: Uint8Array;
  try {
    encryptionKey = Convert.base64Url(encryptionKeyBase64Url).toUint8Array();
  } catch {
    return undefined;
  }
  if (encryptionKey.length !== ENCRYPTION_KEY_BYTE_LENGTH) {
    return undefined;
  }

  return { requestUri, encryptionKey };
}
