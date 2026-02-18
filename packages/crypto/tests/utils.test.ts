import type { Jwk } from '../src/jose/jwk.js';

import { describe, expect, it } from 'bun:test';

import { CryptoUtils } from '../src/utils.js';

describe('Crypto Utils', () => {
  describe('getJoseSignatureAlgorithmFromPublicKey()', () => {
    it('returns the algorithm specified by the alg property regardless of the crv property', () => {
      const publicKey: Jwk = { kty: 'OKP', alg: 'EdDSA', crv: 'P-256' };
      expect(CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toBe('EdDSA');
    });

    it('returns the correct algorithm for Ed25519 curve', () => {
      const publicKey: Jwk = { kty: 'OKP', crv: 'Ed25519' };
      expect(CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toBe('EdDSA');
    });

    it('returns the correct algorithm for P-256 curve', () => {
      const publicKey: Jwk = { kty: 'EC', crv: 'P-256' };
      expect(CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toBe('ES256');
    });

    it('returns the correct algorithm for P-384 curve', () => {
      const publicKey: Jwk = { kty: 'EC', crv: 'P-384' };
      expect(CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toBe('ES384');
    });

    it('returns the correct algorithm for P-521 curve', () => {
      const publicKey: Jwk = { kty: 'EC', crv: 'P-521' };
      expect(CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toBe('ES512');
    });

    it('throws an error for unsupported algorithms', () => {
      const publicKey: Jwk = { kty: 'EC', alg: 'UnsupportedAlgorithm' };
      expect(() => CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toThrow();
    });

    it('throws an error for unsupported curves', () => {
      const publicKey: Jwk = { kty: 'EC', crv: 'UnsupportedCurve' };
      expect(() => CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toThrow();
    });

    it('throws an error when neither alg nor crv is provided', () => {
      const publicKey: Jwk = { kty: 'EC' };
      expect(() => CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey)).toThrow();
    });
  });

  describe('randomBytes()', () => {
    it('returns a Uint8Array of the specified length', () => {
      const length = 16;
      const result = CryptoUtils.randomBytes(length);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toHaveLength(length);
    });

    it('handles invalid input gracefully', () => {
      expect(() => CryptoUtils.randomBytes(-1)).toThrow('length'); // Length cannot be negative.
    });

    it('produces unique values on each call', () => {
      const set = new Set();
      for (let i = 0; i < 100; i++) {
        set.add(CryptoUtils.randomBytes(10).toString());
      }
      expect(set.size).toBe(100);
    });
  });

  describe('randomUuid()', () => {
    it('generates a valid v4 UUID', () => {
      const id = CryptoUtils.randomUuid();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(id).toHaveLength(36);
    });

    it('produces unique values on each call', () => {
      const set = new Set();
      for (let i = 0; i < 100; i++) {
        set.add(CryptoUtils.randomUuid());
      }
      expect(set.size).toBe(100);
    });
  });

  describe('randomPin', () => {
    it('generates a 3-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 3 });
      expect(pin).toMatch(/^\d{3}$/);
    });

    it('generates a 4-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 4 });
      expect(pin).toMatch(/^\d{4}$/);
    });

    it('generates a 5-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 5 });
      expect(pin).toMatch(/^\d{5}$/);
    });

    it('generates a 6-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 6 });
      expect(pin).toMatch(/^\d{6}$/);
    });

    it('generates a 7-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 7 });
      expect(pin).toMatch(/^\d{7}$/);
    });

    it('generates an 8-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 8 });
      expect(pin).toMatch(/^\d{8}$/);
    });

    it('generates an 9-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 9 });
      expect(pin).toMatch(/^\d{9}$/);
    });

    it('generates an 10-digit PIN', () => {
      const pin = CryptoUtils.randomPin({ length: 10 });
      expect(pin).toMatch(/^\d{10}$/);
    });

    it('throws an error for a PIN length less than 3', () => {
      expect(
        () => CryptoUtils.randomPin({ length: 2 })
      ).toThrow('randomPin() can securely generate a PIN between 3 to 10 digits.');
    });

    it('throws an error for a PIN length greater than 10', () => {
      expect(
        () => CryptoUtils.randomPin({ length: 11 })
      ).toThrow('randomPin() can securely generate a PIN between 3 to 10 digits.');
    });
  });
});
