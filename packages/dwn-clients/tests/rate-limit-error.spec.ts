import { describe, expect, it } from 'bun:test';

import { RateLimitError } from '../src/rate-limit-error.js';

describe('RateLimitError', () => {
  it('should set retryAfterSec and default message', () => {
    const error = new RateLimitError(30);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.name).toBe('RateLimitError');
    expect(error.retryAfterSec).toBe(30);
    expect(error.message).toBe('Rate limit exceeded, retry after 30s');
  });

  it('should use a custom message when provided', () => {
    const error = new RateLimitError(60, 'Too many requests');

    expect(error.retryAfterSec).toBe(60);
    expect(error.message).toBe('Too many requests');
  });

  it('should be catchable as an Error', () => {
    try {
      throw new RateLimitError(10);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      expect((e as RateLimitError).retryAfterSec).toBe(10);
    }
  });

  it('should normalize unsafe retry delays', () => {
    expect(new RateLimitError(Infinity).retryAfterSec).toBe(1);
    expect(new RateLimitError(Number.NaN).retryAfterSec).toBe(1);
    expect(new RateLimitError(-1).retryAfterSec).toBe(1);
    expect(new RateLimitError(1.1).retryAfterSec).toBe(2);
    expect(new RateLimitError(Number.MAX_SAFE_INTEGER).retryAfterSec).toBe(2_147_483);
  });
});
