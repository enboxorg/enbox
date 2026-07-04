type TtlCacheEntry<V> = {
  expiresAt: number;
  sequence: number;
  value: V;
};

type TtlCachePurgeState = {
  purgedStale: boolean;
};

type TtlCacheTimer = ReturnType<typeof setTimeout>;

const MAX_TIMER_DELAY = 2_147_483_647;

function now(): number {
  return performance.now();
}

function isPositiveIntegerOrInfinity(value: number): boolean {
  return value === Infinity || (Number.isInteger(value) && value > 0 && Number.isFinite(value));
}

function assertPositiveIntegerOrInfinity(value: number, name: string): void {
  if (!isPositiveIntegerOrInfinity(value)) {
    throw new TypeError(`${name} must be positive integer or Infinity`);
  }
}

function assertTtl(ttl: number | undefined): asserts ttl is number {
  if (ttl === undefined || !isPositiveIntegerOrInfinity(ttl)) {
    throw new TypeError('ttl must be positive integer or Infinity');
  }
}

function unrefTimer(timer: TtlCacheTimer): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const unrefableTimer = timer as TtlCacheTimer & { unref?: () => void };
    unrefableTimer.unref?.();
  }
}

const entryCompare = <K, V>([, left]: [K, TtlCacheEntry<V>], [, right]: [K, TtlCacheEntry<V>]): number => {
  if (left.expiresAt !== right.expiresAt) {
    return left.expiresAt - right.expiresAt;
  }

  return left.sequence - right.sequence;
};

/**
 * Small in-memory TTL cache tailored to the cache API used by Enbox.
 *
 * Expired entries are purged by an unref'd background timer and are also checked on access. `cancelTimer()` only stops
 * the background timer; `get()` and `has()` still remove stale entries.
 */
export class TtlCache<K, V> implements Iterable<[K, V]> {
  public max: number;
  public noDisposeOnSet: boolean;
  public noUpdateTTL: boolean;
  public ttl?: number;
  public updateAgeOnGet: boolean;

  private readonly _data = new Map<K, TtlCacheEntry<V>>();
  private readonly _dispose?: TtlCache.Disposer<K, V>;
  private _sequence = 0;
  private _timer?: TtlCacheTimer;
  private _timerExpiresAt = Infinity;

  public constructor(options: TtlCache.Options<K, V> = {}) {
    const {
      dispose,
      max = Infinity,
      noDisposeOnSet = false,
      noUpdateTTL = false,
      ttl,
      updateAgeOnGet = false,
    } = options;

    if (ttl !== undefined) {
      assertPositiveIntegerOrInfinity(ttl, 'ttl');
    }

    assertPositiveIntegerOrInfinity(max, 'max');

    if (dispose !== undefined && typeof dispose !== 'function') {
      throw new TypeError('dispose must be function if set');
    }

    this.max = max;
    this.noDisposeOnSet = noDisposeOnSet;
    this.noUpdateTTL = noUpdateTTL;
    this.ttl = ttl;
    this.updateAgeOnGet = updateAgeOnGet;
    this._dispose = dispose;
  }

  /**
   * Total entries currently held in the cache.
   */
  public get size(): number {
    return this._data.size;
  }

  /**
   * Store a value and assign the configured TTL.
   */
  public set(key: K, value: V, options: TtlCache.SetOptions = {}): this {
    const ttl = options.ttl ?? this.ttl;
    assertTtl(ttl);

    const existing = this._data.get(key);
    const noUpdateTTL = options.noUpdateTTL ?? this.noUpdateTTL;
    const noDisposeOnSet = options.noDisposeOnSet ?? this.noDisposeOnSet;

    if (existing !== undefined && this._isExpired(existing)) {
      this._delete(key, 'stale');
    }

    const current = this._data.get(key);
    const expiresAt = current !== undefined && noUpdateTTL ? current.expiresAt : this._expirationFromTtl(ttl);
    const sequence = current !== undefined && noUpdateTTL ? current.sequence : ++this._sequence;
    const shouldDispose = current !== undefined && current.value !== value && !noDisposeOnSet;

    this._data.set(key, { expiresAt, sequence, value });
    this._scheduleTimer(expiresAt);

    if (shouldDispose) {
      this._dispose?.(current.value, key, 'set');
    }

    this._purgeToCapacity();

    return this;
  }

  /**
   * Retrieve a cached value, optionally extending the entry age.
   */
  public get<T = V>(key: K, options: TtlCache.GetOptions = {}): T | undefined {
    const entry = this._data.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (this._isExpired(entry)) {
      this._delete(key, 'stale');
      return undefined;
    }

    const updateAgeOnGet = options.updateAgeOnGet ?? this.updateAgeOnGet;

    if (updateAgeOnGet) {
      const ttl = options.ttl ?? this.ttl;

      if (ttl !== undefined) {
        assertTtl(ttl);
        entry.expiresAt = this._expirationFromTtl(ttl);
        entry.sequence = ++this._sequence;
        this._scheduleTimer(entry.expiresAt);
      }
    }

    return entry.value as unknown as T;
  }

  /**
   * Check whether a live value exists for the given key.
   */
  public has(key: K): boolean {
    const entry = this._data.get(key);

    if (entry === undefined) {
      return false;
    }

    if (this._isExpired(entry)) {
      this._delete(key, 'stale');
      return false;
    }

    return true;
  }

  /**
   * Delete a cache entry.
   */
  public delete(key: K): boolean {
    return this._delete(key, 'delete');
  }

  /**
   * Clear all cache entries.
   */
  public clear(): void {
    const entries = [...this._data.entries()];
    this._data.clear();
    this.cancelTimer();

    for (const [key, entry] of entries) {
      this._dispose?.(entry.value, key, 'delete');
    }
  }

  /**
   * Remove expired entries.
   */
  public purgeStale(): boolean {
    const hadTimer = this._timer !== undefined;
    const purged = this._purgeStale();

    if (purged && hadTimer) {
      this.cancelTimer();
      this._scheduleNextTimer();
    }

    return purged;
  }

  /**
   * Return the remaining TTL for a live entry.
   */
  public getRemainingTTL(key: K): number {
    const entry = this._data.get(key);

    if (entry === undefined) {
      return 0;
    }

    if (entry.expiresAt === Infinity) {
      return Infinity;
    }

    const remainingTtl = Math.ceil(entry.expiresAt - now());

    if (remainingTtl <= 0) {
      this._delete(key, 'stale');
      return 0;
    }

    return remainingTtl;
  }

  /**
   * Set a new TTL for an existing entry.
   */
  public setTTL(key: K, ttl: number | undefined = this.ttl): void {
    assertTtl(ttl);

    const entry = this._data.get(key);

    if (entry === undefined) {
      return;
    }

    if (this._isExpired(entry)) {
      this._delete(key, 'stale');
      return;
    }

    entry.expiresAt = this._expirationFromTtl(ttl);
    entry.sequence = ++this._sequence;
    this._scheduleTimer(entry.expiresAt);
  }

  /**
   * Iterate over live entries from soonest to latest expiration.
   */
  public *entries(): Generator<[K, V]> {
    this.purgeStale();

    for (const [key, entry] of this._sortedEntries()) {
      yield [key, entry.value];
    }
  }

  /**
   * Iterate over live keys from soonest to latest expiration.
   */
  public *keys(): Generator<K> {
    for (const [key] of this.entries()) {
      yield key;
    }
  }

  /**
   * Iterate over live values from soonest to latest expiration.
   */
  public *values(): Generator<V> {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  /**
   * Cancel the background purge timer. Lazy expiry checks still run on access.
   */
  public cancelTimer(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
      this._timerExpiresAt = Infinity;
    }
  }

  public [Symbol.iterator](): Iterator<[K, V]> {
    return this.entries();
  }

  private _expirationFromTtl(ttl: number): number {
    return ttl === Infinity ? Infinity : now() + ttl;
  }

  private _isExpired(entry: TtlCacheEntry<V>): boolean {
    return entry.expiresAt !== Infinity && now() >= entry.expiresAt;
  }

  private _purgeToCapacity(): void {
    if (this.max === Infinity || this._data.size <= this.max) {
      return;
    }

    const hadTimer = this._timer !== undefined;
    const purgeState = { purgedStale: false };

    try {
      while (this._data.size > this.max) {
        const evictKey = this._purgeStaleAndSelectEviction(purgeState);

        if (this._data.size <= this.max || evictKey === undefined) {
          return;
        }

        this._delete(evictKey, 'evict');
      }
    } finally {
      if (purgeState.purgedStale && hadTimer) {
        this.cancelTimer();
        this._scheduleNextTimer();
      }
    }
  }

  private _purgeStaleAndSelectEviction(purgeState: TtlCachePurgeState): K | undefined {
    let evictKey: K | undefined;
    let evictEntry: TtlCacheEntry<V> | undefined;

    for (const [key, entry] of this._data.entries()) {
      if (this._isExpired(entry)) {
        purgeState.purgedStale = true;
        this._delete(key, 'stale');
        continue;
      }

      if (this._isEarlierEntry(entry, evictEntry)) {
        evictKey = key;
        evictEntry = entry;
      }
    }

    return evictKey;
  }

  private _isEarlierEntry(entry: TtlCacheEntry<V>, selectedEntry: TtlCacheEntry<V> | undefined): boolean {
    if (selectedEntry === undefined) {
      return true;
    }

    if (entry.expiresAt !== selectedEntry.expiresAt) {
      return entry.expiresAt < selectedEntry.expiresAt;
    }

    return entry.sequence < selectedEntry.sequence;
  }

  private _purgeStale(): boolean {
    let purged = false;

    for (const [key, entry] of this._data.entries()) {
      if (this._isExpired(entry)) {
        this._delete(key, 'stale');
        purged = true;
      }
    }

    return purged;
  }

  private _sortedEntries(): [K, TtlCacheEntry<V>][] {
    return [...this._data.entries()].sort(entryCompare);
  }

  private _delete(key: K, reason: TtlCache.DisposeReason): boolean {
    const entry = this._data.get(key);

    if (entry === undefined) {
      return false;
    }

    this._data.delete(key);

    if (this._data.size === 0) {
      this.cancelTimer();
    }

    this._dispose?.(entry.value, key, reason);

    return true;
  }

  private _scheduleTimer(expiresAt: number): void {
    if (expiresAt === Infinity || expiresAt >= this._timerExpiresAt) {
      return;
    }

    this.cancelTimer();

    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, Math.ceil(expiresAt - now())));
    const timer = setTimeout((): void => {
      this._timer = undefined;
      this._timerExpiresAt = Infinity;

      try {
        this._purgeStale();
      } finally {
        this._scheduleNextTimer();
      }
    }, delay);

    unrefTimer(timer);

    this._timer = timer;
    this._timerExpiresAt = expiresAt;
  }

  private _scheduleNextTimer(): void {
    let nextExpiration = Infinity;

    for (const entry of this._data.values()) {
      if (entry.expiresAt < nextExpiration) {
        nextExpiration = entry.expiresAt;
      }
    }

    this._scheduleTimer(nextExpiration);
  }
}

export namespace TtlCache {
  export type DisposeReason = 'evict' | 'set' | 'delete' | 'stale';

  export type Disposer<K, V> = (value: V, key: K, reason: DisposeReason) => void;

  export type TTLOptions = {
    noUpdateTTL?: boolean;
    ttl?: number;
  };

  export type Options<K, V> = TTLOptions & {
    dispose?: Disposer<K, V>;
    max?: number;
    noDisposeOnSet?: boolean;
    updateAgeOnGet?: boolean;
  };

  export type SetOptions = {
    noDisposeOnSet?: boolean;
    noUpdateTTL?: boolean;
    ttl?: number;
  };

  export type GetOptions = {
    ttl?: number;
    updateAgeOnGet?: boolean;
  };
}
