/**
 * Local DWN discovery — discovers a running `@enbox/dwn-server` instance
 * so the agent can route traffic to it.
 *
 * Discovery channels (tried in order):
 * 1. **In-memory cache** — serves a recent positive or negative result.
 * 2. **Discovery file** (`~/.enbox/dwn.json`) — written by `electrobun-dwn`
 *    on startup. Fast filesystem read, no network. Available for CLI and
 *    native apps; skipped in browsers.
 * 3. **Injected endpoint** — in browsers, the `dwn://connect` redirect
 *    flow delivers the endpoint, which is injected via
 *    {@link LocalDwnDiscovery.setCachedEndpoint | setCachedEndpoint()}.
 *
 * @see https://github.com/enboxorg/enbox/issues/677
 * @module
 */

import type { EnboxRpc } from '@enbox/dwn-clients';

import type { DwnDiscoveryFile } from './dwn-discovery-file.js';

/**
 * Controls how the agent discovers and routes to a local DWN server.
 *
 * - `'prefer'` — (default) use a paired local DWN first; fall back to DID-document endpoints.
 * - `'only'`   — require a local server; throw if none is found.
 * - `'off'`    — skip local discovery entirely.
 */
export type LocalDwnStrategy = 'prefer' | 'only' | 'off';

/** Default local DWN strategy. Discovery is passive: no localhost port sweep is performed. */
export const DEFAULT_LOCAL_DWN_STRATEGY: LocalDwnStrategy = 'prefer';

/** The `server` field returned by `GET /info` on `@enbox/dwn-server`. */
export const localDwnServerName = '@enbox/dwn-server';

/**
 * Well-known ports the packaged local DWN server may bind to.
 *
 * This list is used by the server/runtime surfaces for port selection and
 * status display. Client discovery must use an explicit pairing channel
 * (discovery file, persisted endpoint, or `dwn://connect`) rather than sweeping
 * this list.
 */
export const localDwnPortCandidates = [
  55500,
  55501,
  55502,
  55503,
  55504,
  55505,
  55506,
  55507,
  55508,
  55509,
  3000,
] as const;

/** Strips a trailing slash from a URL so endpoint comparisons are consistent. */
export function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Discovers a running local DWN server.
 *
 * Results are cached for {@link _cacheTtlMs} milliseconds (default 10 s) to
 * avoid repeated I/O on hot paths such as sync.
 *
 * @example Discovery with file-based channel (CLI / native)
 * ```ts
 * import { DwnDiscoveryFile } from './dwn-discovery-file.js';
 *
 * const discoveryFile = new DwnDiscoveryFile();
 * const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
 * const endpoint = await discovery.getEndpoint();
 * ```
 *
 * @example Browser: inject cached endpoint from `dwn://connect` redirect
 * ```ts
 * const discovery = new LocalDwnDiscovery(rpcClient);
 * discovery.setCachedEndpoint('http://127.0.0.1:55557');
 * ```
 */
export class LocalDwnDiscovery {
  private _cachedEndpoint?: string;
  private _cacheExpiry = 0;

  constructor(
    private readonly _rpcClient: EnboxRpc,
    private readonly _cacheTtlMs = 10_000,
    private readonly _discoveryFile?: DwnDiscoveryFile,
  ) {}

  /**
   * Returns the base URL of a local DWN server, or `undefined` if none
   * is discoverable.
   *
   * The discovery order is:
   * 1. In-memory cache (if not expired).
   * 2. `~/.enbox/dwn.json` discovery file (if a {@link DwnDiscoveryFile}
   *    was provided). The endpoint from the file is validated via
   *    `GET /info` to ensure the server is still running.
   *
   * If neither channel finds an endpoint, the result (`undefined`) is
   * cached to avoid repeated discovery file reads on hot paths.
   *
   * In browser environments (where no discovery file is available), the
   * endpoint must be injected externally via
   * {@link setCachedEndpoint | setCachedEndpoint()} — typically after a
   * `dwn://connect` redirect delivers the endpoint in the URL fragment.
   */
  public async getEndpoint(): Promise<string | undefined> {
    const now = Date.now();
    if (now < this._cacheExpiry) {
      return this._cachedEndpoint;
    }

    // File-based discovery (CLI / native — skipped when no file is configured).
    const fileEndpoint = await this._tryDiscoveryFile();
    if (fileEndpoint !== undefined) {
      this._setCacheEntry(fileEndpoint, now);
      return fileEndpoint;
    }

    // No endpoint found. Cache the negative result to avoid repeated
    // discovery file reads within the TTL window.
    this._setCacheEntry(undefined, now);
    return undefined;
  }

  /**
   * Inject a cached endpoint (e.g. from a `dwn://connect` browser redirect
   * or from `localStorage`). The endpoint is validated via `GET /info` before
   * caching.
   *
   * @returns `true` if the endpoint was validated and cached, `false` otherwise.
   */
  public async setCachedEndpoint(endpoint: string): Promise<boolean> {
    const normalized = normalizeBaseUrl(endpoint);
    const valid = await this._validateEndpoint(normalized);
    if (valid) {
      this._setCacheEntry(normalized, Date.now());
    }
    return valid;
  }

  /**
   * Clear the in-memory cache, forcing the next {@link getEndpoint} call
   * to perform a fresh discovery.
   */
  public clearCache(): void {
    this._cachedEndpoint = undefined;
    this._cacheExpiry = 0;
  }

  // ─── Private ──────────────────────────────────────────────────

  /**
   * Try the `~/.enbox/dwn.json` discovery file. Returns the endpoint if
   * the file exists, is valid, and the endpoint passes `GET /info`
   * validation. Returns `undefined` otherwise.
   */
  private async _tryDiscoveryFile(): Promise<string | undefined> {
    if (!this._discoveryFile) {
      return undefined;
    }

    try {
      const record = await this._discoveryFile.read();
      if (!record) {
        return undefined;
      }

      // Validate that the server is actually alive and is ours.
      const valid = await this._validateEndpoint(record.endpoint);
      return valid ? record.endpoint : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Call `GET /info` on the endpoint and check that
   * `serverInfo.server === '@enbox/dwn-server'`.
   */
  private async _validateEndpoint(endpoint: string): Promise<boolean> {
    try {
      const serverInfo = await this._rpcClient.getServerInfo(endpoint);
      return serverInfo.server === localDwnServerName;
    } catch {
      return false;
    }
  }

  /** Update the in-memory cache entry. */
  private _setCacheEntry(endpoint: string | undefined, now: number): void {
    this._cachedEndpoint = endpoint;
    this._cacheExpiry = now + this._cacheTtlMs;
  }
}
