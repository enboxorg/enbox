/**
 * Local DWN discovery — discovers a running `@enbox/dwn-server` instance
 * so the agent can route traffic to it.
 *
 * Discovery channels (tried in order):
 * 1. **In-memory cache** — serves a recent positive or negative result.
 * 2. **Discovery file** (`~/.enbox/dwn.json`) — written by `electrobun-dwn`
 *    on startup. Fast filesystem read, no network. Available for CLI and
 *    native apps; skipped in browsers.
 * 3. **Port probing** (fallback) — sequential HTTP `GET /info` on well-known
 *    localhost ports. Works everywhere but is slower.
 *
 * @see https://github.com/enboxorg/enbox/issues/585
 * @module
 */

import type { EnboxRpc } from '@enbox/dwn-clients';

import type { DwnDiscoveryFile } from './dwn-discovery-file.js';

/**
 * Well-known ports the local DWN desktop app may bind to.
 *
 * Per the DWN Transport Spec, clients probe ports `55500` through `55509`
 * (inclusive). Port `3000` is included as a development convenience.
 *
 * @see https://identity.foundation/dwn-transport/#port-probing
 */
export const localDwnPortCandidates = [3000, 55500, 55501, 55502, 55503, 55504, 55505, 55506, 55507, 55508, 55509] as const;

/**
 * Hosts probed when discovering a local DWN server.
 *
 * Per the DWN Transport Spec, clients MUST use `127.0.0.1` rather than
 * `localhost` to avoid DNS resolution ambiguity.
 *
 * @see https://identity.foundation/dwn-transport/#port-probing
 */
export const localDwnHostCandidates = ['127.0.0.1'] as const;

/**
 * Controls how the agent discovers and routes to a local DWN server.
 *
 * - `'off'`    — (default) skip local discovery entirely.
 * - `'prefer'` — probe localhost first; fall back to DID-document endpoints.
 * - `'only'`   — require a local server; throw if none is found.
 */
export type LocalDwnStrategy = 'prefer' | 'only' | 'off';

/** The `server` field returned by `GET /info` on `@enbox/dwn-server`. */
export const localDwnServerName = '@enbox/dwn-server';

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
 * @example Discovery with file-based channel
 * ```ts
 * import { DwnDiscoveryFile } from './dwn-discovery-file.js';
 *
 * const discoveryFile = new DwnDiscoveryFile();
 * const discovery = new LocalDwnDiscovery(rpcClient, 10_000, discoveryFile);
 * const endpoint = await discovery.getEndpoint();
 * ```
 *
 * @example Browser: inject cached endpoint from `dwn://register` redirect
 * ```ts
 * const discovery = new LocalDwnDiscovery(rpcClient);
 * discovery.setCachedEndpoint('http://127.0.0.1:55557');
 * ```
 */
export class LocalDwnDiscovery {
  private _cachedEndpoint?: string;
  private _cacheExpiry = 0;

  constructor(
    private _rpcClient: EnboxRpc,
    private _cacheTtlMs = 10_000,
    private _discoveryFile?: DwnDiscoveryFile,
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
   * 3. Sequential port probing on well-known localhost ports (fallback).
   */
  public async getEndpoint(): Promise<string | undefined> {
    const now = Date.now();
    if (now < this._cacheExpiry) {
      return this._cachedEndpoint;
    }

    // Channel 1: file-based discovery.
    const fileEndpoint = await this._tryDiscoveryFile();
    if (fileEndpoint !== undefined) {
      this._setCacheEntry(fileEndpoint, now);
      return fileEndpoint;
    }

    // Channel 2: sequential port probing (fallback).
    const probeEndpoint = await this._probePortCandidates();
    // Cache both positive and negative results.
    this._setCacheEntry(probeEndpoint, now);
    return probeEndpoint;
  }

  /**
   * Inject a cached endpoint (e.g. from a `dwn://register` browser redirect
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

  // ─── Private discovery channels ────────────────────────────────

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
   * Sequential HTTP probe on well-known localhost port candidates.
   * Returns the first endpoint whose `GET /info` response identifies
   * as `@enbox/dwn-server`, or `undefined` if none is found.
   */
  private async _probePortCandidates(): Promise<string | undefined> {
    for (const port of localDwnPortCandidates) {
      for (const host of localDwnHostCandidates) {
        const endpoint = `http://${host}:${port}`;
        const valid = await this._validateEndpoint(endpoint);
        if (valid) {
          return normalizeBaseUrl(endpoint);
        }
      }
    }
    return undefined;
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
