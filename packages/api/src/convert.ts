import type { Multibase } from 'multiformats';

import { base32z } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import { base64url } from 'multiformats/bases/base64';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Helper functions for type checking
 */
function isAsyncIterable(obj: any): obj is AsyncIterable<any> {
  return obj != null && typeof obj[Symbol.asyncIterator] === 'function';
}

function isArrayBufferSlice(obj: any): boolean {
  return obj.byteOffset !== 0 || obj.byteLength !== obj.buffer.byteLength;
}

function universalTypeOf(obj: any): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  if (obj.constructor && obj.constructor.name) return obj.constructor.name;
  return typeof obj;
}

/**
 * Convert utility for transforming data between different formats.
 * This is a simplified version focused on the formats used by the api package.
 */
export class Convert {
  data: any;
  format: string;

  constructor(data: any, format: string) {
    this.data = data;
    this.format = format;
  }

  static arrayBuffer(data: ArrayBuffer): Convert {
    return new Convert(data, 'ArrayBuffer');
  }

  static asyncIterable(data: AsyncIterable<any>): Convert {
    if (!isAsyncIterable(data)) {
      throw new TypeError('Input must be of type AsyncIterable.');
    }
    return new Convert(data, 'AsyncIterable');
  }

  static base32Z(data: string): Convert {
    return new Convert(data, 'Base32Z');
  }

  static base58Btc(data: string): Convert {
    return new Convert(data, 'Base58Btc');
  }

  static base64Url(data: string): Convert {
    return new Convert(data, 'Base64Url');
  }

  static bufferSource(data: BufferSource): Convert {
    return new Convert(data, 'BufferSource');
  }

  static hex(data: string): Convert {
    if (typeof data !== 'string') {
      throw new TypeError('Hex input must be a string.');
    }
    if (data.length % 2 !== 0) {
      throw new TypeError('Hex input must have an even number of characters.');
    }
    return new Convert(data, 'Hex');
  }

  static multibase(data: string): Convert {
    return new Convert(data, 'Multibase');
  }

  static object(data: Record<string, any>): Convert {
    return new Convert(data, 'Object');
  }

  static string(data: string): Convert {
    return new Convert(data, 'String');
  }

  static uint8Array(data: Uint8Array): Convert {
    return new Convert(data, 'Uint8Array');
  }

  toArrayBuffer(): ArrayBuffer {
    switch (this.format) {
      case 'Base58Btc': {
        return base58btc.baseDecode(this.data).buffer;
      }

      case 'Base64Url': {
        return base64url.baseDecode(this.data).buffer;
      }

      case 'BufferSource': {
        const dataType = universalTypeOf(this.data);
        if (dataType === 'ArrayBuffer') {
          return this.data;
        } else if (ArrayBuffer.isView(this.data)) {
          if (isArrayBufferSlice(this.data)) {
            return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength);
          } else {
            return this.data.buffer;
          }
        } else {
          throw new TypeError(`${this.format} value is not of type: ArrayBuffer, DataView, or TypedArray.`);
        }
      }

      case 'Hex': {
        return this.toUint8Array().buffer;
      }

      case 'String': {
        return this.toUint8Array().buffer;
      }

      case 'Uint8Array': {
        return this.data.buffer;
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to ArrayBuffer is not supported.`);
    }
  }

  async toArrayBufferAsync(): Promise<ArrayBuffer> {
    switch (this.format) {
      case 'AsyncIterable': {
        const blob = await this.toBlobAsync();
        return await blob.arrayBuffer();
      }

      default:
        throw new TypeError(`Asynchronous conversion from ${this.format} to ArrayBuffer is not supported.`);
    }
  }

  toBase32Z(): string {
    switch (this.format) {
      case 'Uint8Array': {
        return base32z.baseEncode(this.data);
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to Base32Z is not supported.`);
    }
  }

  toBase58Btc(): string {
    switch (this.format) {
      case 'ArrayBuffer': {
        const u8a = new Uint8Array(this.data);
        return base58btc.baseEncode(u8a);
      }

      case 'Multibase': {
        return this.data.substring(1);
      }

      case 'Uint8Array': {
        return base58btc.baseEncode(this.data);
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to Base58Btc is not supported.`);
    }
  }

  toBase64Url(): string {
    switch (this.format) {
      case 'ArrayBuffer': {
        const u8a = new Uint8Array(this.data);
        return base64url.baseEncode(u8a);
      }

      case 'BufferSource': {
        const u8a = this.toUint8Array();
        return base64url.baseEncode(u8a);
      }

      case 'Object': {
        const string = JSON.stringify(this.data);
        const u8a = textEncoder.encode(string);
        return base64url.baseEncode(u8a);
      }

      case 'String': {
        const u8a = textEncoder.encode(this.data);
        return base64url.baseEncode(u8a);
      }

      case 'Uint8Array': {
        return base64url.baseEncode(this.data);
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to Base64Url is not supported.`);
    }
  }

  async toBlobAsync(): Promise<Blob> {
    switch (this.format) {
      case 'AsyncIterable': {
        const chunks = [];
        for await (const chunk of (this.data as AsyncIterable<any>)) {
          chunks.push(chunk);
        }
        const blob = new Blob(chunks);
        return blob;
      }

      default:
        throw new TypeError(`Asynchronous conversion from ${this.format} to Blob is not supported.`);
    }
  }

  toHex(): string {
    const hexes = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));

    switch (this.format) {
      case 'ArrayBuffer': {
        const u8a = this.toUint8Array();
        return Convert.uint8Array(u8a).toHex();
      }

      case 'Base64Url': {
        const u8a = this.toUint8Array();
        return Convert.uint8Array(u8a).toHex();
      }

      case 'Uint8Array': {
        let hex = '';
        for (let i = 0; i < this.data.length; i++) {
          hex += hexes[this.data[i]];
        }
        return hex;
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to Hex is not supported.`);
    }
  }

  toMultibase(): Multibase<any> {
    switch (this.format) {
      case 'Base58Btc': {
        return `z${this.data}`;
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to Multibase is not supported.`);
    }
  }

  toObject(): object {
    switch (this.format) {
      case 'Base64Url': {
        const u8a = base64url.baseDecode(this.data);
        const text = textDecoder.decode(u8a);
        return JSON.parse(text);
      }

      case 'String': {
        return JSON.parse(this.data);
      }

      case 'Uint8Array': {
        const text = textDecoder.decode(this.data);
        return JSON.parse(text);
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to Object is not supported.`);
    }
  }

  async toObjectAsync(): Promise<any> {
    switch (this.format) {
      case 'AsyncIterable': {
        const text = await this.toStringAsync();
        const json = JSON.parse(text);
        return json;
      }

      default:
        throw new TypeError(`Asynchronous conversion from ${this.format} to Object is not supported.`);
    }
  }

  toString(): string {
    switch (this.format) {
      case 'ArrayBuffer': {
        return textDecoder.decode(this.data);
      }

      case 'Base64Url': {
        const u8a = base64url.baseDecode(this.data);
        return textDecoder.decode(u8a);
      }

      case 'Object': {
        return JSON.stringify(this.data);
      }

      case 'Uint8Array': {
        return textDecoder.decode(this.data);
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to String is not supported.`);
    }
  }

  async toStringAsync(): Promise<string> {
    switch (this.format) {
      case 'AsyncIterable': {
        let str = '';
        for await (const chunk of (this.data as AsyncIterable<any>)) {
          if (typeof chunk === 'string')
            str += chunk;
          else
            str += textDecoder.decode(chunk, { stream: true });
        }
        str += textDecoder.decode(undefined, { stream: false });
        return str;
      }

      default:
        throw new TypeError(`Asynchronous conversion from ${this.format} to String is not supported.`);
    }
  }

  toUint8Array(): Uint8Array {
    switch (this.format) {
      case 'ArrayBuffer': {
        return new Uint8Array(this.data);
      }

      case 'Base32Z': {
        return base32z.baseDecode(this.data);
      }

      case 'Base58Btc': {
        return base58btc.baseDecode(this.data);
      }

      case 'Base64Url': {
        return base64url.baseDecode(this.data);
      }

      case 'BufferSource': {
        const dataType = universalTypeOf(this.data);
        if (dataType === 'Uint8Array') {
          return this.data;
        } else if (dataType === 'ArrayBuffer') {
          return new Uint8Array(this.data);
        } else if (ArrayBuffer.isView(this.data)) {
          return new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength);
        } else {
          throw new TypeError(`${this.format} value is not of type: ArrayBuffer, DataView, or TypedArray.`);
        }
      }

      case 'Hex': {
        const u8a = new Uint8Array(this.data.length / 2);
        for (let i = 0; i < this.data.length; i += 2) {
          const byteValue = parseInt(this.data.substring(i, i + 2), 16);
          if (isNaN(byteValue)) {
            throw new TypeError('Input is not a valid hexadecimal string.');
          }
          u8a[i / 2] = byteValue;
        }
        return u8a;
      }

      case 'Object': {
        const string = JSON.stringify(this.data);
        return textEncoder.encode(string);
      }

      case 'String': {
        return textEncoder.encode(this.data);
      }

      default:
        throw new TypeError(`Conversion from ${this.format} to Uint8Array is not supported.`);
    }
  }

  async toUint8ArrayAsync(): Promise<Uint8Array> {
    switch (this.format) {
      case 'AsyncIterable': {
        const arrayBuffer = await this.toArrayBufferAsync();
        return new Uint8Array(arrayBuffer);
      }

      default:
        throw new TypeError(`Asynchronous conversion from ${this.format} to Uint8Array is not supported.`);
    }
  }
}