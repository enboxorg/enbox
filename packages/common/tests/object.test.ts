import { describe, expect, it } from 'bun:test';

import { isEmptyObject, omitUndefined, removeEmptyObjects, removeUndefinedProperties } from '../src/object.js';

describe('Object', () => {

  describe('isEmptyObject()', () => {
    it('should return true for an empty object', () => {
      expect(isEmptyObject({})).toBe(true);
    });

    it('should return false for a non-empty object', () => {
      expect(isEmptyObject({ key: 'value' })).toBe(false);
    });

    it('should return false for null', () => {
      expect(isEmptyObject(null)).toBe(false);
    });

    it('should return true for an object with no prototype', () => {
      expect(isEmptyObject(Object.create(null))).toBe(true);
    });

    it('should return false for an object with no prototype but containing properties', () => {
      const obj = Object.create(null);
      obj.key = 'value';
      expect(isEmptyObject(obj)).toBe(false);
    });

    it('should return false for an object with symbol properties', () => {
      const symbol = Symbol('key');
      const obj = { [symbol]: 'value' };
      expect(isEmptyObject(obj)).toBe(false);
    });

    it('should return false for a non-object (number)', () => {
      expect(isEmptyObject(42)).toBe(false);
    });

    it('should return false for a non-object (string)', () => {
      expect(isEmptyObject('text')).toBe(false);
    });

    it('should return true for an object that inherits properties but has none of its own', () => {
      const parent = { parentKey: 'value' };
      const child = Object.create(parent);
      expect(isEmptyObject(child)).toBe(true);
    });
  });

  describe('removeEmptyObjects()', () => {
    it('should remove all empty objects', () => {
      const mockObject = {
        foo  : {},
        bar  : { baz: {} },
        buzz : 'hello'
      };

      const expectedResult = { buzz: 'hello' };

      removeEmptyObjects(mockObject);

      expect(mockObject).toEqual(expectedResult);
    });

    it('does not throw when an object contains null values', () => {
      // `typeof null === 'object'` in JavaScript, so a pre-fix
      // recursion into `null` would call `Object.keys(null)` and throw.
      const obj: Record<string, unknown> = { a: null, b: { c: null }, d: 'keep' };
      expect(() => removeEmptyObjects(obj)).not.toThrow();
      // `null` is preserved; only literal empty objects are removed.
      expect(obj).toEqual({ a: null, b: { c: null }, d: 'keep' });
    });
  });

  describe('removeUndefinedProperties()', () => {
    it('should remove all `undefined` properties of a nested object', () => {
      const mockObject = {
        a : true,
        b : undefined,
        c : {
          a : 0,
          b : undefined,
        }
      };

      const expectedResult = {
        a : true,
        c : {
          a: 0
        }
      };

      removeUndefinedProperties(mockObject);

      expect(mockObject).toEqual(expectedResult);
    });

    it('does not throw when an object contains null values', () => {
      // Regression for a latent crash: `typeof null === 'object'`, so the
      // recursive branch would otherwise call `Object.keys(null)` and
      // throw. `null` is now skipped (not recursed into, not deleted).
      const obj: Record<string, unknown> = {
        a : null,
        b : undefined,
        c : { d: null, e: undefined },
        f : 'keep'
      };
      expect(() => removeUndefinedProperties(obj)).not.toThrow();
      expect(obj).toEqual({ a: null, c: { d: null }, f: 'keep' });
    });
  });

  describe('omitUndefined()', () => {
    it('returns a new object without `undefined` keys', () => {
      const input = { a: 1, b: undefined, c: 'x' };
      const result = omitUndefined(input);
      expect(result).toEqual({ a: 1, c: 'x' });
    });

    it('does not mutate the input', () => {
      const input = { a: 1, b: undefined };
      const before = { ...input };
      omitUndefined(input);
      expect(input).toEqual(before);
    });

    it('preserves falsy values that are not `undefined`', () => {
      const input = { zero: 0, empty: '', falseBool: false, nullVal: null };
      expect(omitUndefined(input)).toEqual({ zero: 0, empty: '', falseBool: false, nullVal: null });
    });

    it('does not descend into nested objects', () => {
      // Shallow by design — contrast with `removeUndefinedProperties`.
      const input = { outer: { inner: undefined, kept: 1 } };
      const result = omitUndefined(input);
      expect(result).toEqual({ outer: { inner: undefined, kept: 1 } });
    });

    it('returns an empty object when every value is `undefined`', () => {
      expect(omitUndefined({ a: undefined, b: undefined })).toEqual({});
    });

    it('preserves the typed shape of the input', () => {
      type Opts = { foo?: string; bar?: number };
      const result: Partial<Opts> = omitUndefined<Opts>({ foo: 'x', bar: undefined });
      expect(result).toEqual({ foo: 'x' });
    });
  });

});
