import { beforeEach, describe, expect, it } from 'bun:test';

import { Convert } from '../src/convert.js';

const textEncoder = new TextEncoder();

describe('Convert', () =>{
  describe('from: ArrayBuffer', () => {
    it('to: Base58Btc', () => {
      // Test Vector 1.
      const input = (new Uint8Array([51, 52, 53])).buffer;
      const output = 'JCXv';

      const result = Convert.arrayBuffer(input).toBase58Btc();

      expect(result).toBe(output);
    });

    it('to: Base64Url', () => {
      // Test Vector 1.
      const input = (new Uint8Array([51, 52, 53])).buffer;
      const output = 'MzQ1';

      const result = Convert.arrayBuffer(input).toBase64Url();

      expect(result).toBe(output);
    });

    it('to: Hex', () => {
      // Test Vector 1.
      const input = (new Uint8Array([0xab, 0xba, 0xfa, 0xab])).buffer;
      const output = 'abbafaab';
      const result = Convert.arrayBuffer(input).toHex();
      expect(result).toBe(output);
    });

    it('to: String', () => {
      // Test Vector 1.
      const input = (new Uint8Array([102, 111, 111])).buffer;
      const output = 'foo';

      const result = Convert.arrayBuffer(input).toString();

      expect(result).toBe(output);
    });

    it('to: Uint8Array', () => {
      // Test Vector 1.
      const input = (new Uint8Array([102, 111, 111])).buffer;
      const output = new Uint8Array([102, 111, 111]);

      const result = Convert.arrayBuffer(input).toUint8Array();

      expect(result).toEqual(output);
    });
  });

  describe('from: AsyncIterable', () => {
    let asyncIterableBytes: AsyncIterable<Uint8Array>;
    let asyncIterableJson: AsyncIterable<any>;
    let asyncIterableString: AsyncIterable<Uint8Array>;

    // Create a generator function that yields two Uint8Array chunks.
    async function* generateBytesData(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6]);
    }

    // Create a generator function that yields parts of a JSON string.
    async function* generateJsonData(): AsyncGenerator<string> {
      yield '{"foo":';
      yield '"bar"';
      yield '}';
    }

    // Create a generator function that yields Uint8Array chunks of encoded string data.
    async function* generateStringData(): AsyncGenerator<Uint8Array> {
      yield textEncoder.encode('Hello, ');
      yield textEncoder.encode('world!');
    }

    beforeEach(() => {
      asyncIterableBytes = generateBytesData();
      asyncIterableJson = generateJsonData();
      asyncIterableString = generateStringData();
    });

    it('to: ArrayBuffer', async () => {
      const output = await Convert.asyncIterable(asyncIterableBytes).toArrayBufferAsync();

      // The expected ArrayBuffer is a concatenation of the yielded Uint8Arrays
      const expected = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;

      // Compare the result with the expected ArrayBuffer
      expect(new Uint8Array(output)).toEqual(new Uint8Array(expected));
    });

    it('to: Blob', async () => {
      const output = await Convert.asyncIterable(asyncIterableBytes).toBlobAsync();

      // Check if the returned object is a Blob
      expect(output).toBeInstanceOf(Blob);

      // Convert Blob to ArrayBuffer to verify contents
      const arrayBuffer = await output.arrayBuffer();
      const result = new Uint8Array(arrayBuffer);

      // The expected result is a concatenation of the yielded Uint8Arrays
      const expected = new Uint8Array([1, 2, 3, 4, 5, 6]);

      // Compare the result with the expected Uint8Array
      expect(result).toEqual(expected);
    });

    it('to: Object', async () => {
      const output = await Convert.asyncIterable(asyncIterableJson).toObjectAsync();

      // The expected result is the object formed by the concatenated JSON string
      const expected = { foo: 'bar' };

      // Compare the result with the expected object
      expect(output).toEqual(expected);
    });

    it('to: String', async () => {
      const output = await Convert.asyncIterable(asyncIterableString).toStringAsync();

      // The expected result is the concatenated string
      const expected = 'Hello, world!';

      // Compare the result with the expected string
      expect(output).toBe(expected);
    });

    it('to: Uint8Array', async () => {
      const output = await Convert.asyncIterable(asyncIterableBytes).toUint8ArrayAsync();

      // The expected result is a Uint8Array that concatenates all chunks
      const expected = new Uint8Array([1, 2, 3, 4, 5, 6]);

      // Compare the result with the expected Uint8Array
      expect(output).toEqual(expected);
    });

    it('throws an error if input is not AsyncIterable', async () => {
      try {
        // @ts-expect-error because incorrect input data type is intentionally being used to trigger error.
        Convert.asyncIterable('unsupported');
        throw new Error('Should have thrown an error for incorrect type');
      } catch (error: any) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('must be of type AsyncIterable');
      }
    });
  });

  describe('from: Base58Btc', () => {
    it('to: ArrayBuffer', () => {
      // Test Vector 1.
      const input = 'JCXv';
      const output = (new Uint8Array([51, 52, 53])).buffer;

      const result = Convert.base58Btc(input).toArrayBuffer();

      expect(result).toEqual(output);
    });

    it('to: Multibase', () => {
      // Test Vector 1.
      const input = '6MkugFXawZ8fvt5Q9gXkrtSZdTRg9W9M1hBpEh8HpF7wjSZ';
      const output = 'z6MkugFXawZ8fvt5Q9gXkrtSZdTRg9W9M1hBpEh8HpF7wjSZ';

      const result = Convert.base58Btc(input).toMultibase();

      expect(result).toBe(output);
    });

    it('to: Uint8Array', () => {
      // Test Vector 1.
      const input = 'JCXv';
      const output = new Uint8Array([51, 52, 53]);

      const result = Convert.base58Btc(input).toUint8Array();

      expect(result).toEqual(output);
    });
  });

  describe('from: Base64Url', () => {
    it('to: ArrayBuffer', () => {
      // Test Vector 1.
      const input = 'MzQ1';
      const output = (new Uint8Array([51, 52, 53])).buffer;

      const result = Convert.base64Url(input).toArrayBuffer();

      expect(result).toEqual(output);
    });

    it('to: Hex', () => {
      // Test Vector 1.
      const input = 'eyJmb28iOiJiYXIifQ';
      const output = '7b22666f6f223a22626172227d';
      const result = Convert.base64Url(input).toHex();
      expect(result).toBe(output);
    });

    it('to: Object', () => {
      // Test Vector 1.
      const input = 'eyJmb28iOiJiYXIifQ';
      const output = { foo: 'bar' };

      const result = Convert.base64Url(input).toObject();

      expect(result).toEqual(output);
    });

    it('to: String', () => {
      // Test Vector 1.
      const input = 'Zm9v';
      const output = 'foo';

      const result = Convert.base64Url(input).toString();

      expect(result).toBe(output);
    });

    it('to: Uint8Array', () => {
      // Test Vector 1.
      const input = 'MzQ1';
      const output = new Uint8Array([51, 52, 53]);

      const result = Convert.base64Url(input).toUint8Array();

      expect(result).toEqual(output);
    });
  });

  describe('from: Base64Z', () => {
    it('to: Uint8Array', () => {
      // Test Vector 1.
      const input = '5umembtazeybqcd7grysfp711g1z56wzo8irzhae494hh58zguhy';
      const output = new Uint8Array([
        220, 214, 133, 134, 56, 186, 0, 23,
        48, 125, 49, 1, 98, 183, 178, 145,
        165, 125, 250, 151, 129, 234, 75, 243,
        8, 215, 245, 206, 108, 247, 52, 248
      ]);

      const result = Convert.base32Z(input).toUint8Array();

      expect(result).toEqual(output);
    });
  });

  describe('from: BufferSource', () => {
    it('to: ArrayBuffer', () => {
      // Test Vector 1 - BufferSource is Uint8Array.
      const inputT1 = new Uint8Array([101, 111, 111]);
      const outputT1 = (new Uint8Array([101, 111, 111])).buffer;
      const resultT1 = Convert.bufferSource(inputT1).toArrayBuffer();
      expect(resultT1).toEqual(outputT1);

      // Test Vector 2 - BufferSource is ArrayBuffer.
      const inputT2 = (new Uint8Array([102, 111, 111])).buffer;
      const outputT2 = (new Uint8Array([102, 111, 111])).buffer;
      const resultT2 = Convert.bufferSource(inputT2).toArrayBuffer();
      expect(resultT2).toEqual(outputT2);

      // Test Vector 3 - BufferSource is DataView.
      const inputT3 = new DataView((new Uint8Array([103, 111, 111])).buffer);
      const outputT3 = (new Uint8Array([103, 111, 111])).buffer;
      const resultT3 = Convert.bufferSource(inputT3).toArrayBuffer();
      expect(resultT3).toEqual(outputT3);

      // Test Vector 4 - BufferSource is an unsigned, 16-bit Typed Array.
      const inputT4 = new Uint16Array([299]);
      const outputT4 = (new Uint8Array([43, 1])).buffer;
      const resultT4 = Convert.bufferSource(inputT4).toArrayBuffer();
      expect(resultT4).toEqual(outputT4);

      // Test Vector 5 - BufferSource is a signed, 32-bit Typed Array.
      const inputT5 = new Int32Array([1111]);
      const outputT5 = (new Uint8Array([87, 4, 0, 0])).buffer;
      const resultT5 = Convert.bufferSource(inputT5).toArrayBuffer();
      expect(resultT5).toEqual(outputT5);

      // Test Vector 6 - BufferSource is a slice of a Typed Array.
      const inputT6 = (new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])).slice(1, 6);
      const outputT6 = (new Uint8Array([1, 2, 3, 4, 5])).buffer;
      const resultT6 = Convert.bufferSource(inputT6).toArrayBuffer();
      expect(resultT6).toEqual(outputT6);

      // Test Vector 7 - BufferSource is a slice of a DataView.
      const dataView = new DataView((new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])).buffer);
      const inputT7 = new DataView(dataView.buffer, dataView.byteOffset + 1, 6 - 1);
      const outputT7 = (new Uint8Array([1, 2, 3, 4, 5])).buffer;
      const resultT7 = Convert.bufferSource(inputT7).toArrayBuffer();
      expect(resultT7).toEqual(outputT7);

      // Test Vector 8 - BufferSource is Uint8Array.
      const inputT8 = 'not BufferSource type';
      // @ts-expect-error because incorrect input data type is intentionally being used to trigger error.
      expect (() => Convert.bufferSource(inputT8).toArrayBuffer()).toThrow('value is not of type');
    });

    it('to: Base64Url', () => {
      // Test Vector 1 - BufferSource is Uint8Array.
      const inputT1 = new Uint8Array([102, 111, 111]);
      const outputT1 = 'Zm9v';
      const resultT1 = Convert.bufferSource(inputT1).toBase64Url();
      expect(resultT1).toBe(outputT1);

      // Test Vector 2 - BufferSource is ArrayBuffer.
      const inputT2 = (new Uint8Array([50, 51, 52, 53])).buffer;
      const outputT2 = 'MjM0NQ';
      const resultT2 = Convert.bufferSource(inputT2).toBase64Url();
      expect(resultT2).toBe(outputT2);

      // Test Vector 3 - BufferSource is DataView.
      const inputT3 = new DataView((new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 0])).buffer);
      const outputT3 = 'AQIDBAUGBwgJAA';
      const resultT3 = Convert.bufferSource(inputT3).toBase64Url();
      expect(resultT3).toBe(outputT3);

      // Test Vector 4 - BufferSource is an unsigned, 16-bit Typed Array.
      const inputT4 = new Uint16Array([299, 298, 297]);
      const outputT4 = 'KwEqASkB';
      const resultT4 = Convert.bufferSource(inputT4).toBase64Url();
      expect(resultT4).toBe(outputT4);

      // Test Vector 5 - BufferSource is a signed, 32-bit Typed Array.
      const inputT5 = new Int32Array([1111, 1000, 2000]);
      const outputT5 = 'VwQAAOgDAADQBwAA';
      const resultT5 = Convert.bufferSource(inputT5).toBase64Url();
      expect(resultT5).toBe(outputT5);

      // Test Vector 6 - BufferSource is Uint8Array.
      const inputT6 = 'not BufferSource type';
      // @ts-expect-error because incorrect input data type is intentionally being used to trigger error.
      expect (() => Convert.bufferSource(inputT6).toBase64Url()).toThrow('value is not of type');
    });

    it('to: Uint8Array', () => {
      // Test Vector 1 - BufferSource is Uint8Array.
      const inputT1 = new Uint8Array([102, 111, 111]);
      const outputT1 = new Uint8Array([102, 111, 111]);
      const resultT1 = Convert.bufferSource(inputT1).toUint8Array();
      expect(resultT1).toEqual(outputT1);

      // Test Vector 2 - BufferSource is ArrayBuffer.
      const inputT2 = (new Uint8Array([102, 111, 111])).buffer;
      const outputT2 = new Uint8Array([102, 111, 111]);
      const resultT2 = Convert.bufferSource(inputT2).toUint8Array();
      expect(resultT2).toEqual(outputT2);

      // Test Vector 3 - BufferSource is DataView.
      const inputT3 = new DataView((new Uint8Array([102, 111, 111])).buffer);
      const outputT3 = new Uint8Array([102, 111, 111]);
      const resultT3 = Convert.bufferSource(inputT3).toUint8Array();
      expect(resultT3).toEqual(outputT3);

      // Test Vector 4 - BufferSource is an unsigned, 16-bit Typed Array.
      const inputT4 = new Uint16Array([299]);
      const outputT4 = new Uint8Array([43, 1]);
      const resultT4 = Convert.bufferSource(inputT4).toUint8Array();
      expect(resultT4).toEqual(outputT4);

      // Test Vector 5 - BufferSource is a signed, 32-bit Typed Array.
      const inputT5 = new Int32Array([1111]);
      const outputT5 = new Uint8Array([87, 4, 0, 0]);
      const resultT5 = Convert.bufferSource(inputT5).toUint8Array();
      expect(resultT5).toEqual(outputT5);

      // Test Vector 6 - BufferSource is Uint8Array.
      const inputT6 = 'not BufferSource type';
      // @ts-expect-error because incorrect input data type is intentionally being used to trigger error.
      expect (() => Convert.bufferSource(inputT6).toUint8Array()).toThrow('value is not of type');
    });
  });

  describe('from: Hex', () => {
    it('throws an error if the input is not a string', () => {
      // Test Vector 1.
      const input = 0xaf;

      // @ts-expect-error because error is being intentionally trigger by passing non-string input.
      expect(() => Convert.hex(input)).toThrow('must be a string');
    });

    it('throws an error if the input string is an odd number of characters', () => {
      // Test Vector 1.
      const input = 'faaba';

      expect(() => Convert.hex(input)).toThrow('must have an even number of characters');
    });

    it('to: ArrayBuffer', () => {
      // Test Vector 1.
      let input = 'abbafaab';
      const output = (new Uint8Array([0xab, 0xba, 0xfa, 0xab])).buffer;
      const result = Convert.hex(input).toArrayBuffer();
      expect(result).toEqual(output);

      // Test Vector 2.
      input = 'foobar';
      expect(() => Convert.hex(input).toArrayBuffer()).toThrow('Input is not a valid hexadecimal string');
    });

    it('to: Uint8Array', () => {
      // Test Vector 1.
      let input = 'abbafaab';
      const output = new Uint8Array([0xab, 0xba, 0xfa, 0xab]);
      const result = Convert.hex(input).toUint8Array();
      expect(result).toEqual(output);

      // Test Vector 2.
      input = 'foobar';
      expect(() => Convert.hex(input).toUint8Array()).toThrow('Input is not a valid hexadecimal string');
    });
  });

  describe('from: Multibase', () => {
    it('to: Base58Btc', () => {
      // Test Vector 1.
      const input = 'z6MkugFXawZ8fvt5Q9gXkrtSZdTRg9W9M1hBpEh8HpF7wjSZ';
      const output = '6MkugFXawZ8fvt5Q9gXkrtSZdTRg9W9M1hBpEh8HpF7wjSZ';

      const result = Convert.multibase(input).toBase58Btc();

      expect(result).toBe(output);
    });
  });

  describe('from: Object', () => {
    it('to: Base64Url', () => {
      // Test Vector 1.
      const input = { foo: 'bar' };
      const output = 'eyJmb28iOiJiYXIifQ';

      const result = Convert.object(input).toBase64Url();

      expect(result).toBe(output);
    });

    it('to: String', () => {
      // Test Vector 1.
      const input = { foo: 'bar' };
      const output = '{"foo":"bar"}';

      const result = Convert.object(input).toString();

      expect(result).toBe(output);
    });

    it('to: Uint8Array', () => {
      // Test Vector 1.
      const input = { foo: 'bar' };
      const output = new Uint8Array([123, 34, 102, 111, 111, 34, 58, 34, 98, 97, 114, 34, 125]);

      const result = Convert.object(input).toUint8Array();

      expect(result).toEqual(output);
    });
  });

  describe('from: String', () => {
    it('to: ArrayBuffer', () => {
      // Test Vector 1.
      const input = 'foo';
      const output = (new Uint8Array([102, 111, 111])).buffer;

      const result = Convert.string(input).toArrayBuffer();

      expect(result).toEqual(output);
    });

    it('to: Base64Url', () => {
      // Test Vector 1.
      const input = 'foo';
      const output = 'Zm9v';

      const result = Convert.string(input).toBase64Url();

      expect(result).toBe(output);
    });

    it('to: Object', () => {
      // Test Vector 1.
      const input = '{"foo":"bar"}';
      const output = { foo: 'bar' };

      const result = Convert.string(input).toObject();

      expect(result).toEqual(output);
    });

    it('to: Uint8Array', () => {
      // Test Vector 1.
      const input = 'foo';
      const output = new Uint8Array([102, 111, 111]);

      const result = Convert.string(input).toUint8Array();

      expect(result).toEqual(output);
    });
  });

  describe('from: Uint8Array', () => {
    it('to: ArrayBuffer', () => {
      // Test Vector 1.
      const input = new Uint8Array([102, 111, 111]);
      const output = (new Uint8Array([102, 111, 111])).buffer;

      const result = Convert.uint8Array(input).toArrayBuffer();

      expect(result).toEqual(output);
    });

    it('to: Base32Z', () => {
      // Test Vector 1.
      const input = new Uint8Array([
        220, 214, 133, 134, 56, 186, 0, 23,
        48, 125, 49, 1, 98, 183, 178, 145,
        165, 125, 250, 151, 129, 234, 75, 243,
        8, 215, 245, 206, 108, 247, 52, 248
      ]);
      const output = '5umembtazeybqcd7grysfp711g1z56wzo8irzhae494hh58zguhy';

      const result = Convert.uint8Array(input).toBase32Z();

      expect(result).toBe(output);
    });

    it('to: Base58Btc', () => {
      // Test Vector 1.
      const input = new Uint8Array([51, 52, 53]);
      const output = 'JCXv';

      const result = Convert.uint8Array(input).toBase58Btc();

      expect(result).toBe(output);
    });

    it('to: Base64Url', () => {
      // Test Vector 1.
      const input = new Uint8Array([51, 52, 53]);
      const output = 'MzQ1';

      const result = Convert.uint8Array(input).toBase64Url();

      expect(result).toBe(output);
    });

    it('to: Hex', () => {
      // Test Vector 1.
      const input = new Uint8Array([0xab, 0xba, 0xfa, 0xab]);
      const output = 'abbafaab';
      const result = Convert.uint8Array(input).toHex();
      expect(result).toBe(output);
    });

    it('to: Object', () => {
      // Test Vector 1.
      const input = new Uint8Array([123, 34, 102, 111, 111, 34, 58, 34, 98, 97, 114, 34, 125]);
      const output = { foo: 'bar' };

      const result = Convert.uint8Array(input).toObject();

      expect(result).toEqual(output);
    });

    it('to: String', () => {
      // Test Vector 1.
      const input = new Uint8Array([102, 111, 111]);
      const output = 'foo';

      const result = Convert.uint8Array(input).toString();

      expect(result).toBe(output);
    });
  });

  describe('Unsupported conversions', () => {

    const unsupported = new Convert(null, 'Unobtanium');

    it('toArrayBuffer() throw an error', () => {
      expect(() => unsupported.toArrayBuffer()).toThrow('not supported');
    });

    it('toArrayBufferAsync() throw an error', async () => {
      try {
        await unsupported.toArrayBufferAsync();
        throw new Error('Should have thrown an error for incorrect type');
      } catch (error: any) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('not supported');
      }
    });

    it('toBase32Z() throw an error', () => {
      expect(() => unsupported.toBase32Z()).toThrow('not supported');
    });

    it('toBase58Btc() throw an error', () => {
      expect(() => unsupported.toBase58Btc()).toThrow('not supported');
    });

    it('toBase64Url() throw an error', () => {
      expect(() => unsupported.toBase64Url()).toThrow('not supported');
    });

    it('toBlobAsync() throw an error', async () => {
      try {
        await unsupported.toBlobAsync();
        throw new Error('Should have thrown an error for incorrect type');
      } catch (error: any) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('not supported');
      }
    });

    it('toHex() throw an error', () => {
      expect(() => unsupported.toHex()).toThrow('not supported');
    });

    it('toMultibase() throw an error', () => {
      expect(() => unsupported.toMultibase()).toThrow('not supported');
    });

    it('toObject() throw an error', () => {
      expect(() => unsupported.toObject()).toThrow('not supported');
    });

    it('toObjectAsync() throw an error', async () => {
      try {
        await unsupported.toObjectAsync();
        throw new Error('Should have thrown an error for incorrect type');
      } catch (error: any) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('not supported');
      }
    });

    it('toString() throw an error', () => {
      expect(() => unsupported.toString()).toThrow('not supported');
    });

    it('toStringAsync() throw an error', async () => {
      try {
        await unsupported.toStringAsync();
        throw new Error('Should have thrown an error for incorrect type');
      } catch (error: any) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('not supported');
      }
    });

    it('toUint8Array() throw an error', () => {
      expect(() => unsupported.toUint8Array()).toThrow('not supported');
    });

    it('toUint8ArrayAsync() throw an error', async () => {
      try {
        await unsupported.toUint8ArrayAsync();
        throw new Error('Should have thrown an error for incorrect type');
      } catch (error: any) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('not supported');
      }
    });
  });
});
