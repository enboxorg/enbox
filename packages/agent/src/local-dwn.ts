import type { Web5Rpc } from '@enbox/dwn-clients';

/** Well-known ports the local DWN desktop app may bind to. */
export const localDwnPortCandidates = [3000, 55555, 55556, 55557, 55558, 55559] as const;

/** Hosts probed when discovering a local DWN server. */
export const localDwnHostCandidates = ['127.0.0.1', 'localhost'] as const;

/**
 * Controls how the agent discovers and routes to a local DWN server.
 *
 * - `'prefer'` — probe localhost first; fall back to DID-document endpoints.
 * - `'only'`   — require a local server; throw if none is found.
 * - `'off'`    — skip local discovery entirely.
 */
export type LocalDwnStrategy = 'prefer' | 'only' | 'off';

/** The `server` field returned by `GET /info` on `@enbox/dwn-server`. */
export const localDwnServerName = '@enbox/dwn-server';

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Probes well-known localhost ports for a running `@enbox/dwn-server` instance.
 *
 * Results are cached for {@link cacheTtlMs} milliseconds (default 10 s) to
 * avoid repeated HTTP round-trips on hot paths such as sync.
 *
 * TODO: Replace sequential port probing with an `enbox://` protocol-handler
 *       handshake (https://github.com/enboxorg/enbox/issues/287).
 */
export class LocalDwnDiscovery {
  private _cachedEndpoint?: string;
  private _cacheExpiry = 0;

  constructor(
    private _rpcClient: Web5Rpc,
    private _cacheTtlMs = 10_000
  ) {}

  /**
   * Returns the base URL of a local DWN server, or `undefined` if none is
   * reachable on the well-known port candidates.
   */
  public async getEndpoint(): Promise<string | undefined> {
    const now = Date.now();
    if (now < this._cacheExpiry) {
      return this._cachedEndpoint;
    }

    for (const port of localDwnPortCandidates) {
      for (const host of localDwnHostCandidates) {
        const endpoint = `http://${host}:${port}`;
        try {
          const serverInfo = await this._rpcClient.getServerInfo(endpoint);
          if (serverInfo.server === localDwnServerName) {
            this._cachedEndpoint = normalizeBaseUrl(endpoint);
            this._cacheExpiry = now + this._cacheTtlMs;
            return this._cachedEndpoint;
          }
        } catch {
          // keep probing candidate endpoints
        }
      }
    }

    this._cachedEndpoint = undefined;
    this._cacheExpiry = now + this._cacheTtlMs;
    return undefined;
  }
}
