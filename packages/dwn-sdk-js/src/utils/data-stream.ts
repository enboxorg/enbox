import { Encoder } from './encoder.js';

/**
 * Utility class for readable data stream using Web ReadableStream API.
 */
export class DataStream {
  /**
   * Reads the entire readable stream given into array of bytes.
   * @throws TypeError if `readableStream` is null or undefined.
   */
  public static async toBytes(readableStream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    if (readableStream == null) {
      throw new TypeError('DataStream.toBytes(): expected a ReadableStream but received ' + readableStream);
    }

    const reader = readableStream.getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    return DataStream.concatenateArrayOfBytes(chunks);
  }

  /**
   * Reads the entire readable stream and JSON parses it into an object.
   */
  public static async toObject(readableStream: ReadableStream<Uint8Array>): Promise<object> {
    const contentBytes = await DataStream.toBytes(readableStream);
    const contentObject = Encoder.bytesToObject(contentBytes);
    return contentObject;
  }

  /**
   * Concatenates the array of bytes given into one Uint8Array.
   */
  private static concatenateArrayOfBytes(arrayOfBytes: Uint8Array[]): Uint8Array {
    // sum of individual array lengths
    const totalLength = arrayOfBytes.reduce((accumulatedValue, currentValue) => accumulatedValue + currentValue.length, 0);

    const result = new Uint8Array(totalLength);

    let length = 0;
    for (const bytes of arrayOfBytes) {
      result.set(bytes, length);
      length += bytes.length;
    }

    return result;
  }

  /**
   * Creates a readable stream from the bytes given.
   */
  public static fromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    // chunk up the bytes to simulate a more real-world like behavior
    const chunkLength = 100_000;
    let offset = 0;
    return new ReadableStream({
      pull(controller): void {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkLength, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
    });
  }

  /**
   * Creates a readable stream from the object given.
   */
  public static fromObject(object: Record<string, any>): ReadableStream<Uint8Array> {
    const bytes = Encoder.objectToBytes(object);
    return DataStream.fromBytes(bytes);
  }

  /**
   * Adapts a Web ReadableStream into an AsyncIterable for compatibility with libraries
   * like `ipfs-unixfs-importer` that expect `AsyncIterable<Uint8Array>`.
   * @throws TypeError if `stream` is null or undefined.
   */
  public static async * asAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
    if (stream == null) {
      throw new TypeError('DataStream.asAsyncIterable(): expected a ReadableStream but received ' + stream);
    }

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Duplicates the given data stream into the number of streams specified so that multiple handlers can consume the same data stream.
   * Uses the native `ReadableStream.tee()` method for 2 copies, or a custom fan-out for N copies.
   */
  public static duplicateDataStream(dataStream: ReadableStream<Uint8Array>, count: number): ReadableStream<Uint8Array>[] {
    if (count < 1) {
      return [];
    }
    if (count === 1) {
      return [dataStream];
    }
    if (count === 2) {
      return dataStream.tee();
    }

    // For N > 2, recursively tee: tee the stream, keep one copy, and tee the other (count - 1) times
    const streams: ReadableStream<Uint8Array>[] = [];
    let remaining: ReadableStream<Uint8Array> = dataStream;
    for (let i = 0; i < count - 1; i++) {
      const [copy, rest] = remaining.tee();
      streams.push(copy);
      remaining = rest;
    }
    streams.push(remaining);

    return streams;
  }
}