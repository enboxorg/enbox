import { describe, expect, it } from 'bun:test';
import { removeEmptyObjects, removeUndefinedProperties } from '../../src/utils/object.js';

describe('Object', () => {
  describe('removeUndefinedProperties', () => {
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

  describe('removeEmptyObjects', () => {
    it('should remove all empty objects', () => {
      const obj = {
        foo  : {},
        bar  : { baz: {} },
        buzz : 'hello'
      };
      removeEmptyObjects(obj);

      expect(obj).toEqual({ buzz: 'hello' });
    });
  });
});