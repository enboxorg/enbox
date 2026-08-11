import type { FileEnvelopeData } from '@enbox/api';

import { vi } from 'vitest';
import { afterEach, describe, expect, it } from 'bun:test';

import { createFileEnvelopeUrlStore } from '../src/file-envelope-url-store.js';

type Request = Readonly<{ id: string }>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

type UrlHarness = {
  readonly created: Blob[];
  readonly revoked: string[];
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete): void => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createEnvelope(id: string, byteLength: number): FileEnvelopeData {
  return {
    blob     : new Blob(['x'.repeat(byteLength)]),
    filename : `${id}.bin`,
    mimeType : 'application/octet-stream',
  };
}

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

describe('FileEnvelopeUrlStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('deduplicates reads and returns a distinct lease to each caller', async () => {
    const urlApi = createUrlHarness();
    let readCount = 0;
    const store = createFileEnvelopeUrlStore<Request>({
      blobForUrl : (value): Blob => value.blob,
      key        : (request): string => request.id,
      read       : async (request): Promise<FileEnvelopeData> => {
        readCount += 1;
        await Promise.resolve();
        return createEnvelope(request.id, 4);
      },
    });

    const [first, second] = await Promise.all([
      store.acquire({ id: 'one' }),
      store.acquire({ id: 'one' }),
    ]);

    expect(readCount).toBe(1);
    expect(first?.url).toBe('blob:test-1');
    expect(second?.url).toBe(first?.url);
    const cached = store.acquireCached({ id: 'one' });
    expect(cached?.url).toBe(first?.url);
    expect(urlApi.created).toHaveLength(1);

    first?.release();
    second?.release();
    cached?.release();
    store.clear();
    expect(urlApi.revoked).toEqual(['blob:test-1']);
  });

  it('evicts by byte budget without revoking active leases', async () => {
    const urlApi = createUrlHarness();
    const store = createFileEnvelopeUrlStore<Request>({
      blobForUrl : (value): Blob => value.blob,
      key        : (request): string => request.id,
      maxBytes   : 3,
      maxEntries : 10,
      read       : async (request): Promise<FileEnvelopeData> => createEnvelope(request.id, 2),
    });

    const first = await store.acquire({ id: 'one' });
    const second = await store.acquire({ id: 'two' });

    expect(urlApi.revoked).toEqual([]);

    first?.release();
    expect(store.acquireCached({ id: 'one' })).toBeUndefined();
    store.acquireCached({ id: 'two' })?.release();
    expect(urlApi.revoked).toEqual(['blob:test-1']);
    expect(second?.url).toBe('blob:test-2');
    second?.release();
    store.dispose();
    expect(urlApi.revoked).toEqual(['blob:test-1', 'blob:test-2']);
  });

  it('evicts the least-recently-used idle entry by entry count', async () => {
    const urlApi = createUrlHarness();
    const store = createFileEnvelopeUrlStore<Request>({
      blobForUrl : (value): Blob => value.blob,
      key        : (request): string => request.id,
      maxEntries : 2,
      read       : async (request): Promise<FileEnvelopeData> => createEnvelope(request.id, 1),
    });

    (await store.acquire({ id: 'one' }))?.release();
    (await store.acquire({ id: 'two' }))?.release();
    store.acquireCached({ id: 'one' })?.release();
    const third = await store.acquire({ id: 'three' });

    expect(store.acquireCached({ id: 'two' })).toBeUndefined();
    expect(urlApi.revoked).toEqual(['blob:test-2']);
    third?.release();
    store.dispose();
  });

  it('invalidates the cached version while preserving its active URL', async () => {
    const urlApi = createUrlHarness();
    let version = 0;
    const store = createFileEnvelopeUrlStore<Request>({
      blobForUrl : (value): Blob => value.blob,
      key        : (request): string => request.id,
      read       : async (request): Promise<FileEnvelopeData> => createEnvelope(`${request.id}-${++version}`, 1),
    });

    const oldLease = await store.acquire({ id: 'one' });
    store.invalidate({ id: 'one' });

    expect(store.acquireCached({ id: 'one' })).toBeUndefined();
    expect(urlApi.revoked).toEqual([]);

    const newLease = await store.acquire({ id: 'one' });
    expect(newLease?.url).toBe('blob:test-2');
    expect(newLease?.filename).toBe('one-2.bin');

    oldLease?.release();
    expect(urlApi.revoked).toEqual(['blob:test-1']);

    newLease?.release();
    store.clear();
    expect(urlApi.revoked).toEqual(['blob:test-1', 'blob:test-2']);
  });

  it('clears the cache without revoking an active lease', async () => {
    const urlApi = createUrlHarness();
    const store = createFileEnvelopeUrlStore<Request>({
      blobForUrl : (value): Blob => value.blob,
      key        : (request): string => request.id,
      read       : async (request): Promise<FileEnvelopeData> => createEnvelope(request.id, 1),
    });

    const lease = await store.acquire({ id: 'one' });
    store.clear();
    expect(store.acquireCached({ id: 'one' })).toBeUndefined();
    expect(urlApi.revoked).toEqual([]);

    lease?.release();
    expect(urlApi.revoked).toEqual(['blob:test-1']);
  });

  it('aborts and fences a late read after clear', async () => {
    const urlApi = createUrlHarness();
    const deferred = createDeferred<FileEnvelopeData>();
    let readSignal: AbortSignal | undefined;
    const store = createFileEnvelopeUrlStore<Request>({
      blobForUrl : (value): Blob => value.blob,
      key        : (request): string => request.id,
      read       : (_request, signal): Promise<FileEnvelopeData> => {
        readSignal = signal;
        return deferred.promise;
      },
    });

    const acquiring = store.acquire({ id: 'one' });
    store.clear();
    deferred.resolve(createEnvelope('one', 1));

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    expect(readSignal?.aborted).toBe(true);
    expect(store.acquireCached({ id: 'one' })).toBeUndefined();
    expect(urlApi.created).toHaveLength(0);
  });

  it('aborts late reads and revokes active URLs on terminal disposal', async () => {
    const urlApi = createUrlHarness();
    const deferred = createDeferred<FileEnvelopeData>();
    let readSignal: AbortSignal | undefined;
    const store = createFileEnvelopeUrlStore<Request>({
      blobForUrl : (value): Blob => value.blob,
      key        : (request): string => request.id,
      read       : (request, signal): Promise<FileEnvelopeData> => {
        if (request.id === 'late') {
          readSignal = signal;
          return deferred.promise;
        }
        return Promise.resolve(createEnvelope(request.id, 1));
      },
    });

    const activeLease = await store.acquire({ id: 'active' });
    const acquiring = store.acquire({ id: 'late' });
    store.dispose();
    store.dispose();
    deferred.resolve(createEnvelope('late', 1));

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    expect(readSignal?.aborted).toBe(true);
    expect(urlApi.created).toHaveLength(1);
    expect(urlApi.revoked).toEqual(['blob:test-1']);

    activeLease?.release();
    expect(urlApi.revoked).toEqual(['blob:test-1']);
    await expect(store.acquire({ id: 'new' })).rejects.toThrow('FileEnvelopeUrlStore is disposed.');
  });
});
