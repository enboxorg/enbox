import { describe, expect, it } from 'bun:test';

import { parseDrlUrl } from '../src/drl-url-parser.js';

describe('parseDrlUrl', () => {
  it('should parse an https DRL URL with DID and path', () => {
    const result = parseDrlUrl('https://dweb/did:example:alice/records/abc');
    expect(result).toEqual(['did:example:alice', 'records/abc']);
  });

  it('should parse an http DRL URL', () => {
    const result = parseDrlUrl('http://dweb/did:example:bob/path');
    expect(result).toEqual(['did:example:bob', 'path']);
  });

  it('should return empty path when URL has no path after DID', () => {
    const result = parseDrlUrl('https://dweb/did:example:alice');
    expect(result).toEqual(['did:example:alice', '']);
  });

  it('should return empty path when URL has trailing slash only', () => {
    const result = parseDrlUrl('https://dweb/did:example:alice/');
    expect(result).toEqual(['did:example:alice', '']);
  });

  it('should return null for non-DRL URLs', () => {
    expect(parseDrlUrl('https://example.com/foo')).toBeNull();
    expect(parseDrlUrl('ftp://dweb/did:example:alice')).toBeNull();
    expect(parseDrlUrl('')).toBeNull();
  });

  it('should return null when DID segment is empty', () => {
    expect(parseDrlUrl('https://dweb/')).toBeNull();
    expect(parseDrlUrl('https://dweb//path')).toBeNull();
  });

  it('should preserve nested path segments', () => {
    const result = parseDrlUrl('https://dweb/did:dht:abc/protocols/xyz/records/123');
    expect(result).toEqual(['did:dht:abc', 'protocols/xyz/records/123']);
  });
});
