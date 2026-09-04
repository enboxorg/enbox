import type { AbstractLevel } from 'abstract-level';

import { Level } from 'level';

import type { DidResolutionResult } from '../types/did-core.js';
import type { DidResolverCache } from '../types/did-resolution.js';

import {
  assertMaxBytes,
  byteLength,
  type CachedDidResolutionResult,
  DEFAULT_DID_CACHE_MAX_BYTES,
  DEFAULT_DID_CACHE_MAX_IDLE,
  DEFAULT_DID_CACHE_TOUCH_INTERVAL,
  DEFAULT_DID_CACHE_TTL,
  isFresh,
  parsePositiveDuration,
} from './resolver-cache-utils.js';

/** Configuration for the persistent DID resolution cache. */
export type DidResolverCacheLevelParams = {
  /** Optional preconfigured Level-compatible database. */
  db?: AbstractLevel<string | Buffer | Uint8Array, string, string>;

  /** Filesystem path or IndexedDB name. Defaults to `DATA/DID_RESOLVERCACHE`. */
  location?: string;

  /** Maximum time an unpinned result may remain unused. Defaults to 90 days. */
  maxIdle?: string;

  /** Maximum retained bytes for unpinned results. Defaults to 32 MiB. */
  maxBytes?: number;

  /** Minimum interval between persisted last-used updates. Defaults to one hour. */
  touchInterval?: string;

  /** Freshness interval before the resolver should attempt a refresh. Defaults to 15 minutes. */
  ttl?: string;
};

type RetainedCacheEntry = {
  entry: CachedDidResolutionResult;
  lastUsedAt: number;
};

type EvictionCandidate = {
  didUri: string;
  lastUsedAt: number;
  size: number;
};

type CacheSnapshot = {
  accessTimes: Map<string, number>;
  entries: { didUri: string; serialized: string }[];
};

type PrunePlan = {
  candidates: EvictionCandidate[];
  deleteKeys: Set<string>;
  initializeAccess: Set<string>;
};

const ACCESS_KEY_PREFIX = '\u0000access:';

/** Persistent DID cache with separate freshness, idle-retention, and byte-budget policies. */
export class DidResolverCacheLevel implements DidResolverCache {
  /** The underlying LevelDB store used for caching. */
  protected cache;

  /** The freshness interval in milliseconds. */
  protected ttl: number;

  private readonly _maxBytes: number;
  private readonly _maxIdle: number;
  private readonly _touchInterval: number;

  public constructor({
    db,
    location = 'DATA/DID_RESOLVERCACHE',
    maxBytes = DEFAULT_DID_CACHE_MAX_BYTES,
    maxIdle = DEFAULT_DID_CACHE_MAX_IDLE,
    touchInterval = DEFAULT_DID_CACHE_TOUCH_INTERVAL,
    ttl = DEFAULT_DID_CACHE_TTL,
  }: DidResolverCacheLevelParams = {}) {
    assertMaxBytes(maxBytes);

    this.cache = db ?? new Level<string, string>(location);
    this.ttl = parsePositiveDuration(ttl, 'ttl');
    this._maxBytes = maxBytes;
    this._maxIdle = parsePositiveDuration(maxIdle, 'maxIdle');
    this._touchInterval = Math.min(parsePositiveDuration(touchInterval, 'touchInterval'), this._maxIdle / 2);
  }

  /** Open the underlying store and enforce its persisted retention limits. */
  public async open(): Promise<void> {
    await this.cache.open();
    await this.prune();
  }

  /** Return a fresh cached result and renew its idle retention. */
  public async get(didUri: string): Promise<DidResolutionResult | void> {
    const retained = await this.readRetainedEntry(didUri);
    if (retained === undefined || !isFresh(retained.entry)) {
      return;
    }

    await this.touch(didUri, retained.lastUsedAt);
    return retained.entry.value;
  }

  /** Return the last successful retained result, even when it is no longer fresh. */
  public async getRetained(didUri: string): Promise<DidResolutionResult | void> {
    const retained = await this.readRetainedEntry(didUri);
    if (retained === undefined) {
      return;
    }

    await this.touch(didUri, retained.lastUsedAt);
    return retained.entry.value;
  }

  /** Store a fresh result, preserving an existing pin. */
  public async set(didUri: string, value: DidResolutionResult): Promise<void> {
    const existing = await this.readEntry(didUri);
    const currentTime = Date.now();
    const entry: CachedDidResolutionResult = {
      ...existing?.pinned && { pinned: true },
      ttlMillis: currentTime + this.ttl,
      value,
    };

    await this.cache.batch([
      { type: 'put', key: didUri, value: JSON.stringify(entry) },
      { type: 'put', key: this.accessKey(didUri), value: currentTime.toString() },
    ]);
    await this.prune();
  }

  /** Protect a trusted result from automatic idle and capacity eviction. */
  public async pin(didUri: string, fallback: DidResolutionResult): Promise<void> {
    const existing = await this.readEntry(didUri);
    const currentTime = Date.now();
    const entry: CachedDidResolutionResult = existing === undefined
      ? { pinned: true, ttlMillis: currentTime + this.ttl, value: fallback }
      : { ...existing, pinned: true };

    await this.cache.batch([
      { type: 'put', key: didUri, value: JSON.stringify(entry) },
      { type: 'put', key: this.accessKey(didUri), value: currentTime.toString() },
    ]);
  }

  /** Delete a retained result regardless of whether it is pinned. */
  public async delete(didUri: string): Promise<void> {
    await this.cache.batch([
      { type: 'del', key: didUri },
      { type: 'del', key: this.accessKey(didUri) },
    ]);
  }

  /** Clear all retained results, including pinned entries. */
  public clear(): Promise<void> {
    return this.cache.clear();
  }

  /** Close the underlying LevelDB or IndexedDB store. */
  public close(): Promise<void> {
    return this.cache.close();
  }

  /** Read an entry and apply its idle-retention policy without changing its last-used time. */
  protected async readRetainedEntry(didUri: string): Promise<RetainedCacheEntry | undefined> {
    const entry = await this.readEntry(didUri);
    if (entry === undefined) {
      return;
    }

    const lastUsedAt = await this.readLastUsedAt(didUri);
    if (!entry.pinned && Date.now() - lastUsedAt >= this._maxIdle) {
      await this.delete(didUri);
      return;
    }

    return { entry, lastUsedAt };
  }

  /** Persist a coarse last-used update without rewriting the resolution result. */
  protected async touch(didUri: string, lastUsedAt: number): Promise<void> {
    const currentTime = Date.now();
    if (currentTime - lastUsedAt >= this._touchInterval) {
      await this.cache.put(this.accessKey(didUri), currentTime.toString());
    }
  }

  private accessKey(didUri: string): string {
    return `${ACCESS_KEY_PREFIX}${didUri}`;
  }

  private entrySize(didUri: string, serialized: string): number {
    return byteLength(didUri) + byteLength(serialized);
  }

  private async prune(): Promise<void> {
    const snapshot = await this.readCacheSnapshot();
    const currentTime = Date.now();
    const plan = this.createPrunePlan(snapshot, currentTime);

    this.evictToBudget(plan);
    await this.applyPrunePlan(plan, currentTime);
  }

  private async readCacheSnapshot(): Promise<CacheSnapshot> {
    const accessTimes = new Map<string, number>();
    const entries: { didUri: string; serialized: string }[] = [];

    for await (const [key, value] of this.cache.iterator()) {
      if (key.startsWith(ACCESS_KEY_PREFIX)) {
        const didUri = key.slice(ACCESS_KEY_PREFIX.length);
        const lastUsedAt = Number(value);
        accessTimes.set(didUri, lastUsedAt);
      } else {
        entries.push({ didUri: key, serialized: value });
      }
    }

    return { accessTimes, entries };
  }

  private createPrunePlan({ accessTimes, entries }: CacheSnapshot, currentTime: number): PrunePlan {
    const plan: PrunePlan = {
      candidates       : [],
      deleteKeys       : new Set<string>(),
      initializeAccess : new Set<string>(),
    };
    const entryDids = new Set(entries.map(({ didUri }) => didUri));

    for (const didUri of accessTimes.keys()) {
      if (!entryDids.has(didUri)) {
        plan.deleteKeys.add(this.accessKey(didUri));
      }
    }

    for (const { didUri, serialized } of entries) {
      const entry = this.parseEntry(serialized);
      if (entry === undefined) {
        this.markForDeletion(plan, didUri);
        continue;
      }

      const persistedLastUsedAt = this.validAccessTime(accessTimes.get(didUri));
      const lastUsedAt = persistedLastUsedAt ?? currentTime;
      if (!entry.pinned && currentTime - lastUsedAt >= this._maxIdle) {
        this.markForDeletion(plan, didUri);
        continue;
      }

      if (persistedLastUsedAt === undefined) {
        plan.initializeAccess.add(didUri);
      }

      if (!entry.pinned) {
        plan.candidates.push({ didUri, lastUsedAt, size: this.entrySize(didUri, serialized) });
      }
    }

    return plan;
  }

  private evictToBudget(plan: PrunePlan): void {
    let retainedBytes = plan.candidates.reduce((total, { size }): number => total + size, 0);
    if (retainedBytes <= this._maxBytes) {
      return;
    }

    plan.candidates.sort((left, right): number => left.lastUsedAt - right.lastUsedAt || left.didUri.localeCompare(right.didUri));
    for (const candidate of plan.candidates) {
      this.markForDeletion(plan, candidate.didUri);
      retainedBytes -= candidate.size;
      if (retainedBytes <= this._maxBytes) {
        return;
      }
    }
  }

  private async applyPrunePlan({ deleteKeys, initializeAccess }: PrunePlan, currentTime: number): Promise<void> {
    const operations = [
      ...[...deleteKeys].map((key) => ({ type: 'del' as const, key })),
      ...[...initializeAccess].map((didUri) => ({
        type  : 'put' as const,
        key   : this.accessKey(didUri),
        value : currentTime.toString(),
      })),
    ];
    if (operations.length > 0) {
      await this.cache.batch(operations);
    }
  }

  private markForDeletion(plan: PrunePlan, didUri: string): void {
    plan.deleteKeys.add(didUri);
    plan.deleteKeys.add(this.accessKey(didUri));
    plan.initializeAccess.delete(didUri);
  }

  private parseEntry(serialized: string): CachedDidResolutionResult | undefined {
    try {
      return JSON.parse(serialized);
    } catch {
      return;
    }
  }

  private validAccessTime(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  }

  private async readEntry(didUri: string): Promise<CachedDidResolutionResult | undefined> {
    try {
      return JSON.parse(await this.cache.get(didUri));
    } catch (error: any) {
      if (error.notFound) {
        return;
      }
      throw error;
    }
  }

  private async readLastUsedAt(didUri: string): Promise<number> {
    try {
      const lastUsedAt = Number(await this.cache.get(this.accessKey(didUri)));
      if (Number.isFinite(lastUsedAt)) {
        return lastUsedAt;
      }
    } catch (error: any) {
      if (!error.notFound) {
        throw error;
      }
    }

    const currentTime = Date.now();
    await this.cache.put(this.accessKey(didUri), currentTime.toString());
    return currentTime;
  }
}
