import type { Cache } from '../types/cache.js';

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

/**
 * A cache using local memory.
 */
export class MemoryCache implements Cache {
  private static readonly maxEntries = 100_000;

  private readonly cache = new Map<string, CacheEntry>();

  /**
   * @param timeToLiveInSeconds time-to-live for every key-value pair set in the cache
   */
  public constructor(private readonly timeToLiveInSeconds: number) {
  }

  public async set<T = unknown>(key: string, value: T): Promise<void> {
    try {
      const entry = {
        expiresAt : Date.now() + this.timeToLiveInSeconds * 1000,
        value     : value,
      };

      this.cache.delete(key);
      this.cache.set(key, entry);
      this.evictOldestEntries();
    } catch {
      // let the code continue as this is a non-fatal error
    }
  }

  public async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value as T;
  }

  private evictOldestEntries(): void {
    while (this.cache.size > MemoryCache.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.cache.delete(oldestKey);
    }
  }
}
