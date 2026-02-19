import { describe, expect, it } from 'bun:test';

import { dataToBlob, SendCache } from '../src/utils.js';

describe('Web5 API Utils', () => {
  describe('dataToBlob()', () => {
    it('should handle text data with explicit format', async () => {
      const result = dataToBlob('Hello World', 'text/plain');
      // Bun's Blob appends `;charset=utf-8` to text types; assert the base type.
      expect(result.dataBlob.type.startsWith('text/plain')).toBe(true);
      expect(result.dataFormat).toBe('text/plain');
      const output = await result.dataBlob.text();
      expect(output).toBe('Hello World');
    });

    it('should handle text data with detected type', async () => {
      const result = dataToBlob('Hello World');
      expect(result.dataBlob.type.startsWith('text/plain')).toBe(true);
      expect(result.dataFormat).toBe('text/plain');
      const output = await result.dataBlob.text();
      expect(output).toBe('Hello World');
    });

    it('should handle JSON data with explicit format', async () => {
      const result = dataToBlob({ key: 'value' }, 'application/json');
      expect(result.dataBlob.type.startsWith('application/json')).toBe(true);
      expect(result.dataFormat).toBe('application/json');
    });

    it('should handle JSON data with detected type', () => {
      const result = dataToBlob({ key: 'value' });
      expect(result.dataBlob.type.startsWith('application/json')).toBe(true);
      expect(result.dataFormat).toBe('application/json');
    });

    it('should handle Uint8Array data', () => {
      const result = dataToBlob(new Uint8Array([1, 2, 3]));
      expect(result.dataBlob.type).toBe('application/octet-stream');
      expect(result.dataFormat).toBe('application/octet-stream');
    });

    it('should handle ArrayBuffer data', () => {
      const result = dataToBlob(new ArrayBuffer(3));
      expect(result.dataBlob.type).toBe('application/octet-stream');
      expect(result.dataFormat).toBe('application/octet-stream');
    });

    it('should handle Blob data with a specified type', () => {
      const blob = new Blob(['data'], { type: 'custom/type' });
      const result = dataToBlob(blob);
      expect(result.dataBlob.type).toBe('custom/type');
      expect(result.dataFormat).toBe('custom/type');
    });

    it('should handle Blob data that lacks a type', () => {
      const blob = new Blob(['data']);
      const result = dataToBlob(blob);
      expect(result.dataBlob.type).toBe('');
      expect(result.dataFormat).toBe('application/octet-stream');
    });

    it('should throw an error for unsupported data types', () => {
      expect(() => dataToBlob(42)).toThrow('data type not supported.');
    });
  });

  describe('SendCache', () => {
    it('sets and checks an item in the cache', async () => {
      // checks for 'id' and 'target', returns false because we have not set them yet
      expect(SendCache.check('id', 'target')).toBe(false);

      // set 'id' and 'target, and then check
      SendCache.set('id', 'target');
      expect(SendCache.check('id', 'target')).toBe(true);

      // check for 'id' with a different target
      expect(SendCache.check('id', 'target2')).toBe(false);
    });

    it('purges the first item in the cache when the target cache is full (100 items)', async () => {
      const recordId = 'id';
      // set 100 items in the cache to the same id
      for (let i = 0; i < 100; i++) {
        SendCache.set(recordId, `target-${i}`);
      }

      // check that the first item is in the cache
      expect(SendCache.check(recordId, 'target-0')).toBe(true);

      // set another item in the cache
      SendCache.set(recordId, 'target-new');

      // check that the first item is no longer in the cache but the one after it is as well as the new one.
      expect(SendCache.check(recordId, 'target-0')).toBe(false);
      expect(SendCache.check(recordId, 'target-1')).toBe(true);
      expect(SendCache.check(recordId, 'target-new')).toBe(true);

      // add another item
      SendCache.set(recordId, 'target-new2');
      expect(SendCache.check(recordId, 'target-1')).toBe(false);
      expect(SendCache.check(recordId, 'target-2')).toBe(true);
      expect(SendCache.check(recordId, 'target-new2')).toBe(true);
    });

    it('purges the first item in the cache when the record cache is full (100 items)', async () => {
      const target = 'target';
      // set 100 items in the cache to the same id
      for (let i = 0; i < 100; i++) {
        SendCache.set(`record-${i}`, target);
      }

      // check that the first item is in the cache
      expect(SendCache.check('record-0', target)).toBe(true);

      // set another item in the cache
      SendCache.set('record-new', target);

      // check that the first item is no longer in the cache but the one after it is as well as the new one.
      expect(SendCache.check('record-0', target)).toBe(false);
      expect(SendCache.check('record-1', target)).toBe(true);
      expect(SendCache.check('record-new', target)).toBe(true);

      // add another item
      SendCache.set('record-new2', target);
      expect(SendCache.check('record-1', target)).toBe(false);
      expect(SendCache.check('record-2', target)).toBe(true);
      expect(SendCache.check('record-new2', target)).toBe(true);
    });
  });
});
