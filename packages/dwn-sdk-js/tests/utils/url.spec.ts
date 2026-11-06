import { describe, expect, it } from 'bun:test';

import { normalizeModuleUrl, validateModuleUrlNormalized, validateSchemaUrlNormalized } from '../../src/utils/url.js';

describe('url', () => {
  describe('validateModuleUrlNormalized', () => {
    it('errors when URI is not normalized', () => {
      expect(() => validateModuleUrlNormalized('https://example.com')).not.toThrow();
      expect(() => validateModuleUrlNormalized('example.com')).toThrow();
      expect(() => validateModuleUrlNormalized(':foo:')).toThrow();
    });
  });

  describe('validateSchemaUrlNormalized', () => {
    it('should throw when URI is not normalized', () => {
      expect(() => validateSchemaUrlNormalized('example.com')).toThrow();
      expect(() => validateSchemaUrlNormalized(':foo:')).toThrow();
    });
  });

  describe('normalizeModuleUrl', () => {
    it('returns hostname and path with trailing slash removed', () => {
      expect(normalizeModuleUrl('example.com')).toBe('http://example.com');
      expect(normalizeModuleUrl('example.com/')).toBe('http://example.com');
      expect(normalizeModuleUrl('http://example.com')).toBe('http://example.com');
      expect(normalizeModuleUrl('http://example.com/')).toBe('http://example.com');
      expect(normalizeModuleUrl('example.com?foo=bar')).toBe('http://example.com');
      expect(normalizeModuleUrl('example.com/?foo=bar')).toBe('http://example.com');
      expect(normalizeModuleUrl('foo:example?foo=bar')).toBe('foo:example');

      expect(normalizeModuleUrl('example.com/path')).toBe('http://example.com/path');
      expect(normalizeModuleUrl('example.com/path/')).toBe('http://example.com/path');
      expect(normalizeModuleUrl('http://example.com/path')).toBe('http://example.com/path');
      expect(normalizeModuleUrl('http://example.com/path')).toBe('http://example.com/path');
      expect(normalizeModuleUrl('example.com/path?foo=bar')).toBe('http://example.com/path');
      expect(normalizeModuleUrl('example.com/path/?foo=bar')).toBe('http://example.com/path');
      expect(normalizeModuleUrl('example.com/path#baz')).toBe('http://example.com/path');
      expect(normalizeModuleUrl('example.com/path/#baz')).toBe('http://example.com/path');

      expect(normalizeModuleUrl('example')).toBe('http://example');
      expect(normalizeModuleUrl('/example/')).toBe('http://example');

      expect(() => normalizeModuleUrl('://http')).toThrow(Error);
      expect(() => normalizeModuleUrl(':foo:')).toThrow(Error);
    });
  });
});