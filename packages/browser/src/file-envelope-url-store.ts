import type { FileEnvelopeData } from '@enbox/api';

import type { BlobUrlLease } from './blob-url-pool.js';

import { ObjectUrlReference } from './object-url-reference.js';

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 50;

type CacheEntry = {
  bytes: number;
  filename: string;
  key: string;
  mimeType: string;
  url: ObjectUrlReference;
};

type PendingRead = {
  controller: AbortController;
  generation: number;
  promise: Promise<CacheEntry | undefined>;
};

/** A cached file envelope represented by a leased browser object URL. */
export type FileEnvelopeUrlLease = BlobUrlLease & Readonly<{
  filename: string;
  mimeType: string;
}>;

export type FileEnvelopeUrlStoreOptions<Request> = Readonly<{
  /** Select the stable cache key for a read request. */
  key(request: Request): string;
  /** Read and decode the file. The signal aborts invalidated work. */
  read(request: Request, signal: AbortSignal): Promise<FileEnvelopeData | undefined>;
  /** Choose the Blob exposed by the URL, retaining MIME/render policy in the caller. */
  blobForUrl(value: FileEnvelopeData): Blob;
  /** Maximum cached entries (default 50). Soft while every eviction candidate is leased. */
  maxEntries?: number;
  /** Maximum cached Blob bytes (default 128 MiB). Soft while every eviction candidate is leased. */
  maxBytes?: number;
}>;

/** A keyed, bounded object URL cache for decoded file envelopes. */
export interface FileEnvelopeUrlStore<Request> {
  acquire(request: Request): Promise<FileEnvelopeUrlLease | undefined>;
  acquireCached(request: Request): FileEnvelopeUrlLease | undefined;
  clear(): void;
  dispose(): void;
  invalidate(request: Request): void;
}

function assertLimit(value: number, name: string): void {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative safe integer or Infinity.`);
  }
}

function throwAborted(controller: AbortController): never {
  controller.abort();
  throw controller.signal.reason;
}

class DefaultFileEnvelopeUrlStore<Request> implements FileEnvelopeUrlStore<Request> {
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _entries = new Set<CacheEntry>();
  private readonly _maxBytes: number;
  private readonly _maxEntries: number;
  private readonly _pending = new Map<string, PendingRead>();
  private _bytes = 0;
  private _generation = 0;
  private _isDisposed = false;

  public constructor(private readonly _options: FileEnvelopeUrlStoreOptions<Request>) {
    this._maxBytes = _options.maxBytes ?? DEFAULT_MAX_BYTES;
    this._maxEntries = _options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    assertLimit(this._maxBytes, 'maxBytes');
    assertLimit(this._maxEntries, 'maxEntries');
  }

  public async acquire(request: Request): Promise<FileEnvelopeUrlLease | undefined> {
    this._assertActive();
    const key = this._options.key(request);
    const cached = this._cache.get(key);
    if (cached !== undefined) {
      return this._acquire(cached);
    }

    const pending = this._pending.get(key) ?? this._startRead(request, key);
    const entry = await pending.promise;
    if (this._isDisposed || pending.generation !== this._generation) {
      return throwAborted(pending.controller);
    }
    if (entry === undefined) {
      return undefined;
    }
    if (this._cache.get(key) !== entry) {
      return throwAborted(pending.controller);
    }
    return this._acquire(entry);
  }

  public acquireCached(request: Request): FileEnvelopeUrlLease | undefined {
    this._assertActive();
    const entry = this._cache.get(this._options.key(request));
    return entry === undefined ? undefined : this._acquire(entry);
  }

  public invalidate(request: Request): void {
    this._assertActive();
    const key = this._options.key(request);
    const pending = this._pending.get(key);
    pending?.controller.abort();
    this._pending.delete(key);
    const entry = this._cache.get(key);
    if (entry !== undefined) {
      this._remove(entry);
    }
  }

  public clear(): void {
    this._assertActive();
    this._reset(false);
  }

  public dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;
    this._reset(true);
  }

  private _abortReads(): void {
    for (const pending of this._pending.values()) {
      pending.controller.abort();
    }
    this._pending.clear();
  }

  private _acquire(entry: CacheEntry): FileEnvelopeUrlLease {
    this._cache.delete(entry.key);
    this._cache.set(entry.key, entry);
    const lease = entry.url.acquire();
    this._evict();
    return Object.freeze({
      filename : entry.filename,
      mimeType : entry.mimeType,
      release  : lease.release,
      url      : lease.url,
    });
  }

  private _assertActive(): void {
    if (this._isDisposed) {
      throw new Error('FileEnvelopeUrlStore is disposed.');
    }
  }

  private _assertCurrent(key: string, controller: AbortController, generation: number): void {
    if (
      this._isDisposed
      || controller.signal.aborted
      || this._generation !== generation
      || this._pending.get(key)?.controller !== controller
    ) {
      throwAborted(controller);
    }
  }

  private _evict(): void {
    while (this._cache.size > this._maxEntries || this._bytes > this._maxBytes) {
      const entry = [...this._cache.values()].find((candidate): boolean => candidate.url.references === 0);
      if (entry === undefined) {
        return;
      }
      this._remove(entry);
    }
  }

  private async _load(request: Request, key: string, controller: AbortController, generation: number): Promise<CacheEntry | undefined> {
    const value = await this._options.read(request, controller.signal);
    this._assertCurrent(key, controller, generation);
    if (value === undefined) {
      return undefined;
    }

    const blob = this._options.blobForUrl(value);
    this._assertCurrent(key, controller, generation);
    const url = new ObjectUrlReference(blob, (): void => this._released(entry));
    const entry: CacheEntry = {
      bytes    : blob.size,
      filename : value.filename,
      key,
      mimeType : value.mimeType,
      url,
    };
    this._cache.set(key, entry);
    this._bytes += entry.bytes;
    this._entries.add(entry);
    return entry;
  }

  private _released(entry: CacheEntry): void {
    if (this._cache.get(entry.key) !== entry) {
      this._revoke(entry);
    } else {
      this._evict();
    }
  }

  private _remove(entry: CacheEntry): void {
    if (this._cache.get(entry.key) !== entry) {
      return;
    }
    this._cache.delete(entry.key);
    this._bytes -= entry.bytes;
    if (entry.url.references === 0) {
      this._revoke(entry);
    }
  }

  private _reset(revokeActive: boolean): void {
    this._generation += 1;
    this._abortReads();
    this._cache.clear();
    this._bytes = 0;
    for (const entry of [...this._entries]) {
      if (revokeActive || entry.url.references === 0) {
        this._revoke(entry);
      }
    }
  }

  private _revoke(entry: CacheEntry): void {
    entry.url.revoke();
    this._entries.delete(entry);
  }

  private _startRead(request: Request, key: string): PendingRead {
    const controller = new AbortController();
    const generation = this._generation;
    const promise = this._load(request, key, controller, generation).finally((): void => {
      if (this._pending.get(key)?.controller === controller) {
        this._pending.delete(key);
      }
    });
    const pending = { controller, generation, promise };
    this._pending.set(key, pending);
    return pending;
  }
}

/** Create a bounded file-envelope URL store with deduplicated reads. */
export function createFileEnvelopeUrlStore<Request>(
  options: FileEnvelopeUrlStoreOptions<Request>,
): FileEnvelopeUrlStore<Request> {
  return new DefaultFileEnvelopeUrlStore(options);
}
