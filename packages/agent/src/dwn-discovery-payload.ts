/**
 * Shared types and utilities for the `dwn://connect` discovery protocol.
 *
 * The payload is the JSON data exchanged between the local DWN server
 * (electrobun-dwn) and the requesting app during the `dwn://connect`
 * redirect flow. It is encoded as base64url and placed in the URL
 * fragment (`#`) of the callback URL.
 *
 * This module intentionally avoids external dependencies so it can be
 * consumed from any environment (Bun, browser, Electrobun) without
 * triggering transitive dependency resolution issues.
 *
 * @module
 */

// ─── Types ────────────────────────────────────────────────────────

/**
 * The JSON payload delivered via the URL fragment in a `dwn://connect`
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
 * Parsed result from a `dwn://connect` URL.
 */
export type DwnConnectUrlParams = {
  /** The callback URL to redirect to with the discovery payload. */
  callback: string;
};

// ─── Constants ────────────────────────────────────────────────────

/** The URL scheme for DWN discovery protocol handlers. */
export const DWN_PROTOCOL_SCHEME = 'dwn';

/** The `dwn://connect` path that triggers the discovery handshake. */
export const DWN_CONNECT_PATH = 'connect';

// ─── Register URL construction ───────────────────────────────────

/**
 * Build a `dwn://connect?callback=<url>` URL that, when opened by the OS,
 * triggers electrobun-dwn (or another `dwn://` scheme handler) to redirect
 * back to `callbackUrl` with the local DWN endpoint in the URL fragment.
 *
 * This is the **trigger** side of the `dwn://connect` browser flow.
 * The web app opens this URL (e.g. via `window.open()` or `location.href`),
 * the OS routes it to the registered handler, and the handler redirects
 * back with the discovery payload.
 *
 * @param callbackUrl - The URL to redirect back to after discovery.
 *   This should be the current page (or a dedicated callback page) that
 *   will read the payload from `window.location.hash`.
 * @returns The `dwn://connect?callback=<encoded-url>` URL string.
 *
 * @example
 * ```ts
 * const registerUrl = buildDwnConnectUrl('https://myapp.com/callback');
 * // => 'dwn://connect?callback=https%3A%2F%2Fmyapp.com%2Fcallback'
 * window.open(registerUrl);
 * ```
 */
export function buildDwnConnectUrl(callbackUrl: string): string {
  return `${DWN_PROTOCOL_SCHEME}://${DWN_CONNECT_PATH}?callback=${encodeURIComponent(callbackUrl)}`;
}

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
  return stringToBase64Url(json);
}

/**
 * Decode a base64url-encoded string back into a {@link DwnDiscoveryPayload}.
 *
 * @param encoded - The base64url string from the URL fragment.
 * @returns The parsed payload, or `undefined` if decoding or parsing fails.
 */
export function decodeDwnDiscoveryPayload(encoded: string): DwnDiscoveryPayload | undefined {
  try {
    const json = base64UrlToString(encoded);
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
 * Parse a `dwn://connect?callback=<url>` URL into its components.
 *
 * @param url - The full `dwn://connect?callback=...` URL.
 * @returns The parsed parameters, or `undefined` if the URL is not a
 *   valid `dwn://connect` URL or is missing the `callback` parameter.
 */
export function parseDwnConnectUrl(url: string): DwnConnectUrlParams | undefined {
  try {
    // dwn://connect?callback=... is not a standard hierarchical URL, so
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
    if (path !== DWN_CONNECT_PATH) {
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
 * @param callbackUrl - The callback URL from the `dwn://connect` request.
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

/**
 * Type guard for a valid {@link DwnDiscoveryPayload}.
 *
 * The endpoint MUST point to a loopback address (`127.0.0.1`, `[::1]`,
 * or `localhost`) because the `dwn://connect` payload is only intended
 * for local DWN discovery. Accepting arbitrary hostnames would allow a
 * malicious payload to redirect agent traffic to a remote server.
 *
 * @see https://github.com/enboxorg/enbox/issues/633
 */
function isValidPayload(value: unknown): value is DwnDiscoveryPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.endpoint !== 'string' || record.endpoint.length === 0) {
    return false;
  }

  if (!isLoopbackEndpoint(record.endpoint)) {
    return false;
  }

  return true;
}

/**
 * Returns `true` if the endpoint URL's hostname resolves to a loopback
 * address.  Accepts `127.0.0.1`, `::1` (with or without brackets), and
 * `localhost` (bare or with any subdomain suffix, per RFC 6761 §6.3).
 *
 * This is a security boundary: the `dwn://connect` redirect flow MUST
 * NOT allow payloads that point to non-local servers.
 */
function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();

    // IPv4 loopback: 127.0.0.1
    if (hostname === '127.0.0.1') {
      return true;
    }

    // IPv6 loopback: [::1] — URL.hostname strips the brackets.
    if (hostname === '::1' || hostname === '[::1]') {
      return true;
    }

    // `localhost` or any subdomain (e.g. `foo.localhost`).
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Encode a UTF-8 string as unpadded base64url (RFC 4648 §5).
 *
 * Uses `TextEncoder` to correctly handle all Unicode code points
 * (including those above U+00FF that `btoa` cannot represent).
 *
 * This module MUST remain dependency-free — no imports from
 * `@enbox/common` or any other package.
 */
function stringToBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  // Build a binary string from the UTF-8 byte array so `btoa` can
  // consume it (btoa only accepts Latin-1 / code points ≤ U+00FF).
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCodePoint(bytes[i]);
  }
  const result = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
  // Strip trailing '=' padding without regex quantifiers (avoids ReDoS scanners).
  let end = result.length;
  while (end > 0 && result.codePointAt(end - 1) === 61) { end--; } // 61 === '='
  return end === result.length ? result : result.slice(0, end);
}

/**
 * Decode an unpadded base64url string back to a UTF-8 string.
 *
 * Re-adds padding and swaps base64url characters back to standard
 * base64 before calling `atob`, then feeds the resulting bytes through
 * `TextDecoder` for correct UTF-8 handling.
 */
function base64UrlToString(input: string): string {
  // Restore standard base64 alphabet and padding.
  let base64 = input.replaceAll('-', '+').replaceAll('_', '/');
  const remainder = base64.length % 4;
  if (remainder === 2) {
    base64 += '==';
  } else if (remainder === 3) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i)!;
  }
  return new TextDecoder().decode(bytes);
}
