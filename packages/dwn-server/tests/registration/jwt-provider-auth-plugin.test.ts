import * as jose from 'jose';
import { describe, expect, it } from 'bun:test';

import { JwtProviderAuthPlugin } from '../../src/registration/jwt-provider-auth-plugin.js';

describe('JwtProviderAuthPlugin', () => {
  const secret = 'test-secret-that-is-long-enough-for-hs256';

  describe('create()', () => {
    it('should create a plugin with an HMAC secret', async () => {
      const plugin = await JwtProviderAuthPlugin.create({ secret });
      expect(plugin).toBeDefined();
    });

    it('should create a plugin with a JWKS URL', async () => {
      // Start a minimal JWKS server using Bun.serve.
      const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
      const publicJwk = await jose.exportJWK(publicKey);
      publicJwk.kid = 'test-key-1';
      publicJwk.alg = 'RS256';
      publicJwk.use = 'sig';
      const jwks = { keys: [publicJwk] };

      const jwksServer = Bun.serve({
        port: 0,
        fetch(): Response {
          return Response.json(jwks);
        },
      });

      try {
        const jwksUrl = `http://localhost:${jwksServer.port}/.well-known/jwks.json`;
        const plugin = await JwtProviderAuthPlugin.create({ jwksUrl });
        expect(plugin).toBeDefined();

        // Sign a JWT with the private key and verify it.
        const token = await new jose.SignJWT({ purpose: 'registration' })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
          .setSubject('jwks-account')
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey);

        const result = await plugin.validateRegistrationToken(token);
        expect(result.isValid).toBe(true);
        expect(result.accountId).toBe('jwks-account');
      } finally {
        jwksServer.stop(true);
      }
    });

    it('should throw when neither secret nor jwksUrl is provided', async () => {
      await expect(JwtProviderAuthPlugin.create({})).rejects.toThrow(
        'exactly one of `secret` or `jwksUrl`',
      );
    });
  });

  describe('validateRegistrationToken()', () => {
    it('should validate a valid JWT signed with the correct secret', async () => {
      const plugin = await JwtProviderAuthPlugin.create({ secret });

      const token = await new jose.SignJWT({ purpose: 'registration' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('account-123')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));

      const result = await plugin.validateRegistrationToken(token);
      expect(result.isValid).toBe(true);
      expect(result.accountId).toBe('account-123');
    });

    it('should reject a JWT signed with a different secret', async () => {
      const plugin = await JwtProviderAuthPlugin.create({ secret });

      const token = await new jose.SignJWT({ purpose: 'registration' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('account-123')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('wrong-secret-that-is-also-long-enough'));

      const result = await plugin.validateRegistrationToken(token);
      expect(result.isValid).toBe(false);
      expect(result.detail).toBeDefined();
    });

    it('should reject an expired JWT', async () => {
      const plugin = await JwtProviderAuthPlugin.create({ secret });

      const token = await new jose.SignJWT({ purpose: 'registration' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('account-123')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(new TextEncoder().encode(secret));

      const result = await plugin.validateRegistrationToken(token);
      expect(result.isValid).toBe(false);
      expect(result.detail).toContain('exp');
    });

    it('should reject a malformed token', async () => {
      const plugin = await JwtProviderAuthPlugin.create({ secret });

      const result = await plugin.validateRegistrationToken('not-a-jwt');
      expect(result.isValid).toBe(false);
      expect(result.detail).toBeDefined();
    });

    it('should extract metadata from JWT payload', async () => {
      const plugin = await JwtProviderAuthPlugin.create({ secret });

      const token = await new jose.SignJWT({
        purpose  : 'registration',
        metadata : { plan: 'pro', quota: 1000 },
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('account-456')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));

      const result = await plugin.validateRegistrationToken(token);
      expect(result.isValid).toBe(true);
      expect(result.accountId).toBe('account-456');
      expect(result.metadata).toEqual({ plan: 'pro', quota: 1000 });
    });

    it('should validate issuer when configured', async () => {
      const plugin = await JwtProviderAuthPlugin.create({
        secret,
        issuer: 'https://dwn.example.com',
      });

      // Token with correct issuer.
      const validToken = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('https://dwn.example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));

      const validResult = await plugin.validateRegistrationToken(validToken);
      expect(validResult.isValid).toBe(true);

      // Token with wrong issuer.
      const invalidToken = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('https://wrong.example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));

      const invalidResult = await plugin.validateRegistrationToken(invalidToken);
      expect(invalidResult.isValid).toBe(false);
    });

    it('should validate audience when configured', async () => {
      const plugin = await JwtProviderAuthPlugin.create({
        secret,
        audience: 'https://dwn.example.com',
      });

      // Token with correct audience.
      const validToken = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('https://dwn.example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));

      const validResult = await plugin.validateRegistrationToken(validToken);
      expect(validResult.isValid).toBe(true);

      // Token with wrong audience.
      const invalidToken = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('https://wrong.example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));

      const invalidResult = await plugin.validateRegistrationToken(invalidToken);
      expect(invalidResult.isValid).toBe(false);
    });

    it('should return undefined accountId when sub claim is missing', async () => {
      const plugin = await JwtProviderAuthPlugin.create({ secret });

      const token = await new jose.SignJWT({ purpose: 'registration' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));

      const result = await plugin.validateRegistrationToken(token);
      expect(result.isValid).toBe(true);
      expect(result.accountId).toBeUndefined();
    });
  });
});
