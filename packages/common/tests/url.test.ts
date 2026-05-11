import { describe, expect, it } from 'bun:test';

import { assertPublicUrl, concatenateUrl, isPrivateHostname } from '../src/url.js';

describe('url utilities', () => {
  describe('isPrivateHostname()', () => {
    it('detects localhost names', () => {
      expect(isPrivateHostname('localhost')).toBe(true);
      expect(isPrivateHostname('LOCALHOST.')).toBe(true);
      expect(isPrivateHostname('wallet.localhost')).toBe(true);
    });

    it('detects private and loopback IPv4 literals', () => {
      expect(isPrivateHostname('10.1.2.3')).toBe(true);
      expect(isPrivateHostname('127.0.0.1')).toBe(true);
      expect(isPrivateHostname('169.254.169.254')).toBe(true);
      expect(isPrivateHostname('172.16.0.1')).toBe(true);
      expect(isPrivateHostname('172.31.255.255')).toBe(true);
      expect(isPrivateHostname('192.168.1.1')).toBe(true);
      expect(isPrivateHostname('100.64.0.1')).toBe(true);
      expect(isPrivateHostname('224.0.0.1')).toBe(true);
    });

    it('allows public hostnames and IP literals', () => {
      expect(isPrivateHostname('example.com')).toBe(false);
      expect(isPrivateHostname('8.8.8.8')).toBe(false);
      expect(isPrivateHostname('1.1.1.1')).toBe(false);
      expect(isPrivateHostname('[2001:4860:4860::8888]')).toBe(false);
    });

    it('detects private and loopback IPv6 literals', () => {
      expect(isPrivateHostname('[::]')).toBe(true);
      expect(isPrivateHostname('[::1]')).toBe(true);
      expect(isPrivateHostname('[fe80::1]')).toBe(true);
      expect(isPrivateHostname('[fd00::1]')).toBe(true);
      expect(isPrivateHostname('[::ffff:7f00:1]')).toBe(true);
      expect(isPrivateHostname('[::ffff:c0a8:101]')).toBe(true);
      expect(isPrivateHostname('[::c0a8:101]')).toBe(true);
      expect(isPrivateHostname('[64:ff9b::a00:1]')).toBe(true);
    });
  });

  describe('assertPublicUrl()', () => {
    it('returns a URL for public hosts', () => {
      expect(assertPublicUrl('https://example.com/path').href).toBe('https://example.com/path');
    });

    it('throws for private hosts', () => {
      expect(() => assertPublicUrl('http://127.0.0.1:3000')).toThrow('private, loopback, or link-local');
    });
  });

  describe('concatenateUrl()', () => {
    it('joins base URLs and relative paths', () => {
      expect(concatenateUrl('https://example.com', 'path')).toBe('https://example.com/path');
      expect(concatenateUrl('https://example.com/', '/path')).toBe('https://example.com/path');
      expect(concatenateUrl('https://example.com/api', 'v1/resource')).toBe('https://example.com/api/v1/resource');
    });

    it('rejects path traversal segments', () => {
      expect(() => concatenateUrl('https://example.com/api', '../admin')).toThrow('parent directory');
      expect(() => concatenateUrl('https://example.com/api', '%2e%2e/admin')).toThrow('parent directory');
      expect(() => concatenateUrl('https://example.com/api', '..%2fadmin')).toThrow('parent directory');
      expect(() => concatenateUrl('https://example.com/api', '..%5cadmin')).toThrow('parent directory');
    });
  });
});
