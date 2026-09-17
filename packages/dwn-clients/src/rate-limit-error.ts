import { MAX_TIMER_DELAY_MS } from '@enbox/common';

const DEFAULT_RETRY_AFTER_SEC = 1;
const MAX_RETRY_AFTER_SEC = Math.floor(MAX_TIMER_DELAY_MS / 1000);

/**
 * Thrown when a DWN server rejects a request due to rate limiting (HTTP 429).
 *
 * Consumers can catch this error to implement retry logic using the
 * {@link retryAfterSec} value provided by the server.
 */
export class RateLimitError extends Error {
  /** Safe whole seconds the client should wait before retrying. */
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number, message?: string) {
    const normalizedRetryAfterSec = Number.isFinite(retryAfterSec) && retryAfterSec >= 0
      ? Math.min(Math.ceil(retryAfterSec), MAX_RETRY_AFTER_SEC)
      : DEFAULT_RETRY_AFTER_SEC;
    super(message ?? `Rate limit exceeded, retry after ${normalizedRetryAfterSec}s`);
    this.name = 'RateLimitError';
    this.retryAfterSec = normalizedRetryAfterSec;
  }
}
