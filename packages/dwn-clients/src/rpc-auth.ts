import type { DwnRpcAuthOptions } from './dwn-rpc-types.js';

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
