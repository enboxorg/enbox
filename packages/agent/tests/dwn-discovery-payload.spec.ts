import { describe, expect, it } from 'bun:test';

import type { DwnDiscoveryPayload } from '../src/dwn-discovery-payload.js';

import {
  buildDwnConnectUrl,
  buildDwnDiscoveryRedirectUrl,
  decodeDwnDiscoveryPayload,
  DWN_CONNECT_PATH,
  DWN_PROTOCOL_SCHEME,
  encodeDwnDiscoveryPayload,
  parseDwnConnectUrl,
  readDwnDiscoveryPayloadFromUrl,
} from '../src/dwn-discovery-payload.js';

/** Encode a string as unpadded base64url for constructing test inputs. */
function toBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Tests ───────────────────────────────────────────────────────

describe('DwnDiscoveryPayload', () => {
  describe('constants', () => {
    it('should export the dwn protocol scheme', () => {
      expect(DWN_PROTOCOL_SCHEME).toBe('dwn');
    });

    it('should export the connect path', () => {
      expect(DWN_CONNECT_PATH).toBe('connect');
    });
  });

  describe('encodeDwnDiscoveryPayload / decodeDwnDiscoveryPayload', () => {
    it('should round-trip a simple payload', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it('should produce a base64url string without padding', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };

      const encoded = encodeDwnDiscoveryPayload(payload);

      // base64url must not contain +, /, or = characters.
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
    });

    it('should round-trip a payload with a port-free localhost endpoint', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://localhost' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it('should round-trip a payload with an https localhost endpoint', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'https://localhost:55500' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it('should reject a payload with a non-loopback endpoint', () => {
      const encoded = encodeDwnDiscoveryPayload({ endpoint: 'https://dwn.example.com' });
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toBeUndefined();
    });

    it('should round-trip a payload with unicode in the endpoint path', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:3000/caf\u00e9' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it.each([
      ['an empty string', ''],
      ['garbage input', '!!!not-base64!!!'],
      ['valid base64url that is not JSON', toBase64Url('hello world')],
      ['valid JSON missing the endpoint field', toBase64Url(JSON.stringify({ foo: 'bar' }))],
      ['valid JSON with an empty endpoint', toBase64Url(JSON.stringify({ endpoint: '' }))],
      ['valid JSON with a numeric endpoint', toBase64Url(JSON.stringify({ endpoint: 12345 }))],
      ['valid JSON with a null value', toBase64Url('null')],
    ] as const)('should return undefined for %s', (_name, encoded) => {
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toBeUndefined();
    });

    it('should round-trip a payload containing multi-byte UTF-8 characters', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:3000/caf\u00e9' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it('should round-trip a payload containing emoji (4-byte UTF-8)', () => {
      // Emoji is U+1F680 which is above U+FFFF and requires a surrogate
      // pair in JavaScript — tests the TextEncoder/TextDecoder path.
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:3000/\u{1F680}' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

  });

  describe('loopback validation', () => {
    it.each([
      ['127.0.0.1', 'http://127.0.0.1:55500'],
      ['localhost', 'http://localhost:3000'],
      ['[::1] (IPv6 loopback)', 'http://[::1]:55500'],
      ['subdomain-of-localhost', 'http://foo.localhost:3000'],
    ] as const)('should accept %s endpoints', (_name, endpoint) => {
      const encoded = toBase64Url(JSON.stringify({ endpoint }));

      expect(decodeDwnDiscoveryPayload(encoded)).toBeDefined();
    });

    it.each([
      ['a remote hostname', 'https://evil.com:55500'],
      ['a private network IP', 'http://192.168.1.1:55500'],
      ['a hostname that contains localhost but is not localhost', 'http://notlocalhost:3000'],
      ['an endpoint with no scheme', '127.0.0.1:3000'],
    ] as const)('should reject %s', (_name, endpoint) => {
      const encoded = toBase64Url(JSON.stringify({ endpoint }));

      expect(decodeDwnDiscoveryPayload(encoded)).toBeUndefined();
    });
  });

  describe('parseDwnConnectUrl', () => {
    it('should parse a valid dwn://connect URL', () => {
      const url = 'dwn://connect?callback=https%3A%2F%2Fnotes.sh%2Fdwn';

      const result = parseDwnConnectUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe('https://notes.sh/dwn');
    });

    it('should parse a callback with query parameters', () => {
      const callback = 'https://app.example.com/dwn?session=abc123';
      const url = `dwn://connect?callback=${encodeURIComponent(callback)}`;

      const result = parseDwnConnectUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe(callback);
    });

    it('should parse a callback with a port', () => {
      const url = 'dwn://connect?callback=http%3A%2F%2Flocalhost%3A8080%2Fdwn';

      const result = parseDwnConnectUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe('http://localhost:8080/dwn');
    });

    it('should return undefined for a non-dwn scheme', () => {
      const result = parseDwnConnectUrl('https://register?callback=https%3A%2F%2Fnotes.sh');

      expect(result).toBeUndefined();
    });

    it('should return undefined for a different path', () => {
      const result = parseDwnConnectUrl('dwn://register?callback=https%3A%2F%2Fnotes.sh');

      expect(result).toBeUndefined();
    });

    it('should return undefined when the callback parameter is missing', () => {
      const result = parseDwnConnectUrl('dwn://connect?other=value');

      expect(result).toBeUndefined();
    });

    it('should return undefined when there are no query parameters', () => {
      const result = parseDwnConnectUrl('dwn://connect');

      expect(result).toBeUndefined();
    });

    it('should return undefined for an empty string', () => {
      const result = parseDwnConnectUrl('');

      expect(result).toBeUndefined();
    });

    it('should return undefined when the callback is empty', () => {
      const result = parseDwnConnectUrl('dwn://connect?callback=');

      expect(result).toBeUndefined();
    });

    it('should ignore extra query parameters and only extract callback', () => {
      const url = 'dwn://connect?extra=ignored&callback=https%3A%2F%2Fnotes.sh%2Fdwn&foo=bar';

      const result = parseDwnConnectUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe('https://notes.sh/dwn');
    });
  });

  describe('buildDwnConnectUrl', () => {
    it('should build a valid dwn://connect URL', () => {
      const url = buildDwnConnectUrl('https://notes.sh/dwn');

      expect(url).toBe('dwn://connect?callback=https%3A%2F%2Fnotes.sh%2Fdwn');
    });

    it('should encode query parameters in the callback', () => {
      const url = buildDwnConnectUrl('https://app.example.com/dwn?session=abc123');

      // The entire callback URL should be percent-encoded.
      expect(url).toContain('callback=');
      // Verify round-trip: parseDwnConnectUrl should recover the original callback.
      const parsed = parseDwnConnectUrl(url);
      expect(parsed).toBeDefined();
      expect(parsed!.callback).toBe('https://app.example.com/dwn?session=abc123');
    });

    it('should produce a URL that parseDwnConnectUrl can parse', () => {
      const callback = 'https://myapp.com/callback';
      const url = buildDwnConnectUrl(callback);
      const parsed = parseDwnConnectUrl(url);

      expect(parsed).toBeDefined();
      expect(parsed!.callback).toBe(callback);
    });
  });

  describe('buildDwnDiscoveryRedirectUrl', () => {
    it('should append the encoded payload as a URL fragment', () => {
      const callback = 'https://notes.sh/dwn';
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };

      const redirectUrl = buildDwnDiscoveryRedirectUrl(callback, payload);

      expect(redirectUrl).toContain('https://notes.sh/dwn#');
      // Verify the fragment decodes back to the payload.
      const fragment = redirectUrl.split('#')[1];
      const decoded = decodeDwnDiscoveryPayload(fragment);
      expect(decoded).toEqual(payload);
    });

    it('should strip an existing fragment from the callback before appending', () => {
      const callback = 'https://notes.sh/dwn#old-fragment';
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };

      const redirectUrl = buildDwnDiscoveryRedirectUrl(callback, payload);

      // Should not contain the old fragment.
      expect(redirectUrl).not.toContain('old-fragment');
      // Should have exactly one # separator.
      const parts = redirectUrl.split('#');
      expect(parts).toHaveLength(2);
      expect(parts[0]).toBe('https://notes.sh/dwn');
    });

    it('should preserve query parameters in the callback', () => {
      const callback = 'https://notes.sh/dwn?session=abc';
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };

      const redirectUrl = buildDwnDiscoveryRedirectUrl(callback, payload);

      expect(redirectUrl).toContain('?session=abc');
      expect(redirectUrl).toContain('#');
    });
  });

  describe('readDwnDiscoveryPayloadFromUrl', () => {
    it('should extract and decode the payload from a full URL with a fragment', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };
      const redirectUrl = buildDwnDiscoveryRedirectUrl('https://notes.sh/dwn', payload);

      const result = readDwnDiscoveryPayloadFromUrl(redirectUrl);

      expect(result).toEqual(payload);
    });

    it('should decode a bare fragment string without the leading #', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };
      const encoded = encodeDwnDiscoveryPayload(payload);

      const result = readDwnDiscoveryPayloadFromUrl(encoded);

      expect(result).toEqual(payload);
    });

    it('should decode a fragment string with a leading #', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };
      const encoded = encodeDwnDiscoveryPayload(payload);

      // Simulate window.location.hash which includes the leading #.
      const result = readDwnDiscoveryPayloadFromUrl(`#${encoded}`);

      expect(result).toEqual(payload);
    });

    it('should return undefined for a URL with an empty fragment', () => {
      const result = readDwnDiscoveryPayloadFromUrl('https://notes.sh/dwn#');

      expect(result).toBeUndefined();
    });

    it('should return undefined for a URL with no fragment', () => {
      const result = readDwnDiscoveryPayloadFromUrl('https://notes.sh/dwn');

      // This tries to decode the full URL as base64url — which will fail.
      expect(result).toBeUndefined();
    });

    it('should return undefined for a URL with an invalid fragment', () => {
      const result = readDwnDiscoveryPayloadFromUrl('https://notes.sh/dwn#not-valid-payload');

      expect(result).toBeUndefined();
    });
  });

  describe('end-to-end: connect URL → redirect → payload extraction', () => {
    it('should complete the full dwn://connect flow', () => {
      // 1. Web app builds the connect URL.
      const callback = 'https://notes.sh/dwn';
      const connectUrl = `${DWN_PROTOCOL_SCHEME}://${DWN_CONNECT_PATH}?callback=${encodeURIComponent(callback)}`;

      // 2. electrobun-dwn parses the connect URL.
      const params = parseDwnConnectUrl(connectUrl);
      expect(params).toBeDefined();
      expect(params!.callback).toBe(callback);

      // 3. electrobun-dwn builds the redirect URL with the DWN endpoint.
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:55557' };
      const redirectUrl = buildDwnDiscoveryRedirectUrl(params!.callback, payload);

      // 4. The browser callback page reads the payload from the fragment.
      const extracted = readDwnDiscoveryPayloadFromUrl(redirectUrl);
      expect(extracted).toEqual(payload);
    });
  });
});
