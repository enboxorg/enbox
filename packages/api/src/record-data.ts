/**
 * Data-access helpers for the {@link Record} class.
 *
 * `RecordData` is the object returned by `Record.data`. It wraps a lazily
 * evaluated `stream()` function with convenience accessors that mirror the
 * Fetch `Response` API (`blob()`, `bytes()`, `json()`, `text()`).
 *
 * Convenience consumption is cached after the first read so subsequent calls
 * on the same accessor do not re-fetch. Concurrent convenience calls are safe
 * and share one fetch. Direct `stream()` access remains unbuffered unless a
 * convenience call has already populated the cache.
 *
 * Extracted from `record.ts` so the convenience-method boilerplate lives in
 * its own module while the stream-resolution logic (which is tightly coupled
 * to `Record` internals) stays inside the `Record` class.
 *
 * @module
 */

import { Stream } from '@enbox/common';

/**
 * Maximum data size (in bytes) that will be cached in-memory after the first
 * read. Payloads larger than this threshold are not cached and will be
 * re-fetched on every access.
 */
const DATA_CACHE_LIMIT = 10 * 1024 * 1024; // 10 MB

/**
 * A thenable data accessor returned by {@link Record.data}.
 *
 * Provides convenience methods for consuming the record's data in various
 * formats, plus `then`/`catch` so the object can be awaited directly to
 * obtain the underlying `ReadableStream`.
 *
 * Convenience calls on the same accessor are cached after the first read so
 * sequences such as `data.json()` followed by `data.text()` do not trigger
 * redundant network requests. Direct `stream()` calls remain unbuffered.
 *
 * @beta
 */
export type RecordData = {
  /** Consume the data as a `Blob`. */
  blob: () => Promise<Blob>;
  /** Consume the data as raw bytes. */
  bytes: () => Promise<Uint8Array>;
  /** Parse the data as JSON. */
  json: () => Promise<unknown>;
  /** Consume the data as a UTF-8 string. */
  text: () => Promise<string>;
  /** Obtain the underlying Web `ReadableStream`. */
  stream: () => Promise<ReadableStream>;
  /** Proxy for `stream().then(...)` so the object is directly awaitable. */
  then: (
    onFulfilled?: (value: ReadableStream) => ReadableStream | PromiseLike<ReadableStream>,
    onRejected?: (reason: any) => PromiseLike<never>,
  ) => Promise<ReadableStream>;
  /** Proxy for `stream().catch(...)`. */
  catch: (onRejected?: (reason: any) => PromiseLike<never>) => Promise<ReadableStream>;
};

/**
 * Create a {@link RecordData} wrapper around a `stream` provider function.
 *
 * The first convenience call (`blob`, `bytes`, `json`, or `text`) consumes the
 * underlying stream and caches the raw bytes (up to {@link DATA_CACHE_LIMIT}).
 * Subsequent calls on that accessor reconstruct a fresh stream from the cache.
 * A direct `stream()` call preserves streaming and does not eagerly buffer.
 *
 * Concurrent calls are safe: if multiple accessors are called simultaneously,
 * only one stream fetch is performed and all callers share the result.
 *
 * @param streamFn   - A function that returns a `Promise<ReadableStream>` for the record data.
 * @param dataFormat - The MIME type used when constructing Blobs.
 * @returns A {@link RecordData} object with convenience accessors.
 * @beta
 */
export function createRecordData(
  streamFn: () => Promise<ReadableStream>,
  dataFormat: string | undefined,
): RecordData {
  // In-memory byte cache. Populated after the first successful read.
  let cachedBytes: Uint8Array | undefined;
  // In-flight read promise. Ensures concurrent callers share a single fetch.
  let inflight: Promise<Uint8Array> | undefined;

  /**
   * Returns the record data as raw bytes, using the cache when available.
   * If a read is already in-flight, waits for it instead of starting a new one.
   */
  async function getBytes(): Promise<Uint8Array> {
    // Fast path: cache hit.
    if (cachedBytes) {
      return cachedBytes;
    }

    // If another call is already fetching, wait for it.
    if (inflight) {
      return inflight;
    }

    // Start a new fetch and share the promise.
    inflight = (async (): Promise<Uint8Array> => {
      const readableStream = await streamFn();
      const bytes = await Stream.consumeToBytes({ readableStream });

      // Cache only if within the size limit.
      if (bytes.byteLength <= DATA_CACHE_LIMIT) {
        cachedBytes = bytes;
      }

      return bytes;
    })();

    try {
      return await inflight;
    } finally {
      inflight = undefined;
    }
  }

  const stream = async (): Promise<ReadableStream> => {
    // If we have cached bytes, reconstruct a fresh stream from them.
    if (cachedBytes) {
      return new ReadableStream({
        start(controller): void {
          controller.enqueue(cachedBytes);
          controller.close();
        },
      });
    }
    // Otherwise delegate to the original stream provider.
    return streamFn();
  };

  const dataObj: RecordData = {

    /**
     * Returns the data of the current record as a `Blob`.
     *
     * @returns A promise that resolves to a Blob containing the record's data.
     * @throws If the record data is not available or cannot be converted to a `Blob`.
     *
     * @beta
     */
    async blob(): Promise<Blob> {
      return new Blob([await getBytes() as BlobPart], { type: dataFormat });
    },

    /**
     * Returns the data of the current record as a `Uint8Array`.
     *
     * @returns A Promise that resolves to a `Uint8Array` containing the record's data bytes.
     * @throws If the record data is not available or cannot be converted to a byte array.
     *
     * @beta
     */
    async bytes(): Promise<Uint8Array> {
      return await getBytes();
    },

    /**
     * Parses the data of the current record as JSON and returns it as a JavaScript object.
     *
     * @returns A Promise that resolves to a JavaScript object parsed from the record's JSON data.
     * @throws If the record data is not available, not in JSON format, or cannot be parsed.
     *
     * @beta
     */
    async json(): Promise<unknown> {
      const bytes = await getBytes();
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    },

    /**
     * Returns the data of the current record as a `string`.
     *
     * @returns A promise that resolves to a `string` containing the record's text data.
     * @throws If the record data is not available or cannot be converted to text.
     *
     * @beta
     */
    async text(): Promise<string> {
      const bytes = await getBytes();
      return new TextDecoder().decode(bytes);
    },

    /**
     * Provides a Web `ReadableStream` containing the record's data.
     *
     * Uses the standard Web Streams API for cross-platform compatibility across
     * browsers, Node.js, Bun, and Deno.
     *
     * If the data has already been read and cached, returns a fresh stream
     * reconstructed from the cache.
     *
     * @returns A promise that resolves to a Web `ReadableStream` of the record's data.
     * @throws If the record data is not available in-memory and cannot be fetched.
     *
     * @beta
     */
    stream,

    /**
     * Attaches callbacks for the resolution and/or rejection of the `Promise` returned by
     * `stream()`.
     *
     * This method is a proxy to the `then` method of the `Promise` returned by `stream()`,
     * allowing for a seamless integration with promise-based workflows.
     * @param onFulfilled - A function to asynchronously execute when the `stream()` promise
     *                      becomes fulfilled.
     * @param onRejected - A function to asynchronously execute when the `stream()` promise
     *                     becomes rejected.
     * @returns A `Promise` for the completion of which ever callback is executed.
     */
    then(
      onFulfilled?: (value: ReadableStream) => ReadableStream | PromiseLike<ReadableStream>,
      onRejected?: (reason: any) => PromiseLike<never>,
    ): Promise<ReadableStream> {
      return stream().then(onFulfilled, onRejected);
    },

    /**
     * Attaches a rejection handler callback to the `Promise` returned by the `stream()` method.
     * This method is a shorthand for `.then(undefined, onRejected)`, specifically designed for handling
     * rejection cases in the promise chain initiated by accessing the record's data. It ensures that
     * errors during data retrieval or processing can be caught and handled appropriately.
     *
     * @param onRejected - A function to asynchronously execute when the `stream()` promise
     *                     becomes rejected.
     * @returns A `Promise` that resolves to the value of the callback if it is called, or to its
     *          original fulfillment value if the promise is instead fulfilled.
     */
    catch(onRejected?: (reason: any) => PromiseLike<never>): Promise<ReadableStream> {
      return stream().catch(onRejected);
    }
  };

  return dataObj;
}
