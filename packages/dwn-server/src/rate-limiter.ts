/**
 * Token-bucket rate limiter with per-key state tracking and automatic cleanup.
 *
 * Each key (IP address or tenant DID) has its own bucket that refills at a
 * fixed rate. When a request arrives, a token is consumed. If the bucket is
 * empty, the request is rejected with a retry-after hint.
 *
 * Stale buckets are periodically purged to prevent unbounded memory growth.
 *
 * @see https://github.com/enboxorg/enbox/issues/326
 */

export type RateLimiterConfig = {
  /** Tokens added per second (i.e. sustained request rate). */
  refillRate : number;
  /** Maximum burst size (bucket capacity). */
  maxTokens : number;
};

type Bucket = {
  tokens : number;
  lastRefill : number;
};

export class RateLimiter {
  #refillRate: number;
  #maxTokens: number;
  #buckets: Map<string, Bucket> = new Map();
  #cleanupInterval: ReturnType<typeof setInterval> | undefined;

  /** Stale buckets older than 5 minutes are purged. */
  private static readonly STALE_THRESHOLD_MS = 5 * 60 * 1000;
  /** Cleanup runs every 60 seconds. */
  private static readonly CLEANUP_INTERVAL_MS = 60 * 1000;

  public constructor(config: RateLimiterConfig) {
    this.#refillRate = config.refillRate;
    this.#maxTokens = config.maxTokens;

    // Start periodic cleanup.
    this.#cleanupInterval = setInterval((): void => {
      this.#cleanup();
    }, RateLimiter.CLEANUP_INTERVAL_MS);
  }

  /**
   * Attempts to consume a token for the given key.
   * @returns `{ allowed: true }` if the request is permitted, or
   *          `{ allowed: false, retryAfterMs }` if the rate limit is exceeded.
   */
  public consume(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    let bucket = this.#buckets.get(key);

    if (bucket === undefined) {
      bucket = { tokens: this.#maxTokens, lastRefill: now };
      this.#buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time.
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.#maxTokens, bucket.tokens + elapsed * this.#refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Calculate how long until one token is available.
    const deficit = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.#refillRate) * 1000);
    return { allowed: false, retryAfterMs };
  }

  /**
   * Returns the number of keys currently being tracked.
   */
  public get size(): number {
    return this.#buckets.size;
  }

  /**
   * Returns the current token count for a key, or `undefined` if not tracked.
   */
  public getTokens(key: string): number | undefined {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      return undefined;
    }

    // Refill to return current state.
    const elapsed = (Date.now() - bucket.lastRefill) / 1000;
    return Math.min(this.#maxTokens, bucket.tokens + elapsed * this.#refillRate);
  }

  /**
   * Reconfigures the rate limiter with new settings. Existing buckets are
   * retained but will use the new `refillRate` and `maxTokens` going forward.
   *
   * @see https://github.com/enboxorg/enbox/issues/389
   */
  public reconfigure(config: RateLimiterConfig): void {
    this.#refillRate = config.refillRate;
    this.#maxTokens = config.maxTokens;
  }

  /**
   * Returns the current configuration of this rate limiter.
   */
  public get config(): RateLimiterConfig {
    return {
      refillRate : this.#refillRate,
      maxTokens  : this.#maxTokens,
    };
  }

  /**
   * Stops the periodic cleanup timer. Call this when shutting down.
   */
  public destroy(): void {
    if (this.#cleanupInterval) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = undefined;
    }
    this.#buckets.clear();
  }

  /**
   * Removes buckets that have been at max capacity for longer than the stale threshold.
   */
  #cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.#buckets) {
      const elapsed = (now - bucket.lastRefill) / 1000;
      const currentTokens = Math.min(this.#maxTokens, bucket.tokens + elapsed * this.#refillRate);
      const timeSinceLastUse = now - bucket.lastRefill;
      if (currentTokens >= this.#maxTokens && timeSinceLastUse > RateLimiter.STALE_THRESHOLD_MS) {
        this.#buckets.delete(key);
      }
    }
  }
}
