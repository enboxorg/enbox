import { describe, expect, it } from 'bun:test';

import type { DwnDiscoveryPayload } from '../src/dwn-discovery-payload.js';

import { Convert } from '@enbox/common';
import {
  buildDwnDiscoveryRedirectUrl,
  decodeDwnDiscoveryPayload,
  DWN_PROTOCOL_SCHEME,
  DWN_REGISTER_PATH,
  encodeDwnDiscoveryPayload,
  parseDwnRegisterUrl,
  readDwnDiscoveryPayloadFromUrl,
} from '../src/dwn-discovery-payload.js';

// ─── Tests ───────────────────────────────────────────────────────

describe('DwnDiscoveryPayload', () => {
  describe('constants', () => {
    it('should export the dwn protocol scheme', () => {
      expect(DWN_PROTOCOL_SCHEME).toBe('dwn');
    });

    it('should export the register path', () => {
      expect(DWN_REGISTER_PATH).toBe('register');
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

    it('should round-trip a payload with an https endpoint', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'https://dwn.example.com' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it('should round-trip a payload with unicode in the endpoint path', () => {
      const payload: DwnDiscoveryPayload = { endpoint: 'http://127.0.0.1:3000/caf\u00e9' };

      const encoded = encodeDwnDiscoveryPayload(payload);
      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it('should return undefined for an empty string', () => {
      const decoded = decodeDwnDiscoveryPayload('');

      expect(decoded).toBeUndefined();
    });

    it('should return undefined for garbage input', () => {
      const decoded = decodeDwnDiscoveryPayload('!!!not-base64!!!');

      expect(decoded).toBeUndefined();
    });

    it('should return undefined for valid base64url that is not JSON', () => {
      const encoded = Convert.string('hello world').toBase64Url();

      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toBeUndefined();
    });

    it('should return undefined for valid JSON missing the endpoint field', () => {
      const encoded = Convert.string(JSON.stringify({ foo: 'bar' })).toBase64Url();

      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toBeUndefined();
    });

    it('should return undefined for valid JSON with an empty endpoint', () => {
      const encoded = Convert.string(JSON.stringify({ endpoint: '' })).toBase64Url();

      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toBeUndefined();
    });

    it('should return undefined for valid JSON with a numeric endpoint', () => {
      const encoded = Convert.string(JSON.stringify({ endpoint: 12345 })).toBase64Url();

      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toBeUndefined();
    });

    it('should return undefined for valid JSON with a null value', () => {
      const encoded = Convert.string('null').toBase64Url();

      const decoded = decodeDwnDiscoveryPayload(encoded);

      expect(decoded).toBeUndefined();
    });
  });

  describe('parseDwnRegisterUrl', () => {
    it('should parse a valid dwn://register URL', () => {
      const url = 'dwn://register?callback=https%3A%2F%2Fnotes.sh%2Fdwn';

      const result = parseDwnRegisterUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe('https://notes.sh/dwn');
    });

    it('should parse a callback with query parameters', () => {
      const callback = 'https://app.example.com/dwn?session=abc123';
      const url = `dwn://register?callback=${encodeURIComponent(callback)}`;

      const result = parseDwnRegisterUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe(callback);
    });

    it('should parse a callback with a port', () => {
      const url = 'dwn://register?callback=http%3A%2F%2Flocalhost%3A8080%2Fdwn';

      const result = parseDwnRegisterUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe('http://localhost:8080/dwn');
    });

    it('should return undefined for a non-dwn scheme', () => {
      const result = parseDwnRegisterUrl('https://register?callback=https%3A%2F%2Fnotes.sh');

      expect(result).toBeUndefined();
    });

    it('should return undefined for a different path', () => {
      const result = parseDwnRegisterUrl('dwn://connect?callback=https%3A%2F%2Fnotes.sh');

      expect(result).toBeUndefined();
    });

    it('should return undefined when the callback parameter is missing', () => {
      const result = parseDwnRegisterUrl('dwn://register?other=value');

      expect(result).toBeUndefined();
    });

    it('should return undefined when there are no query parameters', () => {
      const result = parseDwnRegisterUrl('dwn://register');

      expect(result).toBeUndefined();
    });

    it('should return undefined for an empty string', () => {
      const result = parseDwnRegisterUrl('');

      expect(result).toBeUndefined();
    });

    it('should return undefined when the callback is empty', () => {
      const result = parseDwnRegisterUrl('dwn://register?callback=');

      expect(result).toBeUndefined();
    });

    it('should ignore extra query parameters and only extract callback', () => {
      const url = 'dwn://register?extra=ignored&callback=https%3A%2F%2Fnotes.sh%2Fdwn&foo=bar';

      const result = parseDwnRegisterUrl(url);

      expect(result).toBeDefined();
      expect(result!.callback).toBe('https://notes.sh/dwn');
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
      expect(parts.length).toBe(2);
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

  describe('end-to-end: register URL → redirect → payload extraction', () => {
    it('should complete the full dwn://register flow', () => {
      // 1. Web app builds the register URL.
      const callback = 'https://notes.sh/dwn';
      const registerUrl = `${DWN_PROTOCOL_SCHEME}://register?callback=${encodeURIComponent(callback)}`;

      // 2. electrobun-dwn parses the register URL.
      const params = parseDwnRegisterUrl(registerUrl);
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
