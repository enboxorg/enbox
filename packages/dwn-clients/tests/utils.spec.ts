import { describe, expect, it } from 'bun:test';

import { concatenateUrl } from '../src/utils.js';

describe('utils', () => {
  describe('concatenateUrl', () => {
    it('joins base URL and path with a single slash', () => {
      expect(concatenateUrl('https://example.com', 'path')).toBe('https://example.com/path');
    });

    it('removes trailing slash from base URL', () => {
      expect(concatenateUrl('https://example.com/', 'path')).toBe('https://example.com/path');
    });

    it('removes leading slash from path', () => {
      expect(concatenateUrl('https://example.com', '/path')).toBe('https://example.com/path');
    });

    it('handles both trailing and leading slashes', () => {
      expect(concatenateUrl('https://example.com/', '/path')).toBe('https://example.com/path');
    });

    it('handles multi-segment paths', () => {
      expect(concatenateUrl('https://example.com/api', 'v1/resource')).toBe('https://example.com/api/v1/resource');
    });

    it('rejects parent directory path segments', () => {
      expect(() => concatenateUrl('https://example.com/api', '../admin')).toThrow('parent directory');
      expect(() => concatenateUrl('https://example.com/api', '%2e%2e/admin')).toThrow('parent directory');
      expect(() => concatenateUrl('https://example.com/api', '..%2fadmin')).toThrow('parent directory');
      expect(() => concatenateUrl('https://example.com/api', '..%5cadmin')).toThrow('parent directory');
    });
  });
});
