export type SyncEchoSuppressorParams = {
  maxEntries?: number;
  now?: () => number;
  ttlMs?: number;
};

/**
 * Tracks recently transferred messages to suppress endpoint-local sync echoes.
 *
 * Entries are scoped by tenant and remote endpoint so suppressing an echo for
 * one replication link cannot prevent another tenant or provider from seeing
 * the same CID. The policy is in-memory and independent of a storage backend.
 */
export class SyncEchoSuppressor {
  private static readonly DEFAULT_MAX_ENTRIES = 10_000;
  private static readonly DEFAULT_TTL_MS = 60_000;

  private readonly _maxEntries: number;
  private readonly _now: () => number;
  private readonly _pulledEntries: Map<string, number> = new Map();
  private readonly _pushedEntries: Map<string, number> = new Map();
  private readonly _ttlMs: number;

  constructor({
    maxEntries = SyncEchoSuppressor.DEFAULT_MAX_ENTRIES,
    now = (): number => Date.now(),
    ttlMs = SyncEchoSuppressor.DEFAULT_TTL_MS,
  }: SyncEchoSuppressorParams = {}) {
    this._maxEntries = maxEntries;
    this._now = now;
    this._ttlMs = ttlMs;
  }

  /** Clear both transfer directions during sync-runtime teardown. */
  public clear(): void {
    this._pulledEntries.clear();
    this._pushedEntries.clear();
  }

  /** Return whether this link recently pulled the CID and should not push it back. */
  public hasRecentlyPulled(tenantDid: string, messageCid: string, remoteEndpoint: string): boolean {
    return this.hasUnexpiredEntry(this._pulledEntries, tenantDid, messageCid, remoteEndpoint);
  }

  /** Return whether this link recently pushed the CID and may commit its pull echo directly. */
  public hasRecentlyPushed(tenantDid: string, messageCid: string, remoteEndpoint: string): boolean {
    return this.hasUnexpiredEntry(this._pushedEntries, tenantDid, messageCid, remoteEndpoint);
  }

  /** Record a successfully pulled message for endpoint-local push suppression. */
  public trackPulled(tenantDid: string, messageCid: string, remoteEndpoint: string): void {
    this.track(this._pulledEntries, tenantDid, messageCid, remoteEndpoint);
  }

  /** Record a message about to be pushed so its subscription echo can be committed directly. */
  public trackPushed(tenantDid: string, messageCid: string, remoteEndpoint: string): void {
    this.track(this._pushedEntries, tenantDid, messageCid, remoteEndpoint);
  }

  private static cacheKey(tenantDid: string, messageCid: string, remoteEndpoint: string): string {
    return `${messageCid}|${tenantDid}|${remoteEndpoint}`;
  }

  private evictExpiredAndExcessEntries(cache: Map<string, number>, now: number): void {
    for (const [key, expiry] of cache) {
      if (now >= expiry) {
        cache.delete(key);
      }
    }

    const excess = cache.size - this._maxEntries;
    if (excess <= 0) {
      return;
    }

    let evicted = 0;
    for (const key of cache.keys()) {
      if (evicted >= excess) { break; }
      cache.delete(key);
      evicted++;
    }
  }

  private hasUnexpiredEntry(
    cache: Map<string, number>,
    tenantDid: string,
    messageCid: string,
    remoteEndpoint: string,
  ): boolean {
    const key = SyncEchoSuppressor.cacheKey(tenantDid, messageCid, remoteEndpoint);
    const expiry = cache.get(key);
    if (expiry === undefined) { return false; }
    if (this._now() >= expiry) {
      cache.delete(key);
      return false;
    }
    return true;
  }

  private track(
    cache: Map<string, number>,
    tenantDid: string,
    messageCid: string,
    remoteEndpoint: string,
  ): void {
    const now = this._now();
    cache.set(
      SyncEchoSuppressor.cacheKey(tenantDid, messageCid, remoteEndpoint),
      now + this._ttlMs,
    );
    this.evictExpiredAndExcessEntries(cache, now);
  }
}
