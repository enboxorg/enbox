import type { Jwk } from '../../src/jose/jwk.js';

import { describe, expect, it } from 'bun:test';

import { X25519Algorithm } from '../../src/algorithms/x25519.js';

describe('X25519Algorithm', () => {
  const algorithm = new X25519Algorithm();

  describe('generateKey()', () => {
    it('should generate a valid X25519 private key in JWK format', async () => {
      const key = await algorithm.generateKey({ algorithm: 'X25519' });

      expect(key).toBeDefined();
      expect(key.kty).toBe('OKP');
      expect(key.crv).toBe('X25519');
      expect(key.d).toBeDefined();
      expect(key.x).toBeDefined();
      expect(key.kid).toBeDefined();
    });

    it('should throw CryptoError for unsupported algorithm', async () => {
      await expect(
        // @ts-expect-error because an unsupported algorithm is being tested.
        algorithm.generateKey({ algorithm: 'Ed25519' })
      ).rejects.toThrow('Algorithm not supported');
    });
  });

  describe('getPublicKey()', () => {
    it('should derive the public key from a private key', async () => {
      const privateKey = await algorithm.generateKey({ algorithm: 'X25519' });

      const publicKey = await algorithm.getPublicKey({ key: privateKey });

      expect(publicKey.kty).toBe('OKP');
      expect(publicKey.crv).toBe('X25519');
      expect(publicKey.x).toBe(privateKey.x);
      expect(publicKey).not.toHaveProperty('d');
    });

    it('should throw TypeError when key is not an OKP private JWK', async () => {
      const invalidKey: Jwk = { kty: 'EC', crv: 'P-256', x: 'test' };

      await expect(
        algorithm.getPublicKey({ key: invalidKey })
      ).rejects.toThrow('Invalid key provided');
    });

    it('should throw CryptoError for unsupported OKP curve', async () => {
      const wrongCurveKey: Jwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-x-value',
        d   : 'base64url-d-value',
      };

      await expect(
        algorithm.getPublicKey({ key: wrongCurveKey })
      ).rejects.toThrow('Unsupported curve');
    });
  });

  describe('computePublicKey()', () => {
    it('should compute the public key from a private key', async () => {
      const privateKey = await algorithm.generateKey({ algorithm: 'X25519' });

      const publicKey = await algorithm.computePublicKey({ key: privateKey });

      expect(publicKey.kty).toBe('OKP');
      expect(publicKey.crv).toBe('X25519');
      expect(publicKey.x).toBeDefined();
      expect(publicKey).not.toHaveProperty('d');
    });

    it('should throw TypeError when key is not an OKP private JWK', async () => {
      const invalidKey: Jwk = { kty: 'EC', crv: 'P-256', x: 'test' };

      await expect(
        algorithm.computePublicKey({ key: invalidKey })
      ).rejects.toThrow('Invalid key provided');
    });

    it('should throw CryptoError for unsupported OKP curve', async () => {
      const wrongCurveKey: Jwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-x-value',
        d   : 'base64url-d-value',
      };

      await expect(
        algorithm.computePublicKey({ key: wrongCurveKey })
      ).rejects.toThrow('Unsupported curve');
    });
  });

  describe('bytesToPrivateKey()', () => {
    it('should convert raw private key bytes to JWK format', async () => {
      // Generate a key, convert to bytes, then convert back.
      const originalKey = await algorithm.generateKey({ algorithm: 'X25519' });
      const privateKeyBytes = await algorithm.privateKeyToBytes({ privateKey: originalKey });

      const convertedKey = await algorithm.bytesToPrivateKey({
        algorithm: 'X25519',
        privateKeyBytes,
      });

      expect(convertedKey.kty).toBe('OKP');
      expect(convertedKey.crv).toBe('X25519');
      expect(convertedKey.d).toBeDefined();
      expect(convertedKey.x).toBeDefined();
    });

    it('should throw CryptoError for unsupported algorithm', async () => {
      const dummyBytes = new Uint8Array(32);

      await expect(
        // @ts-expect-error because an unsupported algorithm is being tested.
        algorithm.bytesToPrivateKey({ algorithm: 'Ed25519', privateKeyBytes: dummyBytes })
      ).rejects.toThrow('Algorithm not supported');
    });
  });

  describe('privateKeyToBytes()', () => {
    it('should convert a JWK private key to raw bytes', async () => {
      const key = await algorithm.generateKey({ algorithm: 'X25519' });

      const bytes = await algorithm.privateKeyToBytes({ privateKey: key });

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes).toHaveLength(32);
    });

    it('should throw when provided a non-OKP private key', async () => {
      const invalidKey: Jwk = { kty: 'EC', crv: 'P-256', x: 'test' };

      await expect(
        algorithm.privateKeyToBytes({ privateKey: invalidKey })
      ).rejects.toThrow('not a valid OKP private key');
    });
  });
});
