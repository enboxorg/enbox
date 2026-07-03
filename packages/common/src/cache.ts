type TtlCacheEntry<V> = {
  expiresAt: number;
  sequence: number;
  value: V;
};

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

const entryCompare = <K, V>([, left]: [K, TtlCacheEntry<V>], [, right]: [K, TtlCacheEntry<V>]): number => {
  if (left.expiresAt !== right.expiresAt) {
    return left.expiresAt - right.expiresAt;
  }

  return left.sequence - right.sequence;
};

/**
 * Small in-memory TTL cache tailored to the cache API used by Enbox.
 */
export class TtlCache<K, V> implements Iterable<[K, V]> {
  public checkAgeOnGet: boolean;
  public max: number;
  public noDisposeOnSet: boolean;
  public noUpdateTTL: boolean;
  public ttl?: number;
  public updateAgeOnGet: boolean;

  private readonly _data = new Map<K, TtlCacheEntry<V>>();
  private readonly _dispose?: TtlCache.Disposer<K, V>;
  private _sequence = 0;

  public constructor(options: TtlCache.Options<K, V> = {}) {
    const {
      checkAgeOnGet = false,
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

    this.checkAgeOnGet = checkAgeOnGet;
    this.max = max;
    this.noDisposeOnSet = noDisposeOnSet;
    this.noUpdateTTL = noUpdateTTL;
    this.ttl = ttl;
    this.updateAgeOnGet = updateAgeOnGet;
    this._dispose = dispose;
  }

  /**
   * Total live entries currently stored in the cache.
   */
  public get size(): number {
    this.purgeStale();
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

    if (current !== undefined && current.value !== value && !noDisposeOnSet) {
      this._dispose?.(current.value, key, 'set');
    }

    this._data.set(key, { expiresAt, sequence, value });
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
      assertTtl(ttl);
      entry.expiresAt = this._expirationFromTtl(ttl);
      entry.sequence = ++this._sequence;
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

    for (const [key, entry] of entries) {
      this._dispose?.(entry.value, key, 'delete');
    }
  }

  /**
   * Remove expired entries.
   */
  public purgeStale(): boolean {
    let purged = false;

    for (const [key, entry] of [...this._data.entries()]) {
      if (this._isExpired(entry)) {
        this._delete(key, 'stale');
        purged = true;
      }
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

    const remainingTtl = Math.ceil(entry.expiresAt - Date.now());

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
   * Provided for compatibility with the previous TTL cache package.
   */
  public cancelTimer(): void {
  }

  public [Symbol.iterator](): Iterator<[K, V]> {
    return this.entries();
  }

  private _expirationFromTtl(ttl: number): number {
    return ttl === Infinity ? Infinity : Date.now() + ttl;
  }

  private _isExpired(entry: TtlCacheEntry<V>): boolean {
    return entry.expiresAt !== Infinity && Date.now() >= entry.expiresAt;
  }

  private _purgeToCapacity(): void {
    this.purgeStale();

    while (this._data.size > this.max) {
      const [key] = this._sortedEntries()[0];
      this._delete(key, 'evict');
    }
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
    this._dispose?.(entry.value, key, reason);

    return true;
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
    checkAgeOnGet?: boolean;
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
    checkAgeOnGet?: boolean;
    ttl?: number;
    updateAgeOnGet?: boolean;
  };
}
