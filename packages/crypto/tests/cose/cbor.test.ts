import { describe, expect, it } from 'bun:test';

import { Cbor } from '../../src/cose/cbor.js';

describe('Cbor', () => {
  describe('encode()', () => {
    it('should encode a simple integer', () => {
      const encoded = Cbor.encode(42);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should encode a string', () => {
      const encoded = Cbor.encode('hello');
      expect(encoded).toBeInstanceOf(Uint8Array);
    });

    it('should encode a Uint8Array as a CBOR byte string', () => {
      const input = new Uint8Array([1, 2, 3, 4]);
      const encoded = Cbor.encode(input);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });

    it('should encode an object', () => {
      const input = { a: 1, b: 'two', c: true };
      const encoded = Cbor.encode(input);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });

    it('should encode a Map', () => {
      const input = new Map<number, unknown>([
        [1, 'one'],
        [2, 'two'],
      ]);
      const encoded = Cbor.encode(input);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });

    it('should encode null and undefined', () => {
      const encodedNull = Cbor.encode(null);
      expect(encodedNull).toBeInstanceOf(Uint8Array);

      const encodedUndefined = Cbor.encode(undefined);
      expect(encodedUndefined).toBeInstanceOf(Uint8Array);
    });

    it('should encode an array', () => {
      const input = [1, 'two', true, null];
      const encoded = Cbor.encode(input);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });

    it('should encode a boolean', () => {
      const encodedTrue = Cbor.encode(true);
      const encodedFalse = Cbor.encode(false);
      expect(encodedTrue).toBeInstanceOf(Uint8Array);
      expect(encodedFalse).toBeInstanceOf(Uint8Array);
    });

    it('should encode negative integers', () => {
      const encoded = Cbor.encode(-42);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });
  });

  describe('decode()', () => {
    it('should round-trip a simple integer', () => {
      const input = 42;
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<number>(encoded);
      expect(decoded).toBe(input);
    });

    it('should round-trip a string', () => {
      const input = 'hello world';
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<string>(encoded);
      expect(decoded).toBe(input);
    });

    it('should round-trip a Uint8Array', () => {
      const input = new Uint8Array([10, 20, 30, 40, 50]);
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<Uint8Array>(encoded);
      expect(decoded).toEqual(input);
    });

    it('should round-trip an object as a Map with string keys', () => {
      const input = { x: 1, y: 'hello', z: false };
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<Map<string, unknown>>(encoded);

      // With useMaps: true, objects round-trip as Maps.
      expect(decoded).toBeInstanceOf(Map);
      expect(decoded.get('x')).toBe(1);
      expect(decoded.get('y')).toBe('hello');
      expect(decoded.get('z')).toBe(false);
    });

    it('should round-trip a Map with integer keys', () => {
      const input = new Map<number, unknown>([
        [1, -7],
        [4, new Uint8Array([1, 2, 3])],
      ]);
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<Map<number, unknown>>(encoded);
      expect(decoded).toBeInstanceOf(Map);
      expect(decoded.get(1)).toBe(-7);
      expect(decoded.get(4)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should round-trip an array', () => {
      const input = [1, 'two', true, null];
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<unknown[]>(encoded);
      expect(decoded).toEqual(input);
    });

    it('should round-trip null', () => {
      const encoded = Cbor.encode(null);
      const decoded = Cbor.decode(encoded);
      expect(decoded).toBeNull();
    });

    it('should round-trip negative integers', () => {
      const input = -100;
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<number>(encoded);
      expect(decoded).toBe(input);
    });

    it('should round-trip nested structures', () => {
      const input = new Map<number, unknown>([
        [1, new Map<number, unknown>([
          [2, new Uint8Array([0xDE, 0xAD])],
        ])],
        [3, [1, 2, 3]],
      ]);
      const encoded = Cbor.encode(input);
      const decoded = Cbor.decode<Map<number, unknown>>(encoded);
      expect(decoded).toBeInstanceOf(Map);

      const inner = decoded.get(1) as Map<number, unknown>;
      expect(inner).toBeInstanceOf(Map);
      expect(inner.get(2)).toEqual(new Uint8Array([0xDE, 0xAD]));
      expect(decoded.get(3)).toEqual([1, 2, 3]);
    });

    it('should throw on invalid CBOR input', () => {
      const invalidCbor = new Uint8Array([0xFF, 0xFF, 0xFF]);
      expect(() => Cbor.decode(invalidCbor)).toThrow();
    });
  });
});
