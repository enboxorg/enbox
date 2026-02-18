import { describe, expect, it } from 'bun:test';

import { normalizeProtocolUrl, validateProtocolUrlNormalized, validateSchemaUrlNormalized } from '../../src/utils/url.js';

describe('url', () => {
  describe('validateProtocolUrlNormalized', () => {
    it('errors when URI is not normalized', () => {
      expect(() => validateProtocolUrlNormalized('https://example.com')).not.toThrow();
      expect(() => validateProtocolUrlNormalized('example.com')).toThrow();
      expect(() => validateProtocolUrlNormalized(':foo:')).toThrow();
    });
  });

  describe('validateSchemaUrlNormalized', () => {
    it('should throw when URI is not normalized', () => {
      expect(() => validateSchemaUrlNormalized('example.com')).toThrow();
      expect(() => validateSchemaUrlNormalized(':foo:')).toThrow();
    });
  });

  describe('normalizeProtocolUrl', () => {
    it('returns hostname and path with trailing slash removed', () => {
      expect(normalizeProtocolUrl('example.com')).toBe('http://example.com');
      expect(normalizeProtocolUrl('example.com/')).toBe('http://example.com');
      expect(normalizeProtocolUrl('http://example.com')).toBe('http://example.com');
      expect(normalizeProtocolUrl('http://example.com/')).toBe('http://example.com');
      expect(normalizeProtocolUrl('example.com?foo=bar')).toBe('http://example.com');
      expect(normalizeProtocolUrl('example.com/?foo=bar')).toBe('http://example.com');
      expect(normalizeProtocolUrl('foo:example?foo=bar')).toBe('foo:example');

      expect(normalizeProtocolUrl('example.com/path')).toBe('http://example.com/path');
      expect(normalizeProtocolUrl('example.com/path/')).toBe('http://example.com/path');
      expect(normalizeProtocolUrl('http://example.com/path')).toBe('http://example.com/path');
      expect(normalizeProtocolUrl('http://example.com/path')).toBe('http://example.com/path');
      expect(normalizeProtocolUrl('example.com/path?foo=bar')).toBe('http://example.com/path');
      expect(normalizeProtocolUrl('example.com/path/?foo=bar')).toBe('http://example.com/path');
      expect(normalizeProtocolUrl('example.com/path#baz')).toBe('http://example.com/path');
      expect(normalizeProtocolUrl('example.com/path/#baz')).toBe('http://example.com/path');

      expect(normalizeProtocolUrl('example')).toBe('http://example');
      expect(normalizeProtocolUrl('/example/')).toBe('http://example');

      expect(() => normalizeProtocolUrl('://http')).toThrow(Error);
      expect(() => normalizeProtocolUrl(':foo:')).toThrow(Error);
    });
  });
});