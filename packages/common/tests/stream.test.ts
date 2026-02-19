import { describe, expect, it } from 'bun:test';

import { Stream } from '../src/stream.js';

describe('Stream', () => {

  describe('fromBlob()', () => {
    it('creates a ReadableStream from a Blob', async () => {
      const inputText = 'Hello, World!';
      const blob = new Blob([inputText], { type: 'text/plain' });
      const readableStream = Stream.fromBlob(blob);

      const result = await Stream.consumeToText({ readableStream });
      expect(result).toBe(inputText);
    });

    it('creates a ReadableStream from an empty Blob', async () => {
      const blob = new Blob([]);
      const readableStream = Stream.fromBlob(blob);

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result.length).toBe(0);
    });

    it('creates a ReadableStream from a Blob with binary data', async () => {
      const inputBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const blob = new Blob([inputBytes]);
      const readableStream = Stream.fromBlob(blob);

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result).toEqual(inputBytes);
    });
  });

  describe('fromBytes()', () => {
    it('creates a ReadableStream from a Uint8Array', async () => {
      const inputBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const readableStream = Stream.fromBytes(inputBytes);

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result).toEqual(inputBytes);
    });

    it('creates a ReadableStream from an empty Uint8Array', async () => {
      const inputBytes = new Uint8Array(0);
      const readableStream = Stream.fromBytes(inputBytes);

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result.length).toBe(0);
    });

    it('creates a ReadableStream from a large Uint8Array', async () => {
      const oneMegabyte = new Uint8Array(1024 * 1024).map((_, i) => i % 256);
      const readableStream = Stream.fromBytes(oneMegabyte);

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result).toEqual(oneMegabyte);
    }, 30_000);

    it('chunks the data according to the specified chunk length', async () => {
      const inputBytes = new Uint8Array(250).fill(42);
      const chunkLength = 100;
      const readableStream = Stream.fromBytes(inputBytes, chunkLength);

      const reader = readableStream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {break;}
        chunks.push(value);
      }

      // 250 bytes / 100 byte chunks = 3 chunks (100, 100, 50)
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBe(100);
      expect(chunks[1].length).toBe(100);
      expect(chunks[2].length).toBe(50);
    });

    it('uses the default chunk length of 100,000 bytes', async () => {
      const inputBytes = new Uint8Array(250_000).fill(7);
      const readableStream = Stream.fromBytes(inputBytes);

      const reader = readableStream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {break;}
        chunks.push(value);
      }

      // 250,000 bytes / 100,000 byte default chunks = 3 chunks (100K, 100K, 50K)
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBe(100_000);
      expect(chunks[1].length).toBe(100_000);
      expect(chunks[2].length).toBe(50_000);
    });
  });

  describe('consumeToArrayBuffer()', () => {
    it('consumes a ReadableStream and returns an ArrayBuffer', async () => {
      const inputBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(inputBytes);
          controller.close();
        }
      });

      const result = await Stream.consumeToArrayBuffer({ readableStream });
      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(result)).toEqual(inputBytes);
    });

    it('consumes a large ReadableStream and returns the expected bytes', async () => {
      const oneMegabyte = new Uint8Array(1024 * 1024).map((_, i) => i % 256);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(oneMegabyte);
          controller.close();
        }
      });

      const result = await Stream.consumeToArrayBuffer({ readableStream });
      expect(new Uint8Array(result)).toEqual(oneMegabyte);
    }, 30_000);

    it('handles an empty ReadableStream', async () => {
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.close();
        }
      });

      const result = await Stream.consumeToArrayBuffer({ readableStream });
      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBe(0);
    });

    it('throws an error for a stream that errors', async () => {
      const error = new Error('Stream error');
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.error(error);
        }
      });

      try {
        await Stream.consumeToArrayBuffer({ readableStream });
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBe(error);
      }
    });
  });

  describe('consumeToBlob()', () => {
    it('consumes a ReadableStream and returns a Blob', async () => {
      const inputBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(inputBytes);
          controller.close();
        }
      });

      const result = await Stream.consumeToBlob({ readableStream });
      expect(result).toBeInstanceOf(Blob);
      expect(result.size).toBe(inputBytes.length);

      // Read the blob to verify its content
      const arrayBuffer = await result.arrayBuffer();
      expect(new Uint8Array(arrayBuffer)).toEqual(inputBytes);
    });

    it('handles an empty ReadableStream', async () => {
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.close();
        }
      });

      const result = await Stream.consumeToBlob({ readableStream });
      expect(result).toBeInstanceOf(Blob);
      expect(result.size).toBe(0);
    });

    it('consumes a large ReadableStream and returns the expected blob size', async () => {
      const oneMegabyte = new Uint8Array(1024 * 1024).map((_, i) => i % 256);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(oneMegabyte);
          controller.close();
        }
      });

      const result = await Stream.consumeToBlob({ readableStream });
      expect(result.size).toBe(oneMegabyte.length);
    }, 30_000);

    it('consumes a ReadableStream containing a string and returns the correct Blob', async () => {
      const inputString = 'Hello, World!';
      const textEncoder = new TextEncoder();
      const inputBytes = textEncoder.encode(inputString);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(inputBytes);
          controller.close();
        }
      });

      const blob = await Stream.consumeToBlob({ readableStream });
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(inputBytes.length);

      // Read the blob and verify its content
      const blobText = await blob.text();
      expect(blobText).toBe(inputString);
    });

    it('throws an error for a stream that errors', async () => {
      const error = new Error('Stream error');
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.error(error);
        }
      });

      try {
        await Stream.consumeToBlob({ readableStream });
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBe(error);
      }
    });
  });

  describe('consumeToBytes()', () => {
    it('consumes a ReadableStream and returns a Uint8Array', async () => {
      const inputBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(inputBytes);
          controller.close();
        }
      });

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(inputBytes);
    });

    it('consumes a 5-byte ReadableStream and returns the expected bytes', async () => {
      const inputBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(inputBytes);
          controller.close();
        }
      });

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result).toEqual(inputBytes);
    });

    it('consumes a large ReadableStream and returns the expected bytes', async () => {
      // Create a 1MB byte stream that is filled with monotonically increasing values from 0 to 255, repeatedly.
      const oneMegabyte = new Uint8Array(1024 * 1024).map((_, i) => i % 256);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(oneMegabyte);
          controller.close();
        }
      });

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result).toEqual(oneMegabyte);
    }, 30_000);

    it('handles an empty ReadableStream', async () => {
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.close();
        }
      });

      const result = await Stream.consumeToBytes({ readableStream });
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it('throws an error for a stream that errors', async () => {
      const error = new Error('Stream error');
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.error(error);
        }
      });

      try {
        await Stream.consumeToBytes({ readableStream });
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBe(error);
      }
    });
  });

  describe('consumeToJson()', () => {
    it('consumes a ReadableStream containing JSON and returns a JavaScript object', async () => {
      const inputObject = { message: 'Hello, World!' };
      const inputString = JSON.stringify(inputObject);
      const textEncoder = new TextEncoder();
      const inputBytes = textEncoder.encode(inputString);
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(inputBytes);
          controller.close();
        }
      });

      const result = await Stream.consumeToJson({ readableStream });
      expect(result).toEqual(inputObject);
    });

    it('throws an error for a stream containing invalid JSON', async () => {
      const invalidJson = 'Invalid JSON';
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(invalidJson));
          controller.close();
        }
      });

      try {
        await Stream.consumeToJson({ readableStream });
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBeInstanceOf(SyntaxError);
      }
    });

    it('handles an empty ReadableStream', async () => {
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.close();
        }
      });

      try {
        await Stream.consumeToJson({ readableStream });
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBeInstanceOf(SyntaxError); // Empty string is not valid JSON
      }
    });

    it('throws an error for a stream that errors', async () => {
      const error = new Error('Stream error');
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.error(error);
        }
      });

      try {
        await Stream.consumeToJson({ readableStream });
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBe(error);
      }
    });
  });

  describe('consumeToText', () => {
    it('consumes a ReadableStream containing text and returns a string', async () => {
      const inputText = 'Hello, World!';
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(inputText));
          controller.close();
        }
      });

      const result = await Stream.consumeToText({ readableStream });
      expect(typeof result).toBe('string');
      expect(result).toBe(inputText);
    });

    it('handles an empty ReadableStream', async () => {
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.close();
        }
      });

      const result = await Stream.consumeToText({ readableStream });
      expect(typeof result).toBe('string');
      expect(result).toBe('');
    });

    it('consumes a large text stream and returns the expected text', async () => {
      const largeText = 'a'.repeat(1024 * 1024); // 1MB of 'a'
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(largeText));
          controller.close();
        }
      });

      const result = await Stream.consumeToText({ readableStream });
      expect(result).toBe(largeText);
    }, 30_000);

    it('throws an error for a stream that errors', async () => {
      const error = new Error('Stream error');
      const readableStream = new ReadableStream({
        start(controller): void {
          controller.error(error);
        }
      });

      try {
        await Stream.consumeToText({ readableStream });
        throw new Error('Should have thrown an error');
      } catch (err) {
        expect(err).toBe(error);
      }
    });
  });

  describe('generateByteStream()', function () {
    it('generates a stream with the specified length and fill value', async function () {
      const streamByteLength = 100;
      const fillValue = 43;
      const stream = Stream.generateByteStream({ streamLength: streamByteLength, fillValue });

      // Read data from the stream.
      const consumedBytes = await Stream.consumeToBytes({ readableStream: stream });

      // Check the length of the received bytes
      expect(consumedBytes.length).toBe(streamByteLength);

      // Check if all bytes are set to 43
      consumedBytes.forEach(byte => {
        expect(byte).toBe(fillValue);
      });
    });

    it('generates a stream with the specified chunk length', async function () {
      const streamByteLength = 100;
      const chunkLength = 10;
      const fillValue = 43;
      const stream = Stream.generateByteStream({ streamLength: streamByteLength, chunkLength, fillValue });

      // Collecting data from the stream.
      const reader = stream.getReader();
      let receivedBytes = new Uint8Array(0);
      let chunkCount = 0;
      let firstChunkLength: number | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {break;}
        receivedBytes = new Uint8Array([...receivedBytes, ...value]);
        firstChunkLength ??= value.length;
        chunkCount++;
      }

      // Check the length of the received bytes.
      expect(receivedBytes.length).toBe(streamByteLength);

      // Check the number of chunks received.
      expect(chunkCount).toBe(Math.ceil(streamByteLength / chunkLength));

      // Check if the first chunk is of the expected length.
      expect(firstChunkLength).toBe(chunkLength);
    });

    it('handles stream lengths that are evenly divisible by chunk length', async function () {
      const streamByteLength = 100;
      const chunkLength = 10;
      const stream = Stream.generateByteStream({ streamLength: streamByteLength, chunkLength });

      // Read data from the stream.
      const consumedBytes = await Stream.consumeToBytes({ readableStream: stream });

      // Confirm that the stream contents are as expected.
      expect(consumedBytes.length).toBe(streamByteLength);
    });

    it('handles stream lengths that are not evenly divisible by chunk length', async function () {
      const streamByteLength = 100;
      const chunkLength = 11;
      const stream = Stream.generateByteStream({ streamLength: streamByteLength, chunkLength });

      // Read data from the stream.
      const consumedBytes = await Stream.consumeToBytes({ readableStream: stream });

      // Confirm that the stream contents are as expected.
      expect(consumedBytes.length).toBe(streamByteLength);
    });

    it('generates a stream with chunks having random bytes within a specified range', async () => {
      const streamLength = 100;
      const chunkLength = 10;
      const fillValueRange: [number, number] = [50, 60]; // Range for random values

      const readableStream = Stream.generateByteStream({ streamLength, chunkLength, fillValue: fillValueRange });
      const reader = readableStream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {break;}

        expect(value).toBeInstanceOf(Uint8Array);
        expect(value.length).toBeLessThanOrEqual(chunkLength);

        // Check each byte in the chunk is within the specified range
        for (const byte of value) {
          expect(byte).toBeGreaterThanOrEqual(fillValueRange[0]);
          expect(byte).toBeLessThanOrEqual(fillValueRange[1]);
        }
      }
    });

    it('generates an indefinite stream when streamLength is not provided', async () => {
      const chunkLength = 1;
      const fillValue = 0;
      const maxIterations = 10_000; // Limit iterations to avoid an infinite loop in the test.

      const readableStream = Stream.generateByteStream({ chunkLength, fillValue });
      const reader = readableStream.getReader();

      let iterations = 0;
      let allChunksValid = true;
      while (iterations < maxIterations) {
        const { done, value } = await reader.read();
        if (done) {break;}

        allChunksValid = allChunksValid && value.length === chunkLength;
        iterations++;
      }

      expect(iterations).toBe(maxIterations);
      expect(allChunksValid).toBe(true);
    });
  });

  describe('isReadable()', () => {
    it('returns true for a new ReadableStream', () => {
      const stream = new ReadableStream();
      expect(Stream.isReadable({ readableStream: stream })).toBe(true);
    });

    it('returns true for an errored ReadableStream', () => {
      /**
       * Detecting an errored ReadableStream without actually reading from it is a bit tricky,
       * as the stream's error state isn't directly exposed through its interface. The standard
       * methods (getReader(), locked, etc.) do not provide information about the errored state
       * unless you attempt to read from the stream.
       *
       * Since we don't want to actually read from (i.e., partly consume) the stream, the
       * `isReadable()` method is incapable of detecting an errored stream.
       */
      const erroredStream = new ReadableStream({
        start(controller): void {
          controller.error(new Error('Stream intentionally errored'));
        }
      });
      expect(Stream.isReadable({ readableStream: erroredStream })).toBe(true);
    });

    it('returns false for a locked ReadableStream', () => {
      const stream = new ReadableStream();
      const reader = stream.getReader();
      expect(Stream.isReadable({ readableStream: stream })).toBe(false);
      reader.releaseLock();
    });

    it('returns false for a consumed ReadableStream', async () => {
      const stream = new ReadableStream({
        start(controller): void {
          controller.enqueue('data');
          controller.close();
        },
      });
      const reader = stream.getReader();
      await reader.read();
      await reader.closed;
      expect(Stream.isReadable({ readableStream: stream })).toBe(false);
    });

    it('returns false for a closed ReadableStream', async () => {
      const stream = new ReadableStream({
        start(controller): void {
          controller.close();
        }
      });
      stream.getReader();

      expect(Stream.isReadable({ readableStream: stream })).toBe(false);
    });

    it('returns false for non-stream objects', () => {
      // @ts-expect-error because we're testing non-stream input.
      expect(Stream.isReadable({ readableStream: {} })).toBe(false);
      // @ts-expect-error because we're testing non-stream input.
      expect(Stream.isReadable({ readableStream: null })).toBe(false);
      // @ts-expect-error because we're testing non-stream input.
      expect(Stream.isReadable({ readableStream: undefined })).toBe(false);
    });

    it('returns false for a ReadableStream where getReader() throws an error', () => {
      // Create a custom ReadableStream with an overridden getReader method that throws an error
      const erroredStream = new ReadableStream();
      erroredStream.getReader = (): ReadableStreamDefaultReader => { throw new Error('getReader intentionally throws an error'); };

      const result = Stream.isReadable({ readableStream: erroredStream });
      expect(result).toBe(false);
    });
  });

  describe('isReadableStream()', () => {
    it('returns true for a ReadableStream', () => {
      const readableStream = new ReadableStream();
      expect(Stream.isReadableStream(readableStream)).toBe(true);
    });

    it('returns false for a Node-like stream object', () => {
      const nodeLike = { pipe: (): void => {}, on: (): void => {}, _readableState: {} };
      expect(Stream.isReadableStream(nodeLike)).toBe(false);
    });


    it('returns false for null', () => {
      expect(Stream.isReadableStream(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(Stream.isReadableStream(undefined)).toBe(false);
    });

    it('returns false for a number', () => {
      expect(Stream.isReadableStream(123)).toBe(false);
    });

    it('returns false for a string', () => {
      expect(Stream.isReadableStream('string')).toBe(false);
    });

    it('returns false for a boolean', () => {
      expect(Stream.isReadableStream(true)).toBe(false);
    });

    it('returns false for an array', () => {
      expect(Stream.isReadableStream([])).toBe(false);
    });

    it('returns false for an object without getReader method', () => {
      expect(Stream.isReadableStream({})).toBe(false);
    });

    it('returns false for a function', () => {
      expect(Stream.isReadableStream(() => {})).toBe(false);
    });

    it('returns false for an object with a non-function getReader property', () => {
      const objWithNonFunctionGetReader = { getReader: 'not a function' };
      expect(Stream.isReadableStream(objWithNonFunctionGetReader)).toBe(false);
    });
  });

  describe('isStream', () => {
    it('returns true for a ReadableStream', () => {
      const readableStream = new ReadableStream();
      expect(Stream.isStream(readableStream)).toBe(true);
    });

    it('returns true for a WritableStream', () => {
      const writableStream = new WritableStream();
      expect(Stream.isStream(writableStream)).toBe(true);
    });

    it('returns true for a TransformStream', () => {
      const transformStream = new TransformStream();
      expect(Stream.isStream(transformStream)).toBe(true);
    });

    it('returns false for non-stream objects', () => {
      expect(Stream.isStream({})).toBe(false);
      expect(Stream.isStream(null)).toBe(false);
      expect(Stream.isStream(undefined)).toBe(false);
      expect(Stream.isStream(123)).toBe(false);
    });
  });

  describe('isTransformStream', () => {
    it('returns true for a TransformStream', () => {
      const transformStream = new TransformStream();
      expect(Stream.isTransformStream(transformStream)).toBe(true);
    });

    it('returns false for ReadableStream and WritableStream', () => {
      const readableStream = new ReadableStream();
      const writableStream = new WritableStream();
      expect(Stream.isTransformStream(readableStream)).toBe(false);
      expect(Stream.isTransformStream(writableStream)).toBe(false);
    });

    it('returns false for non-stream objects', () => {
      expect(Stream.isTransformStream({})).toBe(false);
      expect(Stream.isTransformStream(null)).toBe(false);
      expect(Stream.isTransformStream(undefined)).toBe(false);
      expect(Stream.isTransformStream(123)).toBe(false);
    });
  });

  describe('isWritableStream', () => {
    it('returns true for a WritableStream', () => {
      const writableStream = new WritableStream();
      expect(Stream.isWritableStream(writableStream)).toBe(true);
    });

    it('returns false for ReadableStream and TransformStream', () => {
      const readableStream = new ReadableStream();
      const transformStream = new TransformStream();
      expect(Stream.isWritableStream(readableStream)).toBe(false);
      expect(Stream.isWritableStream(transformStream)).toBe(false);
    });

    it('returns false for non-stream objects', () => {
      expect(Stream.isWritableStream({})).toBe(false);
      expect(Stream.isWritableStream(null)).toBe(false);
      expect(Stream.isWritableStream(undefined)).toBe(false);
      expect(Stream.isWritableStream(123)).toBe(false);
    });
  });

});
