/**
 * Returns true when the hostname is a loopback, private, link-local, or
 * otherwise non-routable literal that should not be fetched from untrusted
 * input.
 */
export function isPrivateHostname(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();

  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }

  const zoneIndex = h.indexOf('%');
  if (zoneIndex !== -1) {
    h = h.slice(0, zoneIndex);
  }

  if (h.endsWith('.')) {
    h = h.slice(0, -1);
  }

  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true;
  }

  const ipv4 = parseIpv4(h);
  if (ipv4 !== undefined) {
    return isPrivateIpv4(ipv4);
  }

  if (h.includes(':')) {
    return isPrivateIpv6(h);
  }

  return false;
}

/** Default protocols accepted by {@link assertPublicUrl} when no explicit list is given. */
const DEFAULT_PUBLIC_URL_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * Thrown by {@link assertPublicUrl} (and surfaced by {@link fetchPublicUrl}) when a URL — or a
 * redirect target — fails public-URL validation. Distinct from generic `Error` so callers can
 * map validation failures to a specific error code (e.g. `invalidGatewayUri`) without
 * accidentally also mapping unrelated network failures.
 */
export class PublicUrlValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PublicUrlValidationError';
  }
}

/**
 * Parses and validates that a URL targets a routable public host over an allowed network scheme.
 *
 * Rejects:
 * - URLs whose protocol is not in `allowedProtocols` (defaults to `http:` / `https:`), so callers
 *   cannot smuggle `file:`, `javascript:`, `data:`, `ws:`, etc. past a downstream `fetch()`.
 * - URLs without a hostname.
 * - URLs whose hostname is a loopback, private, link-local, or otherwise non-routable literal per
 *   {@link isPrivateHostname}.
 *
 * This intentionally does not perform DNS resolution, so callers handling high-risk server-side
 * fetches should still consider DNS rebinding defenses (and use {@link fetchPublicUrl} to also
 * validate every redirect target).
 */
export function assertPublicUrl(url: string | URL, description = 'URL', options?: { allowedProtocols?: readonly string[] }): URL {
  const parsedUrl = typeof url === 'string' ? new URL(url) : new URL(url.toString());
  const allowedProtocols = options?.allowedProtocols ?? DEFAULT_PUBLIC_URL_PROTOCOLS;

  if (!allowedProtocols.includes(parsedUrl.protocol)) {
    throw new PublicUrlValidationError(`${description} must use one of the allowed schemes (${allowedProtocols.join(', ')}): ${parsedUrl.protocol}`);
  }

  if (parsedUrl.hostname === '') {
    throw new PublicUrlValidationError(`${description} must specify a hostname.`);
  }

  if (isPrivateHostname(parsedUrl.hostname)) {
    throw new PublicUrlValidationError(`${description} must not target a private, loopback, or link-local host: ${parsedUrl.hostname}`);
  }

  return parsedUrl;
}

/**
 * Maximum number of HTTP redirects {@link fetchPublicUrl} will follow before giving up. Public
 * relays and DID document servers should rarely chain more than 1–2 redirects; this leaves enough
 * headroom for those while still bounding worst-case behavior.
 */
const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Performs a `fetch()` whose target — and every subsequent redirect target — is validated by
 * {@link assertPublicUrl}. Defends against SSRF via redirect-based bypasses where a public
 * gateway returns `Location: http://127.0.0.1/...` after the initial validation succeeded.
 *
 * Manually drives the redirect loop so each `Location` is re-validated. A 3xx response without a
 * `Location` header (e.g. `304 Not Modified`) is returned to the caller unchanged.
 */
export async function fetchPublicUrl(url: string | URL, init?: RequestInit, options?: {
  description?: string;
  allowedProtocols?: readonly string[];
  maxRedirects?: number;
}): Promise<Response> {
  const description = options?.description ?? 'URL';
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = assertPublicUrl(url, description, { allowedProtocols: options?.allowedProtocols }).href;

  for (let attempt = 0; attempt <= maxRedirects; attempt++) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

    if (!REDIRECT_STATUS_CODES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (location === null) {
      return response;
    }

    currentUrl = assertPublicUrl(new URL(location, currentUrl), description, { allowedProtocols: options?.allowedProtocols }).href;
  }

  throw new Error(`${description} exceeded the maximum number of redirects (${maxRedirects}).`);
}

/**
 * Concatenates a base URL and a path ensuring that there is exactly one slash between them.
 *
 * The `path` argument must be a pure URL pathname — raw `?` (query) and `#` (fragment) delimiters
 * are rejected because they are silently percent-encoded by the WHATWG URL parser when assigned
 * to `pathname`, which would otherwise change the endpoint a caller meant to reach. Callers that
 * need to attach a query string or fragment should construct the URL explicitly. Percent-encoded
 * `%3F` / `%23` are preserved so genuine path segments containing those characters work.
 */
export function concatenateUrl(baseUrl: string, path: string): string {
  if (path.includes('?') || path.includes('#')) {
    throw new Error('Path must not contain a raw query string or fragment; build the URL explicitly instead.');
  }

  const sanitizedPath = path.replaceAll(/^\/+/g, '');
  const segments = sanitizedPath.split('/');

  if (segments.some(isUnsafePathSegment)) {
    throw new Error('Path must not contain parent directory segments.');
  }

  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${basePath}${sanitizedPath}`.replaceAll(/\/{2,}/g, '/');

  if (url.pathname.includes('/../') || url.pathname.endsWith('/..')) {
    throw new Error('Path must not escape the base URL path.');
  }

  return url.toString();
}

/**
 * Returns true when a single path segment is unsafe to append to a base URL.
 *
 * A segment is unsafe when it contains parent-directory traversal (`..`), embedded path
 * separators (`/` or `\`) — including any percent-encoded variants — or malformed percent
 * encoding (which is always rejected so callers cannot smuggle traversal past `decodeURIComponent`
 * by triggering a `URIError`).
 */
function isUnsafePathSegment(segment: string): boolean {
  if (segment === '..') {
    return true;
  }

  let decodedSegment: string;
  try {
    decodedSegment = decodeURIComponent(segment);
  } catch {
    return true;
  }

  return decodedSegment === '..' || decodedSegment.includes('/') || decodedSegment.includes('\\');
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number(part);
  });

  if (!octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return undefined;
  }

  return octets as [number, number, number, number];
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) { return true; } // 0.0.0.0/8
  if (a === 10) { return true; } // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) { return true; } // 100.64.0.0/10
  if (a === 127) { return true; } // 127.0.0.0/8
  if (a === 169 && b === 254) { return true; } // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) { return true; } // 172.16.0.0/12
  if (a === 192 && b === 168) { return true; } // 192.168.0.0/16
  if (a >= 224) { return true; } // multicast/reserved

  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const hextets = parseIpv6(hostname);
  if (hextets === undefined) {
    return false;
  }

  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  const firstSixZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;

  if (hextets.every((hextet) => hextet === 0)) { return true; } // ::/128
  if (firstSixZero && h6 === 0 && h7 === 1) { return true; } // ::1/128

  if ((h0 & 0xfe00) === 0xfc00) { return true; } // fc00::/7
  if ((h0 & 0xffc0) === 0xfe80) { return true; } // fe80::/10
  if ((h0 & 0xff00) === 0xff00) { return true; } // ff00::/8

  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isPrivateIpv4(ipv6HextetsToIpv4(h6, h7)); // 64:ff9b::/96
  }

  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return isPrivateIpv4(ipv6HextetsToIpv4(h6, h7)); // ::ffff:0:0/96
  }

  if (firstSixZero) {
    return true; // deprecated IPv4-compatible ::/96
  }

  return false;
}

function parseIpv6(hostname: string): number[] | undefined {
  const [left, right, extra] = hostname.split('::');
  if (extra !== undefined) {
    return undefined;
  }

  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === undefined || right === '' ? [] : right.split(':');
  const parts = expandIpv4Suffix([...leftParts, ...rightParts]);
  if (parts === undefined) {
    return undefined;
  }

  if (parts.length > 8 || (right === undefined && parts.length !== 8) || (right !== undefined && parts.length >= 8)) {
    return undefined;
  }

  const parsedParts = parts.map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 16);
  });
  if (!parsedParts.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) {
    return undefined;
  }

  if (right === undefined) {
    return parsedParts;
  }

  const fill = new Array(8 - parsedParts.length).fill(0);
  return [
    ...parsedParts.slice(0, leftParts.length),
    ...fill,
    ...parsedParts.slice(leftParts.length),
  ];
}

function expandIpv4Suffix(parts: string[]): string[] | undefined {
  const last = parts.at(-1);
  if (!last?.includes('.')) {
    return parts;
  }

  const ipv4 = parseIpv4(last);
  if (ipv4 === undefined) {
    return undefined;
  }

  const [a, b, c, d] = ipv4;
  return [
    ...parts.slice(0, -1),
    (((a << 8) | b) & 0xffff).toString(16),
    (((c << 8) | d) & 0xffff).toString(16),
  ];
}

function ipv6HextetsToIpv4(high: number, low: number): [number, number, number, number] {
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ];
}
