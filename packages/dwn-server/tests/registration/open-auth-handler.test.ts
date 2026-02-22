import * as jose from 'jose';
import { describe, expect, it } from 'bun:test';

import { OpenAuthHandler } from '../../src/registration/open-auth-handler.js';

describe('OpenAuthHandler', () => {
  const secret = 'test-secret-that-is-long-enough-for-hs256';
  const issuer = 'https://dwn.example.com';

  describe('handleAuthorize()', () => {
    it('should return a code and redirect URI', () => {
      const handler = OpenAuthHandler.create(secret, issuer);
      const url = new URL('https://dwn.example.com/provider-auth/authorize?redirect_uri=https://wallet.example.com/callback&state=abc123');

      const response = handler.handleAuthorize(url);
      expect(response.status).toBe(200);

      const body = response.json();
      return body.then((data: any): void => {
        expect(data.code).toBeDefined();
        expect(data.state).toBe('abc123');
        expect(data.redirectUri).toContain('code=');
        expect(data.redirectUri).toContain('state=abc123');
      });
    });

    it('should return 400 when redirect_uri is missing', () => {
      const handler = OpenAuthHandler.create(secret, issuer);
      const url = new URL('https://dwn.example.com/provider-auth/authorize?state=abc123');

      const response = handler.handleAuthorize(url);
      expect(response.status).toBe(400);
    });

    it('should work without a state parameter', () => {
      const handler = OpenAuthHandler.create(secret, issuer);
      const url = new URL('https://dwn.example.com/provider-auth/authorize?redirect_uri=https://wallet.example.com/callback');

      const response = handler.handleAuthorize(url);
      expect(response.status).toBe(200);

      return response.json().then((data: any): void => {
        expect(data.code).toBeDefined();
        expect(data.state).toBeUndefined();
      });
    });
  });

  describe('handleToken()', () => {
    it('should exchange a valid code for JWT tokens', async () => {
      const handler = OpenAuthHandler.create(secret, issuer);
      const redirectUri = 'https://wallet.example.com/callback';

      // First, get a code.
      const authorizeUrl = new URL(`https://dwn.example.com/provider-auth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz`);
      const authorizeResponse = await handler.handleAuthorize(authorizeUrl).json() as any;
      const code = authorizeResponse.code;

      // Exchange the code.
      const tokenRequest = new Request('https://dwn.example.com/provider-auth/token', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ code, redirectUri }),
      });

      const tokenResponse = await handler.handleToken(tokenRequest);
      expect(tokenResponse.status).toBe(200);

      const tokenData = await tokenResponse.json() as any;
      expect(tokenData.registrationToken).toBeDefined();
      expect(tokenData.refreshToken).toBeDefined();
      expect(tokenData.expiresIn).toBeGreaterThan(0);
      expect(tokenData.tokenType).toBe('bearer');

      // Verify the JWT is valid.
      const { payload } = await jose.jwtVerify(
        tokenData.registrationToken,
        new TextEncoder().encode(secret),
        { issuer },
      );
      expect(payload.sub).toBeDefined();
      expect(payload.purpose).toBe('registration');
    });

    it('should reject an invalid code', async () => {
      const handler = OpenAuthHandler.create(secret, issuer);

      const tokenRequest = new Request('https://dwn.example.com/provider-auth/token', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ code: 'invalid-code', redirectUri: 'https://wallet.example.com/callback' }),
      });

      const tokenResponse = await handler.handleToken(tokenRequest);
      expect(tokenResponse.status).toBe(400);
    });

    it('should reject a code with mismatched redirect_uri', async () => {
      const handler = OpenAuthHandler.create(secret, issuer);

      // Get a code with one redirect_uri.
      const authorizeUrl = new URL('https://dwn.example.com/provider-auth/authorize?redirect_uri=https://wallet.example.com/callback');
      const authorizeResponse = await handler.handleAuthorize(authorizeUrl).json() as any;

      // Try to exchange with a different redirect_uri.
      const tokenRequest = new Request('https://dwn.example.com/provider-auth/token', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ code: authorizeResponse.code, redirectUri: 'https://evil.example.com/callback' }),
      });

      const tokenResponse = await handler.handleToken(tokenRequest);
      expect(tokenResponse.status).toBe(400);
    });

    it('should not allow code reuse', async () => {
      const handler = OpenAuthHandler.create(secret, issuer);
      const redirectUri = 'https://wallet.example.com/callback';

      const authorizeUrl = new URL(`https://dwn.example.com/provider-auth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
      const authorizeResponse = await handler.handleAuthorize(authorizeUrl).json() as any;
      const code = authorizeResponse.code;

      // First exchange succeeds.
      const firstRequest = new Request('https://dwn.example.com/provider-auth/token', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ code, redirectUri }),
      });
      const firstResponse = await handler.handleToken(firstRequest);
      expect(firstResponse.status).toBe(200);

      // Second exchange with same code fails.
      const secondRequest = new Request('https://dwn.example.com/provider-auth/token', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ code, redirectUri }),
      });
      const secondResponse = await handler.handleToken(secondRequest);
      expect(secondResponse.status).toBe(400);
    });
  });

  describe('handleRefresh()', () => {
    it('should issue new tokens from a valid refresh token', async () => {
      const handler = OpenAuthHandler.create(secret, issuer);
      const redirectUri = 'https://wallet.example.com/callback';

      // Get code → exchange → get refresh token.
      const authorizeUrl = new URL(`https://dwn.example.com/provider-auth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
      const authorizeResponse = await handler.handleAuthorize(authorizeUrl).json() as any;

      const tokenRequest = new Request('https://dwn.example.com/provider-auth/token', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ code: authorizeResponse.code, redirectUri }),
      });
      const tokenData = await (await handler.handleToken(tokenRequest)).json() as any;

      // Use refresh token to get new tokens.
      const refreshRequest = new Request('https://dwn.example.com/provider-auth/refresh', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ refreshToken: tokenData.refreshToken }),
      });
      const refreshResponse = await handler.handleRefresh(refreshRequest);
      expect(refreshResponse.status).toBe(200);

      const refreshedData = await refreshResponse.json() as any;
      expect(refreshedData.registrationToken).toBeDefined();
      expect(refreshedData.refreshToken).toBeDefined();
      expect(refreshedData.expiresIn).toBeGreaterThan(0);

      // Verify the refreshed registration token is a valid JWT.
      const { payload } = await jose.jwtVerify(
        refreshedData.registrationToken,
        new TextEncoder().encode(secret),
        { issuer },
      );
      expect(payload.purpose).toBe('registration');
      expect(payload.sub).toBeDefined();
    });

    it('should reject an invalid refresh token', async () => {
      const handler = OpenAuthHandler.create(secret, issuer);

      const refreshRequest = new Request('https://dwn.example.com/provider-auth/refresh', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ refreshToken: 'invalid-token' }),
      });
      const refreshResponse = await handler.handleRefresh(refreshRequest);
      expect(refreshResponse.status).toBe(400);
    });

    it('should reject a registration token used as a refresh token', async () => {
      const handler = OpenAuthHandler.create(secret, issuer);
      const redirectUri = 'https://wallet.example.com/callback';

      // Get a registration token.
      const authorizeUrl = new URL(`https://dwn.example.com/provider-auth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
      const authorizeResponse = await handler.handleAuthorize(authorizeUrl).json() as any;
      const tokenRequest = new Request('https://dwn.example.com/provider-auth/token', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ code: authorizeResponse.code, redirectUri }),
      });
      const tokenData = await (await handler.handleToken(tokenRequest)).json() as any;

      // Try using the registration token as a refresh token.
      const refreshRequest = new Request('https://dwn.example.com/provider-auth/refresh', {
        method  : 'POST',
        headers : { 'content-type': 'application/json' },
        body    : JSON.stringify({ refreshToken: tokenData.registrationToken }),
      });
      const refreshResponse = await handler.handleRefresh(refreshRequest);
      expect(refreshResponse.status).toBe(400);

      const errorBody = await refreshResponse.json() as any;
      expect(errorBody.error).toContain('not a refresh token');
    });
  });
});
