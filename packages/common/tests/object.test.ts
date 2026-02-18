import { describe, expect, it } from 'bun:test';

import { isEmptyObject, removeEmptyObjects, removeUndefinedProperties } from '../src/object.js';

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
  });

});
