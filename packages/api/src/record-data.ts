/**
 * Data-access helpers for the {@link Record} class.
 *
 * `RecordData` is the object returned by `Record.data`. It wraps a lazily
 * evaluated `stream()` function with convenience accessors that mirror the
 * Fetch `Response` API (`blob()`, `bytes()`, `json()`, `text()`).
 *
 * Extracted from `record.ts` so the convenience-method boilerplate lives in
 * its own module while the stream-resolution logic (which is tightly coupled
 * to `Record` internals) stays inside the `Record` class.
 *
 * @module
 */

import { Stream } from '@enbox/common';

/**
 * A thenable data accessor returned by {@link Record.data}.
 *
 * Provides convenience methods for consuming the record's data in various
 * formats, plus `then`/`catch` so the object can be awaited directly to
 * obtain the underlying `ReadableStream`.
 *
 * @beta
 */
export type RecordData = {
  /** Consume the data as a `Blob`. */
  blob: () => Promise<Blob>;
  /** Consume the data as raw bytes. */
  bytes: () => Promise<Uint8Array>;
  /** Parse the data as JSON. */
  json: <T = unknown>() => Promise<T>;
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
 * @param streamFn   - A function that returns a `Promise<ReadableStream>` for the record data.
 * @param dataFormat - The MIME type used when constructing Blobs.
 * @returns A {@link RecordData} object with convenience accessors.
 *
 * @beta
 */
export function createRecordData(streamFn: () => Promise<ReadableStream>, dataFormat: string | undefined): RecordData {
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
      return new Blob([await Stream.consumeToBytes({ readableStream: await this.stream() })], { type: dataFormat });
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
      return await Stream.consumeToBytes({ readableStream: await this.stream() });
    },

    /**
     * Parses the data of the current record as JSON and returns it as a JavaScript object.
     *
     * @returns A Promise that resolves to a JavaScript object parsed from the record's JSON data.
     * @throws If the record data is not available, not in JSON format, or cannot be parsed.
     *
     * @beta
     */
    async json<T = unknown>(): Promise<T> {
      return await Stream.consumeToJson({ readableStream: await this.stream() }) as T;
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
      return await Stream.consumeToText({ readableStream: await this.stream() });
    },

    /**
     * Provides a Web `ReadableStream` containing the record's data.
     *
     * Uses the standard Web Streams API for cross-platform compatibility across
     * browsers, Node.js, Bun, and Deno.
     *
     * @returns A promise that resolves to a Web `ReadableStream` of the record's data.
     * @throws If the record data is not available in-memory and cannot be fetched.
     *
     * @beta
     */
    stream: streamFn,

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
      return this.stream().then(onFulfilled, onRejected);
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
      return this.stream().catch(onRejected);
    }
  };

  return dataObj;
}
