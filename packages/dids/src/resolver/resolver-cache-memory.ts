import { TtlCache } from '@enbox/common';

import type { DidResolutionResult } from '../types/did-core.js';
import type { DidResolverCache } from '../types/did-resolution.js';

import {
  assertMaxBytes,
  byteLength,
  type CachedDidResolutionResult,
  DEFAULT_DID_CACHE_MAX_BYTES,
  DEFAULT_DID_CACHE_MAX_IDLE,
  DEFAULT_DID_CACHE_TTL,
  isFresh,
  parsePositiveDuration,
} from './resolver-cache-utils.js';

/** Configuration for the in-memory DID resolution cache. */
export type DidResolverCacheMemoryParams = {
  /** Maximum time an unpinned result may remain unused. Defaults to 90 days. */
  maxIdle?: string;

  /** Maximum retained bytes for unpinned results. Defaults to 32 MiB. */
  maxBytes?: number;

  /** Freshness interval before the resolver should attempt a refresh. Defaults to 15 minutes. */
  ttl?: string;
};

/** In-memory DID cache with separate freshness, idle-retention, and byte-budget policies. */
export class DidResolverCacheMemory implements DidResolverCache {
  private readonly _cache: TtlCache<string, CachedDidResolutionResult>;
  private readonly _maxBytes: number;
  private readonly _pinned = new Map<string, CachedDidResolutionResult>();
  private readonly _ttl: number;
  private _unpinnedBytes = 0;

  public constructor({
    maxBytes = DEFAULT_DID_CACHE_MAX_BYTES,
    maxIdle = DEFAULT_DID_CACHE_MAX_IDLE,
    ttl = DEFAULT_DID_CACHE_TTL,
  }: DidResolverCacheMemoryParams = {}) {
    assertMaxBytes(maxBytes);

    this._maxBytes = maxBytes;
    this._ttl = parsePositiveDuration(ttl, 'ttl');
    this._cache = new TtlCache({
      dispose: (entry: CachedDidResolutionResult, didUri: string): void => {
        this._unpinnedBytes -= this.entrySize(didUri, entry);
      },
      ttl            : parsePositiveDuration(maxIdle, 'maxIdle'),
      updateAgeOnGet : false,
    });
  }

  /** This method is a no-op since in-memory stores are always ready. */
  public async open(): Promise<void> {
    // No-op since there is no underlying store to open.
  }

  /** Return a fresh cached result and renew its idle retention. */
  public async get(didUri: string): Promise<DidResolutionResult | void> {
    this.assertDidUri(didUri);

    const entry = this.peek(didUri);
    if (entry === undefined || !isFresh(entry)) {
      return;
    }

    this.touch(didUri);
    return entry.value;
  }

  /** Return the last successful retained result, even when it is no longer fresh. */
  public async getRetained(didUri: string): Promise<DidResolutionResult | void> {
    this.assertDidUri(didUri);

    const entry = this.peek(didUri);
    if (entry === undefined) {
      return;
    }

    this.touch(didUri);
    return entry.value;
  }

  /** Store a fresh result, preserving an existing pin. */
  public async set(didUri: string, resolutionResult: DidResolutionResult): Promise<void> {
    this.assertDidUri(didUri);

    const entry: CachedDidResolutionResult = {
      ttlMillis : Date.now() + this._ttl,
      value     : resolutionResult,
    };

    if (this._pinned.has(didUri)) {
      this._pinned.set(didUri, { ...entry, pinned: true });
      return;
    }

    this._unpinnedBytes += this.entrySize(didUri, entry);
    this._cache.set(didUri, entry);
    this._cache.cancelTimer();
    this.evictToBudget();
  }

  /** Protect a trusted result from automatic idle and capacity eviction. */
  public async pin(didUri: string, fallback: DidResolutionResult): Promise<void> {
    this.assertDidUri(didUri);

    if (this._pinned.has(didUri)) {
      return;
    }

    const retained = this._cache.get(didUri, { updateAgeOnGet: false });
    if (retained !== undefined) {
      this._cache.delete(didUri);
      this._pinned.set(didUri, { ...retained, pinned: true });
      return;
    }

    this._pinned.set(didUri, {
      pinned    : true,
      ttlMillis : Date.now() + this._ttl,
      value     : fallback,
    });
  }

  /** Delete a retained result regardless of whether it is pinned. */
  public async delete(didUri: string): Promise<void> {
    this._cache.delete(didUri);
    this._pinned.delete(didUri);
  }

  /** Clear all retained results, including pinned entries. */
  public async clear(): Promise<void> {
    this._cache.clear();
    this._pinned.clear();
    this._unpinnedBytes = 0;
  }

  /** This method is a no-op since the cache owns no external resources. */
  public async close(): Promise<void> {
    // No-op since there is no underlying store to close.
  }

  private assertDidUri(didUri: string): void {
    if (!didUri) {
      throw new Error('Key cannot be null or undefined');
    }
  }

  private entrySize(didUri: string, entry: CachedDidResolutionResult): number {
    return byteLength(didUri) + byteLength(JSON.stringify(entry));
  }

  private evictToBudget(): void {
    if (this._maxBytes === Infinity || this._unpinnedBytes <= this._maxBytes) {
      return;
    }

    for (const [didUri] of this._cache) {
      this._cache.delete(didUri);
      if (this._unpinnedBytes <= this._maxBytes) {
        return;
      }
    }
  }

  private peek(didUri: string): CachedDidResolutionResult | undefined {
    return this._pinned.get(didUri) ?? this._cache.get(didUri, { updateAgeOnGet: false });
  }

  private touch(didUri: string): void {
    if (!this._pinned.has(didUri)) {
      this._cache.get(didUri, { updateAgeOnGet: true });
      this._cache.cancelTimer();
    }
  }
}
