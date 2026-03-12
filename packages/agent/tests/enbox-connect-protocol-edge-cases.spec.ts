import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';

describe('EnboxConnectProtocol — edge cases', () => {
  describe('buildOidcUrl', () => {
    it('should build pushedAuthorizationRequest URL', () => {
      const url = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'https://auth.example.com',
        endpoint : 'pushedAuthorizationRequest',
      });
      expect(url).toBe('https://auth.example.com/par');
    });

    it('should build authorize URL with authParam', () => {
      const url = EnboxConnectProtocol.buildConnectUrl({
        baseURL   : 'https://auth.example.com',
        endpoint  : 'authorize',
        authParam : 'abc123',
      });
      expect(url).toBe('https://auth.example.com/authorize/abc123.jwt');
    });

    it('should throw when authorize endpoint has no authParam', () => {
      expect((): string => EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'https://auth.example.com',
        endpoint : 'authorize',
      })).toThrow('authParam must be provided when building an authorize URL');
    });

    it('should build callback URL', () => {
      const url = EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'https://auth.example.com',
        endpoint : 'callback',
      });
      expect(url).toBe('https://auth.example.com/callback');
    });

    it('should build token URL with tokenParam', () => {
      const url = EnboxConnectProtocol.buildConnectUrl({
        baseURL    : 'https://auth.example.com',
        endpoint   : 'token',
        tokenParam : 'xyz789',
      });
      expect(url).toBe('https://auth.example.com/token/xyz789.jwt');
    });

    it('should throw when token endpoint has no tokenParam', () => {
      expect((): string => EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'https://auth.example.com',
        endpoint : 'token',
      })).toThrow('tokenParam must be provided when building a token URL');
    });

    it('should throw for unknown endpoint', () => {
      expect((): string => EnboxConnectProtocol.buildConnectUrl({
        baseURL  : 'https://auth.example.com',
        endpoint : 'unknown' as any,
      })).toThrow('Unknown connect endpoint:');
    });
  });

  // generateCodeChallenge tests removed — PKCE was never functional and has been stripped.

  describe('verifyJwt', () => {
    it('should throw when JWT header is missing kid', async () => {
      // Build a JWT with no kid in header
      const header = Convert.object({ alg: 'EdDSA' }).toBase64Url();
      const payload = Convert.object({ test: true }).toBase64Url();
      const fakeJwt = `${header}.${payload}.fakesignature`;

      await expect(EnboxConnectProtocol.verifyJwt({ jwt: fakeJwt })).rejects.toThrow('missing required "kid"');
    });

    it('should throw when DID resolution fails', async () => {
      // Build a JWT with a kid that can't be resolved
      const header = Convert.object({ alg: 'EdDSA', kid: 'did:jwk:invalid#0' }).toBase64Url();
      const payload = Convert.object({ test: true }).toBase64Url();
      const fakeJwt = `${header}.${payload}.fakesignature`;

      await expect(EnboxConnectProtocol.verifyJwt({ jwt: fakeJwt })).rejects.toThrow();
    });

    it('should verify a valid JWT signed by a did:jwk', async () => {
      const { DidJwk } = await import('@enbox/dids');
      const didJwk = await DidJwk.create();

      // Create a JWT signed by the DID
      const jwt = await EnboxConnectProtocol.signJwt({ did: didJwk, data: { test: 'value' } });
      expect(jwt).toBeDefined();

      // Verify it
      const result = await EnboxConnectProtocol.verifyJwt({ jwt: jwt! });
      expect(result).toBeDefined();
      expect(result.test).toBe('value');
    });

    it('should throw when signature is invalid', async () => {
      const { DidJwk } = await import('@enbox/dids');
      const didJwk = await DidJwk.create();

      const jwt = await EnboxConnectProtocol.signJwt({ did: didJwk, data: { test: 'value' } });
      expect(jwt).toBeDefined();

      // Tamper with the signature
      const parts = jwt!.split('.');
      parts[2] = Convert.uint8Array(new Uint8Array(64)).toBase64Url();
      const tamperedJwt = parts.join('.');

      await expect(EnboxConnectProtocol.verifyJwt({ jwt: tamperedJwt })).rejects.toThrow('invalid signature');
    });
  });
});
