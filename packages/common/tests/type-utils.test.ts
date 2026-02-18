import { describe, expect, it } from 'bun:test';

import { isAsyncIterable, isDefined, universalTypeOf } from '../src/type-utils.js';

describe('Type Utils', () => {
  describe('isAsyncIterable()', () => {
    it('should return true for a valid AsyncIterable', () => {
      const asyncIterator = {
        async *[Symbol.asyncIterator](): AsyncGenerator<number> {
          yield 1;
          yield 2;
        }
      };
      expect(isAsyncIterable(asyncIterator)).toBe(true);
    });

    it('should return false for non-object types', () => {
      expect(isAsyncIterable(123)).toBe(false);
      expect(isAsyncIterable('string')).toBe(false);
      expect(isAsyncIterable(true)).toBe(false);
      expect(isAsyncIterable(undefined)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isAsyncIterable(null)).toBe(false);
    });

    it('should return false for an object without [Symbol.asyncIterator]', () => {
      const regularObject = { a: 1, b: 2 };
      expect(isAsyncIterable(regularObject)).toBe(false);
    });

    it('should return false for an object with a non-function [Symbol.asyncIterator]', () => {
      const invalidAsyncIterator = { [Symbol.asyncIterator]: 123 };
      expect(isAsyncIterable(invalidAsyncIterator)).toBe(false);
    });
  });

  describe('isDefined()', () => {
    it('should return true for defined non-null values', () => {
      expect(isDefined('string')).toBe(true);
      expect(isDefined(42)).toBe(true);
      expect(isDefined(false)).toBe(true);
      expect(isDefined({})).toBe(true);
      expect(isDefined([])).toBe(true);
    });

    it('should return false for undefined or null', () => {
      expect(isDefined(undefined)).toBe(false);
      expect(isDefined(null)).toBe(false);
    });
  });

  describe('universalTypeOf()', () => {
    it('should correctly identify Array', () => {
      expect(universalTypeOf([1, 2, 3])).toBe('Array');
    });

    it('should correctly identify ArrayBuffer', () => {
      expect(universalTypeOf(new ArrayBuffer(2))).toBe('ArrayBuffer');
    });

    it('should correctly identify Blob', () => {
      expect(universalTypeOf(new Blob(['foo']))).toBe('Blob');
    });

    it('should correctly identify Boolean', () => {
      expect(universalTypeOf(true)).toBe('Boolean');
    });

    it('should correctly identify Number', () => {
      expect(universalTypeOf(42)).toBe('Number');
    });

    it('should correctly identify Null', () => {
      expect(universalTypeOf(null)).toBe('Null');
    });

    it('should correctly identify Object', () => {
      expect(universalTypeOf({ a: 1, b: 2 })).toBe('Object');
    });

    it('should correctly identify String', () => {
      expect(universalTypeOf('some string')).toBe('String');
    });

    it('should correctly identify Uint8Array', () => {
      expect(universalTypeOf(new Uint8Array([1, 2, 3]))).toBe('Uint8Array');
    });

    it('should correctly identify Undefined', () => {
      expect(universalTypeOf(undefined)).toBe('Undefined');
    });
  });

});
