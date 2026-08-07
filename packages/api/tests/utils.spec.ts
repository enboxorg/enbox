import { describe, expect, it } from 'bun:test';

import { dataToBlob } from '../src/utils.js';

describe('Enbox API Utils', () => {
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

    it('should preserve Blob bytes when the descriptor uses another format', async () => {
      const blob = new Blob(['{"ok":true}'], { type: 'application/json' });
      const result = dataToBlob(blob, 'application/vnd.example+json');

      expect(await result.dataBlob.text()).toBe('{"ok":true}');
      expect(result.dataFormat).toBe('application/vnd.example+json');
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
});
