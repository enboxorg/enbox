import { vi } from 'vitest';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBlobUrlPool } from '../src/blob-url-pool.js';

type UrlHarness = {
  readonly created: Blob[];
  readonly revoked: string[];
};

function createUrlHarness(): UrlHarness {
  const created: Blob[] = [];
  const revoked: string[] = [];

  vi.spyOn(globalThis.URL, 'createObjectURL').mockImplementation((blob): string => {
    created.push(blob);
    return `blob:test-${created.length}`;
  });
  vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation((url): void => {
    revoked.push(url);
  });
  return { created, revoked };
}

describe('BlobUrlPool', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shares one URL until the last lease is released', () => {
    const urlApi = createUrlHarness();
    const pool = createBlobUrlPool();
    const blob = new Blob(['avatar']);

    const first = pool.acquire(blob);
    const second = pool.acquire(blob);

    expect(first.url).toBe('blob:test-1');
    expect(second.url).toBe(first.url);
    expect(urlApi.created).toHaveLength(1);

    first.release();
    first.release();
    expect(urlApi.revoked).toEqual([]);

    second.release();
    expect(urlApi.revoked).toEqual(['blob:test-1']);
  });

  it('keeps a deferred URL alive when the Blob is reacquired', () => {
    vi.useFakeTimers();
    const urlApi = createUrlHarness();
    const pool = createBlobUrlPool();
    const blob = new Blob(['avatar']);

    const first = pool.acquire(blob);
    first.releaseAfter(60_000);
    vi.advanceTimersByTime(30_000);

    const second = pool.acquire(blob);
    expect(second.url).toBe(first.url);
    vi.advanceTimersByTime(30_000);
    expect(urlApi.revoked).toEqual([]);

    second.releaseAfter(60_000);
    vi.advanceTimersByTime(59_999);
    expect(urlApi.revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(urlApi.revoked).toEqual(['blob:test-1']);
  });

  it('releases immediately and cancels a scheduled release', () => {
    vi.useFakeTimers();
    const urlApi = createUrlHarness();
    const pool = createBlobUrlPool();
    const lease = pool.acquire(new Blob(['avatar']));

    expect(() => lease.releaseAfter(-1)).toThrow('delayMs must be an integer');
    expect(() => lease.releaseAfter(0.5)).toThrow('delayMs must be an integer');
    expect(() => lease.releaseAfter(2_147_483_648)).toThrow('delayMs must be an integer');
    lease.releaseAfter(60_000);
    lease.releaseAfter(1);
    expect(vi.getTimerCount()).toBe(1);

    lease.release();
    lease.releaseAfter(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(urlApi.revoked).toEqual(['blob:test-1']);
  });

  it('terminally disposes active URLs and deferred releases', () => {
    vi.useFakeTimers();
    const urlApi = createUrlHarness();
    const pool = createBlobUrlPool();
    const lease = pool.acquire(new Blob(['hero']));
    lease.releaseAfter(60_000);

    pool.dispose();
    pool.dispose();
    expect(vi.getTimerCount()).toBe(0);
    lease.releaseAfter(60_000);
    expect(vi.getTimerCount()).toBe(0);
    lease.release();
    vi.advanceTimersByTime(60_000);

    expect(urlApi.revoked).toEqual(['blob:test-1']);
    expect(() => pool.acquire(new Blob())).toThrow('BlobUrlPool is disposed.');
  });
});
