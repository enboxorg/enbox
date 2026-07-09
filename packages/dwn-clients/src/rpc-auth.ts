import type { DwnRpcAuthOptions } from './dwn-rpc-types.js';

/**
 * Normalizes equivalent HTTP and WebSocket DWN endpoint URLs for
 * endpoint-scoped transport authentication.
 */
export function normalizeDwnRpcAuthEndpoint(dwnUrl: string): string {
  const url = new URL(dwnUrl);
  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  }

  url.password = '';
  url.username = '';
  url.hash = '';
  url.search = '';

  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function getBearerTokenForUrl(authOptions: DwnRpcAuthOptions | undefined, dwnUrl: string): string | undefined {
  return authOptions?.getBearerToken?.(dwnUrl);
}

export function attachBearerToken(
  headers: Record<string, string>,
  authOptions: DwnRpcAuthOptions | undefined,
  dwnUrl: string,
): void {
  const token = getBearerTokenForUrl(authOptions, dwnUrl);
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
}

export function withLocalNodeTokenQuery(
  dwnUrl: string,
  authOptions: DwnRpcAuthOptions | undefined,
): URL {
  const url = new URL(dwnUrl);
  const token = getBearerTokenForUrl(authOptions, dwnUrl);
  if (token !== undefined) {
    url.searchParams.set('localNodeToken', token);
  }
  return url;
}
