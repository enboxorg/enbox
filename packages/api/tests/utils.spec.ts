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

    it('should preserve binary File bytes and infer its MIME type', async () => {
      const bytes = new Uint8Array([0, 255, 10, 123, 125]);
      const file = new File([bytes], 'upload.png', { type: 'image/png' });
      const result = dataToBlob(file);

      expect(new Uint8Array(await result.dataBlob.arrayBuffer())).toEqual(bytes);
      expect(result.dataFormat).toBe('image/png');
    });

    it.skipIf(typeof document === 'undefined')('should preserve File bytes from another window with an explicit JSON format', async () => {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      try {
        const otherWindow = frame.contentWindow as Window & typeof globalThis;
        const file = new otherWindow.File(['foreign file'], 'foreign.txt', { type: 'text/plain' });
        expect(file).not.toBeInstanceOf(Blob);

        const result = dataToBlob(file, 'application/json');

        expect(result.dataFormat).toBe('application/json');
        expect(await result.dataBlob.text()).toBe('foreign file');
      } finally {
        frame.remove();
      }
    });

    it('should throw an error for unsupported data types', () => {
      expect(() => dataToBlob(42)).toThrow('data type not supported.');
    });
  });
});
