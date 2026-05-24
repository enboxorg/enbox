import { afterEach, describe, expect, it, mock } from 'bun:test';

import { assertPublicUrl, concatenateUrl, fetchPublicUrl, isPrivateHostname } from '../src/url.js';

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

    it('rejects non-network schemes by default so callers cannot smuggle file:/javascript:/etc through fetch', () => {
      expect(() => assertPublicUrl('file:///etc/hosts')).toThrow('allowed schemes');
      expect(() => assertPublicUrl('javascript:alert(1)')).toThrow('allowed schemes');
      expect(() => assertPublicUrl('data:text/plain,hello')).toThrow('allowed schemes');
      expect(() => assertPublicUrl('ws://example.com')).toThrow('allowed schemes');
    });

    it('rejects URLs without a hostname', () => {
      expect(() => assertPublicUrl('http://')).toThrow();
    });

    it('honors a custom allowedProtocols list when callers really do want non-default schemes', () => {
      expect(assertPublicUrl('ws://example.com/socket', 'WebSocket URL', { allowedProtocols: ['ws:', 'wss:'] }).href).toBe('ws://example.com/socket');
      expect(() => assertPublicUrl('http://example.com', 'WebSocket URL', { allowedProtocols: ['ws:', 'wss:'] })).toThrow('allowed schemes');
    });
  });

  describe('fetchPublicUrl()', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('passes through a successful response without following or re-fetching', async () => {
      const response = new Response('ok', { status: 200 });
      const fetchMock = mock(async () => response);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await fetchPublicUrl('https://example.com/path');

      expect(result).toBe(response);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]![1] as RequestInit).redirect).toBe('manual');
    });

    it('follows redirects to other public hosts', async () => {
      const finalResponse = new Response('done', { status: 200 });
      const fetchMock = mock(async (url: string | URL) => {
        const target = url.toString();
        if (target === 'https://example.com/start') {
          return new Response(null, { status: 302, headers: { location: 'https://other.example.com/end' } });
        }
        return finalResponse;
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await fetchPublicUrl('https://example.com/start');

      expect(result).toBe(finalResponse);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]![0]).toBe('https://other.example.com/end');
    });

    it('blocks redirects to private hosts (the SSRF-via-redirect attack)', async () => {
      const fetchMock = mock(async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(fetchPublicUrl('https://example.com/redirect-me')).rejects.toThrow('private, loopback, or link-local');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('blocks redirects that switch to a non-network scheme', async () => {
      const fetchMock = mock(async () =>
        new Response(null, { status: 302, headers: { location: 'file:///etc/hosts' } }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(fetchPublicUrl('https://example.com/redirect-me')).rejects.toThrow('allowed schemes');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns 3xx responses with no Location header unchanged (e.g. 304 Not Modified)', async () => {
      const response = new Response(null, { status: 304 });
      const fetchMock = mock(async () => response);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await fetchPublicUrl('https://example.com/cached');

      expect(result).toBe(response);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after maxRedirects to bound worst-case behavior', async () => {
      let counter = 0;
      const fetchMock = mock(async () => {
        counter += 1;
        return new Response(null, { status: 302, headers: { location: `https://example.com/hop-${counter}` } });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(fetchPublicUrl('https://example.com/start', undefined, { maxRedirects: 2 })).rejects.toThrow('maximum number of redirects');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('rejects the initial URL itself when it targets a private host', async () => {
      const fetchMock = mock(async () => new Response('should not happen'));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(fetchPublicUrl('http://127.0.0.1:3000/foo')).rejects.toThrow('private, loopback, or link-local');
      expect(fetchMock).not.toHaveBeenCalled();
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

    it('rejects malformed percent-encoded segments rather than surfacing URIError', () => {
      expect(() => concatenateUrl('https://example.com/api', '%E0%A4')).toThrow('parent directory');
      expect(() => concatenateUrl('https://example.com/api', '%')).toThrow('parent directory');
    });

    it('rejects raw `?` and `#` in the path so they are not silently percent-encoded into the pathname', () => {
      expect(() => concatenateUrl('https://example.com/api', 'items?limit=1')).toThrow('query string or fragment');
      expect(() => concatenateUrl('https://example.com/api', 'items#fragment')).toThrow('query string or fragment');
      expect(() => concatenateUrl('https://example.com/api', 'items?a=1#frag')).toThrow('query string or fragment');
    });

    it('preserves percent-encoded `%3F` and `%23` so legitimate path segments containing those characters work', () => {
      expect(concatenateUrl('https://example.com/api', 'items%3Flimit=1')).toBe('https://example.com/api/items%3Flimit=1');
      expect(concatenateUrl('https://example.com/api', 'items%23fragment')).toBe('https://example.com/api/items%23fragment');
    });
  });
});
