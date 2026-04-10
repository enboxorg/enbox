import { describe, expect, it } from 'bun:test';

import { Stream } from '@enbox/common';

import { createRecordData } from '../src/record-data.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a ReadableStream from a string. */
function stringStream(text: string): ReadableStream {
  return new ReadableStream({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** Creates a ReadableStream from a JSON value. */
function jsonStream(value: unknown): ReadableStream {
  return stringStream(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRecordData()', () => {
  describe('stream()', () => {
    it('should return the stream from the provider function', async () => {
      const data = createRecordData(
        async () => stringStream('hello'),
        'text/plain',
      );

      const stream = await data.stream();
      const text = await Stream.consumeToText({ readableStream: stream });
      expect(text).toBe('hello');
    });
  });

  describe('text()', () => {
    it('should consume the stream as UTF-8 text', async () => {
      const data = createRecordData(
        async () => stringStream('hello text'),
        'text/plain',
      );

      const text = await data.text();
      expect(text).toBe('hello text');
    });
  });

  describe('json()', () => {
    it('should parse the stream as JSON', async () => {
      const obj = { name: 'Alice', age: 30 };
      const data = createRecordData(
        async () => jsonStream(obj),
        'application/json',
      );

      const parsed = await data.json();
      expect(parsed).toEqual(obj);
    });

    it('should support generic type parameter', async () => {
      type User = { name: string; age: number };
      const obj: User = { name: 'Bob', age: 25 };
      const data = createRecordData(
        async () => jsonStream(obj),
        'application/json',
      );

      const parsed = await data.json<User>();
      expect(parsed.name).toBe('Bob');
      expect(parsed.age).toBe(25);
    });
  });

  describe('blob()', () => {
    it('should return a Blob with the correct type', async () => {
      const data = createRecordData(
        async () => stringStream('blob content'),
        'text/plain',
      );

      const blob = await data.blob();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toContain('text/plain');
      expect(blob.size).toBeGreaterThan(0);

      const text = await blob.text();
      expect(text).toBe('blob content');
    });

    it('should use the provided dataFormat as the blob type', async () => {
      const data = createRecordData(
        async () => jsonStream({ key: 'value' }),
        'application/json',
      );

      const blob = await data.blob();
      expect(blob.type).toContain('application/json');
    });

    it('should handle undefined dataFormat gracefully', async () => {
      const data = createRecordData(
        async () => stringStream('no format'),
        undefined,
      );

      const blob = await data.blob();
      expect(blob).toBeInstanceOf(Blob);
      // Blob type defaults to '' when undefined is passed
      expect(blob.type).toBe('');
    });
  });

  describe('bytes()', () => {
    it('should return the stream content as a Uint8Array', async () => {
      const input = 'byte content';
      const expected = new TextEncoder().encode(input);
      const data = createRecordData(
        async () => stringStream(input),
        'text/plain',
      );

      const bytes = await data.bytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes).toEqual(expected);
    });

    it('should return cached bytes on the second call without re-fetching', async () => {
      let callCount = 0;
      const data = createRecordData(
        async () => { callCount++; return stringStream('cached'); },
        'text/plain',
      );

      const first = await data.bytes();
      const second = await data.bytes();
      expect(callCount).toBe(1);
      expect(first).toEqual(second);
    });

    it('should share a single in-flight fetch when called concurrently', async () => {
      let callCount = 0;
      const data = createRecordData(
        async () => { callCount++; return stringStream('shared'); },
        'text/plain',
      );

      const [a, b] = await Promise.all([data.bytes(), data.bytes()]);
      expect(callCount).toBe(1);
      expect(a).toEqual(b);
    });
  });

  describe('stream() from cache', () => {
    it('should reconstruct a stream from cached bytes after bytes() populates the cache', async () => {
      let callCount = 0;
      const data = createRecordData(
        async () => { callCount++; return stringStream('from cache'); },
        'text/plain',
      );

      // Populate the cache via bytes().
      await data.bytes();
      expect(callCount).toBe(1);

      // stream() should use the cache, not call streamFn again.
      const stream = await data.stream();
      const text = await Stream.consumeToText({ readableStream: stream });
      expect(text).toBe('from cache');
      expect(callCount).toBe(1);
    });
  });

  describe('then()', () => {
    it('should allow the data object to be awaited directly', async () => {
      const data = createRecordData(
        async () => stringStream('awaitable'),
        'text/plain',
      );

      // `then` makes the object thenable — can be used with .then()
      const stream = await data.then();
      expect(stream).toBeInstanceOf(ReadableStream);

      const text = await Stream.consumeToText({ readableStream: stream });
      expect(text).toBe('awaitable');
    });

    it('should pass the stream to the onFulfilled callback', async () => {
      const data = createRecordData(
        async () => stringStream('callback'),
        'text/plain',
      );

      const result = await data.then((stream) => stream);
      expect(result).toBeInstanceOf(ReadableStream);
    });
  });

  describe('catch()', () => {
    it('should catch errors from the stream provider', async () => {
      const data = createRecordData(
        async () => { throw new Error('stream failure'); },
        'text/plain',
      );

      let caught: Error | undefined;
      await data.catch((err) => {
        caught = err;
        return Promise.reject(err);
      }).catch((err) => {
        caught = err;
      });

      expect(caught).toBeDefined();
      expect(caught!.message).toBe('stream failure');
    });

    it('should propagate errors through text()', async () => {
      const data = createRecordData(
        async () => { throw new Error('text error'); },
        'text/plain',
      );

      await expect(data.text()).rejects.toThrow('text error');
    });

    it('should propagate errors through json()', async () => {
      const data = createRecordData(
        async () => { throw new Error('json error'); },
        'application/json',
      );

      await expect(data.json()).rejects.toThrow('json error');
    });

    it('should propagate errors through blob()', async () => {
      const data = createRecordData(
        async () => { throw new Error('blob error'); },
        'text/plain',
      );

      await expect(data.blob()).rejects.toThrow('blob error');
    });

    it('should propagate errors through bytes()', async () => {
      const data = createRecordData(
        async () => { throw new Error('bytes error'); },
        'text/plain',
      );

      await expect(data.bytes()).rejects.toThrow('bytes error');
    });
  });
});
