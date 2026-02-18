import { varint } from 'multiformats';

import { describe, expect, it } from 'bun:test';

import { Multicodec } from '../src/multicodec.js';

describe('Multicodec', () => {
  const mockEd25519PublicKey = (new Uint8Array(32)).fill(9);

  describe('addPrefix()', () => {
    it('returns Uint8Array with prefixed codec by code', () => {
      const input = 0xed;
      const output = new Uint8Array([0xed, 0x01]);

      const prefixedData = Multicodec.addPrefix({ code: input, data: mockEd25519PublicKey });

      expect(prefixedData).toBeInstanceOf(Uint8Array);
      const [_, codeByteLength] = varint.decode(prefixedData);
      expect(prefixedData.byteLength).toBe(codeByteLength + mockEd25519PublicKey.byteLength);
      expect(prefixedData.slice(0, codeByteLength)).toEqual(output);
    });

    it('returns Uint8Array with prefixed codec by name', () => {
      const input = 'ed25519-pub';
      const output = new Uint8Array([0xed, 0x01]);

      const prefixedData = Multicodec.addPrefix({ name: input, data: mockEd25519PublicKey });

      const [_, codeByteLength] = varint.decode(prefixedData);
      expect(prefixedData.byteLength).toBe(codeByteLength + mockEd25519PublicKey.byteLength);
      expect(prefixedData.slice(0, codeByteLength)).toEqual(output);
    });

    it('passes Multicodec test vectors', () => {
      Multicodec.registerCodec({ code: 0x3ffff, name: 'test-vector-3' });
      Multicodec.registerCodec({ code: 0x3fffff, name: 'test-vector-4' });

      // Test vectors.
      const testVectors: [number, ArrayLike<number>][] = [
        [0xed, [0xed, 0x01]],
        [0x1300, [0x80, 0x26]],
        [0x3ffff, [0xff, 0xff, 0x0f]],
        [0x3fffff, [0xff, 0xff, 0xff, 0x01]],
      ];

      testVectors.forEach(([input, output]) => {
        const prefixedData = Multicodec.addPrefix({ code: input, data: mockEd25519PublicKey });
        const [_, codeByteLength] = varint.decode(prefixedData);
        expect(prefixedData.byteLength).toBe(codeByteLength + mockEd25519PublicKey.byteLength);
        expect(prefixedData.slice(0, codeByteLength)).toEqual(new Uint8Array(output));
      });
    });

    it('throws an error when code and name input data missing', () => {
      expect(
        () => Multicodec.addPrefix({ data: new Uint8Array(0) })
      ).toThrow(`Either 'name' or 'code' must be defined, but not both.`);
    });

    it('throws an error when both code and name specified', () => {
      expect(
        () => Multicodec.addPrefix({ code: 0x99999, name: 'non-existent', data: new Uint8Array(0) })
      ).toThrow(`Either 'name' or 'code' must be defined, but not both.`);
    });

    it('throws an error when codec not found', () => {
      expect(
        () => Multicodec.addPrefix({ code: 0x99999, data: new Uint8Array(0) })
      ).toThrow('Unsupported multicodec: 629145');

      expect(
        () => Multicodec.addPrefix({ name: 'non-existent', data: new Uint8Array(0) })
      ).toThrow('Unsupported multicodec: non-existent');
    });
  });

  describe('getCodeFromData()', () => {
    it('returns codec code as a number', () => {
      const input = 0xed;
      const output = 237;
      const prefixedData = Multicodec.addPrefix({ code: input, data: mockEd25519PublicKey });

      const codecCode = Multicodec.getCodeFromData({ prefixedData });
      expect(typeof codecCode).toBe('number');
      expect(codecCode).toBe(output);
    });
  });

  describe('removePrefix()', () => {
    it('returns code, name, and data', () => {
      const input = new Uint8Array([0xed, 0x01, 0, 1, 2, 3]);

      const { code, data, name } = Multicodec.removePrefix({ prefixedData: input });

      expect(typeof code).toBe('number');
      expect(data).toBeInstanceOf(Uint8Array);
      expect(typeof name).toBe('string');
    });

    it('returns data as Uint8Array with prefixed codec removed', () => {
      const input = new Uint8Array([0xed, 0x01, 0, 1, 2, 3]);
      const output = new Uint8Array([0, 1, 2, 3]);

      const { data } = Multicodec.removePrefix({ prefixedData: input });

      expect(data).toBeInstanceOf(Uint8Array);
      expect(data).toEqual(output);
    });

    it('passes Multicodec test vectors', () => {
      Multicodec.registerCodec({ code: 0x3ffff, name: 'test-vector-3' });
      Multicodec.registerCodec({ code: 0x3fffff, name: 'test-vector-4' });

      // Test vectors.
      const testVectors: [ArrayLike<number>, ArrayLike<number>][] = [
        [[0xed, 0x01, 0, 1], [0, 1]],
        [[0x80, 0x26, 0, 1], [0, 1]],
        [[0xff, 0xff, 0x0f, 0, 1], [0, 1]],
        [[0xff, 0xff, 0xff, 0x01, 0, 1], [0, 1]],
      ];

      testVectors.forEach(([input, output]) => {
        const prefixedData = new Uint8Array(input);
        const [_, codeByteLength] = varint.decode(prefixedData);
        const { data } = Multicodec.removePrefix({ prefixedData });
        expect(data.byteLength).toBe(prefixedData.byteLength - codeByteLength);
        expect(data).toEqual(new Uint8Array(output));
      });
    });

    it('throws an error when codec not found', () => {
      const prefix = new Uint8Array([100, 100]);
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const dataWithPrefix = new Uint8Array(prefix.byteLength + data.byteLength);
      dataWithPrefix.set(prefix, 0);
      dataWithPrefix.set(data, prefix.length);

      expect(
        () => Multicodec.removePrefix({ prefixedData: dataWithPrefix })
      ).toThrow('Unsupported multicodec: 100');
    });
  });
});
