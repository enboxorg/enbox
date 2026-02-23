/**
 * Thrown when a DWN server rejects a request due to rate limiting (HTTP 429).
 *
 * Consumers can catch this error to implement retry logic using the
 * {@link retryAfterSec} value provided by the server.
 */
export class RateLimitError extends Error {
  /** Seconds the client should wait before retrying, as reported by the server. */
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number, message?: string) {
    super(message ?? `Rate limit exceeded, retry after ${retryAfterSec}s`);
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}
