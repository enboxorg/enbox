import { describe, expect, it } from 'bun:test';

import { concatenateUrl } from '../src/url.js';

describe('concatenateUrl', () => {
  it('joins base URL and path with a single slash', () => {
    expect(concatenateUrl('https://example.com', 'api/v1')).toBe('https://example.com/api/v1');
  });

  it('removes trailing slash from base URL', () => {
    expect(concatenateUrl('https://example.com/', 'api/v1')).toBe('https://example.com/api/v1');
  });

  it('removes leading slash from path', () => {
    expect(concatenateUrl('https://example.com', '/api/v1')).toBe('https://example.com/api/v1');
  });

  it('handles both trailing and leading slashes', () => {
    expect(concatenateUrl('https://example.com/', '/api/v1')).toBe('https://example.com/api/v1');
  });

  it('handles multi-segment paths', () => {
    expect(concatenateUrl('https://example.com/api', 'v1/resource')).toBe('https://example.com/api/v1/resource');
  });

  it('preserves the path verbatim when it has no leading slash and base has no trailing slash', () => {
    expect(concatenateUrl('https://example.com/api', 'v1/resource')).toBe('https://example.com/api/v1/resource');
  });

  it('handles deeply-nested paths', () => {
    expect(concatenateUrl('https://example.com', 'a/b/c/d')).toBe('https://example.com/a/b/c/d');
    expect(concatenateUrl('https://example.com/', '/a/b/c/d')).toBe('https://example.com/a/b/c/d');
  });

  it('handles query strings and fragments on the path', () => {
    expect(concatenateUrl('https://example.com', 'search?q=1#frag')).toBe('https://example.com/search?q=1#frag');
    expect(concatenateUrl('https://example.com/', '/search?q=1#frag')).toBe('https://example.com/search?q=1#frag');
  });

  it('does not strip slashes from inside the path', () => {
    // Only the leading slash on `path` is removed — internal slashes survive.
    expect(concatenateUrl('https://example.com', 'a//b')).toBe('https://example.com/a//b');
  });

  it('handles localhost / port URLs', () => {
    expect(concatenateUrl('http://localhost:3000', '/info')).toBe('http://localhost:3000/info');
    expect(concatenateUrl('http://localhost:3000/', 'info')).toBe('http://localhost:3000/info');
  });

  it('handles non-http schemes', () => {
    expect(concatenateUrl('ws://localhost:3000', 'ws')).toBe('ws://localhost:3000/ws');
    expect(concatenateUrl('did:dht:example/', '/resolve')).toBe('did:dht:example/resolve');
  });
});
