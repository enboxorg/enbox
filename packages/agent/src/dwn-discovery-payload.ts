/**
 * Shared types and utilities for the `dwn://register` discovery protocol.
 *
 * The payload is the JSON data exchanged between the local DWN server
 * (electrobun-dwn) and the requesting app during the `dwn://register`
 * redirect flow. It is encoded as base64url and placed in the URL
 * fragment (`#`) of the callback URL.
 *
 * @see https://github.com/enboxorg/enbox/issues/586
 * @module
 */

import { Convert } from '@enbox/common';

// ─── Types ────────────────────────────────────────────────────────

/**
 * The JSON payload delivered via the URL fragment in a `dwn://register`
 * callback redirect.
 *
 * Intentionally minimal — everything beyond the endpoint (version,
 * WebSocket support, etc.) is obtained from `GET {endpoint}/info`.
 */
export type DwnDiscoveryPayload = {
  /** Base URL of the running DWN server (e.g. `"http://127.0.0.1:55557"`). */
  endpoint: string;
};

/**
 * Parsed result from a `dwn://register` URL.
 */
export type DwnRegisterUrlParams = {
  /** The callback URL to redirect to with the discovery payload. */
  callback: string;
};

// ─── Constants ────────────────────────────────────────────────────

/** The URL scheme for DWN discovery protocol handlers. */
export const DWN_PROTOCOL_SCHEME = 'dwn';

/** The `dwn://register` path that triggers the discovery handshake. */
export const DWN_REGISTER_PATH = 'register';

// ─── Payload encoding/decoding ───────────────────────────────────

/**
 * Encode a {@link DwnDiscoveryPayload} as a base64url string suitable
 * for use in a URL fragment.
 *
 * @param payload - The discovery payload to encode.
 * @returns A base64url-encoded string (no padding).
 */
export function encodeDwnDiscoveryPayload(payload: DwnDiscoveryPayload): string {
  const json = JSON.stringify(payload);
  return Convert.string(json).toBase64Url();
}

/**
 * Decode a base64url-encoded string back into a {@link DwnDiscoveryPayload}.
 *
 * @param encoded - The base64url string from the URL fragment.
 * @returns The parsed payload, or `undefined` if decoding or parsing fails.
 */
export function decodeDwnDiscoveryPayload(encoded: string): DwnDiscoveryPayload | undefined {
  try {
    const json = Convert.base64Url(encoded).toString();
    const parsed: unknown = JSON.parse(json);

    if (!isValidPayload(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

// ─── URL parsing ─────────────────────────────────────────────────

/**
 * Parse a `dwn://register?callback=<url>` URL into its components.
 *
 * @param url - The full `dwn://register?callback=...` URL.
 * @returns The parsed parameters, or `undefined` if the URL is not a
 *   valid `dwn://register` URL or is missing the `callback` parameter.
 */
export function parseDwnRegisterUrl(url: string): DwnRegisterUrlParams | undefined {
  try {
    // dwn://register?callback=... is not a standard hierarchical URL, so
    // we parse it manually to avoid URL constructor quirks with custom schemes.
    const schemePrefix = `${DWN_PROTOCOL_SCHEME}://`;
    if (!url.startsWith(schemePrefix)) {
      return undefined;
    }

    const withoutScheme = url.slice(schemePrefix.length);

    // Split on '?' to separate the path from query parameters.
    const questionIndex = withoutScheme.indexOf('?');
    if (questionIndex === -1) {
      return undefined;
    }

    const path = withoutScheme.slice(0, questionIndex);
    if (path !== DWN_REGISTER_PATH) {
      return undefined;
    }

    const queryString = withoutScheme.slice(questionIndex + 1);
    const params = new URLSearchParams(queryString);
    const callback = params.get('callback');

    if (!callback || callback.length === 0) {
      return undefined;
    }

    return { callback };
  } catch {
    return undefined;
  }
}

/**
 * Build the full callback redirect URL with the discovery payload
 * encoded in the URL fragment.
 *
 * @param callbackUrl - The callback URL from the `dwn://register` request.
 * @param payload - The discovery payload to encode in the fragment.
 * @returns The full redirect URL (e.g. `https://notes.sh/dwn#eyJ...`).
 */
export function buildDwnDiscoveryRedirectUrl(
  callbackUrl: string,
  payload: DwnDiscoveryPayload,
): string {
  const encoded = encodeDwnDiscoveryPayload(payload);
  // Strip any existing fragment from the callback URL before appending ours.
  const base = callbackUrl.split('#')[0];
  return `${base}#${encoded}`;
}

/**
 * Read a {@link DwnDiscoveryPayload} from a URL's fragment (hash).
 *
 * Intended for use in the browser callback page that receives the
 * redirect from electrobun-dwn.
 *
 * @param url - The full URL including the `#` fragment, or just the
 *   fragment string (with or without the leading `#`).
 * @returns The parsed payload, or `undefined` if the fragment is missing
 *   or contains an invalid payload.
 */
export function readDwnDiscoveryPayloadFromUrl(url: string): DwnDiscoveryPayload | undefined {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) {
    // Maybe it's just the fragment without the leading #.
    return decodeDwnDiscoveryPayload(url);
  }

  const fragment = url.slice(hashIndex + 1);
  if (fragment.length === 0) {
    return undefined;
  }

  return decodeDwnDiscoveryPayload(fragment);
}

// ─── Internal helpers ─────────────────────────────────────────────

/** Type guard for a valid {@link DwnDiscoveryPayload}. */
function isValidPayload(value: unknown): value is DwnDiscoveryPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.endpoint !== 'string' || record.endpoint.length === 0) {
    return false;
  }

  return true;
}
