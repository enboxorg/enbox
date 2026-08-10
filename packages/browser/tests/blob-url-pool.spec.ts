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
  afterEach(() => vi.restoreAllMocks());

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

  it('terminally disposes active URLs', () => {
    const urlApi = createUrlHarness();
    const pool = createBlobUrlPool();
    const lease = pool.acquire(new Blob(['hero']));

    pool.dispose();
    pool.dispose();
    lease.release();

    expect(urlApi.revoked).toEqual(['blob:test-1']);
    expect(() => pool.acquire(new Blob())).toThrow('BlobUrlPool is disposed.');
  });
});
