import type { Jwk } from '../../src/jose/jwk.js';

import { describe, expect, it } from 'bun:test';

import { jwkToThumbprintTestVectors } from '../fixtures/test-vectors/jwk.js';
import {
  computeJwkThumbprint,
  isEcPrivateJwk,
  isEcPublicJwk,
  isOctPrivateJwk,
  isOkpPrivateJwk,
  isOkpPublicJwk,
  isPrivateJwk,
  isPublicJwk,
} from '../../src/jose/jwk.js';

describe('JWK', () => {
  describe('computeJwkThumbprint()', () => {
    it('passes all test vectors', async () => {
      let jwkThumbprint: string;

      for (const vector of jwkToThumbprintTestVectors) {
        jwkThumbprint = await computeJwkThumbprint({ jwk: vector.input as Jwk });
        expect(jwkThumbprint).toBe(vector.output);
      }
    });

    it('throws an error if unsupported key type has been passed', async () => {
      await expect(
        // @ts-expect-error because an invalid key type is being intentionally passed.
        computeJwkThumbprint({ jwk: { crv: 'X25519', kty: 'unsupported' } })
      ).rejects.toThrow(`Unsupported key type: unsupported`);
    });
  });

  describe('isEcPrivateJwk()', () => {
    it('returns true for a valid EC private key JWK', () => {
      const validEcJwk = {
        kty : 'EC',
        crv : 'P-256',
        x   : 'base64url-encoded-x-value',
        d   : 'base64url-encoded-private-key'
      };
      expect(isEcPrivateJwk(validEcJwk)).toBe(true);
    });

    it('returns false for non-object inputs', () => {
      expect(isEcPrivateJwk(null)).toBe(false);
      expect(isEcPrivateJwk(undefined)).toBe(false);
      expect(isEcPrivateJwk(123)).toBe(false);
      expect(isEcPrivateJwk('string')).toBe(false);
      expect(isEcPrivateJwk([])).toBe(false);
    });

    it('returns false if any required property is missing', () => {
      const missingKty = { crv: 'P-256', x: 'base64url-encoded-x-value', d: 'base64url-encoded-private-key' };
      const missingCrv = { kty: 'EC', x: 'base64url-encoded-x-value', d: 'base64url-encoded-private-key' };
      const missingX = { kty: 'EC', crv: 'P-256', d: 'base64url-encoded-private-key' };
      const missingD = { kty: 'EC', crv: 'P-256', x: 'base64url-encoded-x-value' };

      expect(isEcPrivateJwk(missingKty)).toBe(false);
      expect(isEcPrivateJwk(missingCrv)).toBe(false);
      expect(isEcPrivateJwk(missingX)).toBe(false);
      expect(isEcPrivateJwk(missingD)).toBe(false);
    });

    it('returns false if kty is not EC', () => {
      const invalidKty = { kty: 'RSA', crv: 'P-256', x: 'base64url-encoded-x-value', d: 'base64url-encoded-private-key' };
      expect(isEcPrivateJwk(invalidKty)).toBe(false);
    });

    it('returns false if any property is of incorrect type', () => {
      const invalidDType = { kty: 'EC', crv: 'P-256', x: 'base64url-encoded-x-value', d: 123 };
      const invalidXType = { kty: 'EC', crv: 'P-256', x: 123, d: 'base64url-encoded-private-key' };

      expect(isEcPrivateJwk(invalidDType)).toBe(false);
      expect(isEcPrivateJwk(invalidXType)).toBe(false);
    });

    it('returns true for valid EC JWK with extra properties', () => {
      const validEcJwkExtra = {
        kty   : 'EC',
        crv   : 'P-256',
        x     : 'base64url-encoded-x-value',
        d     : 'base64url-encoded-private-key',
        extra : 'extra-value'
      };
      expect(isEcPrivateJwk(validEcJwkExtra)).toBe(true);
    });
  });

  describe('isEcPublicJwk()', () => {
    it('returns true for a valid EC public key JWK', () => {
      const validEcJwk = {
        kty : 'EC',
        crv : 'P-256',
        x   : 'base64url-encoded-x-value'
      };
      expect(isEcPublicJwk(validEcJwk)).toBe(true);
    });

    it('returns false for non-object inputs', () => {
      expect(isEcPublicJwk(null)).toBe(false);
      expect(isEcPublicJwk(undefined)).toBe(false);
      expect(isEcPublicJwk(123)).toBe(false);
      expect(isEcPublicJwk('string')).toBe(false);
      expect(isEcPublicJwk([])).toBe(false);
    });

    it('returns false if any required property is missing', () => {
      const missingKty = { crv: 'P-256', x: 'base64url-encoded-x-value' };
      const missingCrv = { kty: 'EC', x: 'base64url-encoded-x-value' };
      const missingX = { kty: 'EC', crv: 'P-256' };

      expect(isEcPublicJwk(missingKty)).toBe(false);
      expect(isEcPublicJwk(missingCrv)).toBe(false);
      expect(isEcPublicJwk(missingX)).toBe(false);
    });

    it('returns false if kty is not EC', () => {
      const invalidKty = { kty: 'RSA', crv: 'P-256', x: 'base64url-encoded-x-value' };
      expect(isEcPublicJwk(invalidKty)).toBe(false);
    });

    it('returns false if any property is of incorrect type', () => {
      const invalidXType = { kty: 'EC', crv: 'P-256', x: 123 };

      expect(isEcPublicJwk(invalidXType)).toBe(false);
    });

    it('returns false if the private key parameter \'d\' is present', () => {
      const withDParam = { kty: 'EC', crv: 'P-256', x: 'base64url-encoded-x-value', d: 'base64url-encoded-d-value' };
      expect(isEcPublicJwk(withDParam)).toBe(false);
    });

    it('returns true for valid EC public JWK with extra properties', () => {
      const validEcJwkExtra = {
        kty   : 'EC',
        crv   : 'P-256',
        x     : 'base64url-encoded-x-value',
        extra : 'extra-value'
      };
      expect(isEcPublicJwk(validEcJwkExtra)).toBe(true);
    });
  });

  describe('isOctPrivateJwk()', () => {
    it('returns true for a valid OCT private key JWK', () => {
      const validOctJwk = {
        kty : 'oct',
        k   : 'base64url-encoded-key'
      };
      expect(isOctPrivateJwk(validOctJwk)).toBe(true);
    });

    it('returns false for non-object inputs', () => {
      expect(isOctPrivateJwk(null)).toBe(false);
      expect(isOctPrivateJwk(undefined)).toBe(false);
      expect(isOctPrivateJwk(123)).toBe(false);
      expect(isOctPrivateJwk('string')).toBe(false);
      expect(isOctPrivateJwk([])).toBe(false);
    });

    it('returns false if any required property is missing', () => {
      const missingKty = { k: 'base64url-encoded-key' };
      const missingK = { kty: 'oct' };

      expect(isOctPrivateJwk(missingKty)).toBe(false);
      expect(isOctPrivateJwk(missingK)).toBe(false);
    });

    it('returns false if kty is not oct', () => {
      const invalidKty = { kty: 'RSA', k: 'base64url-encoded-key' };
      expect(isOctPrivateJwk(invalidKty)).toBe(false);
    });

    it('returns false if any property is of incorrect type', () => {
      const invalidKType = { kty: 'oct', k: 123 };

      expect(isOctPrivateJwk(invalidKType)).toBe(false);
    });

    it('returns true for valid OCT private JWK with extra properties', () => {
      const validOctJwkExtra = {
        kty   : 'oct',
        k     : 'base64url-encoded-key',
        extra : 'extra-value'
      };
      expect(isOctPrivateJwk(validOctJwkExtra)).toBe(true);
    });
  });

  describe('isOkpPrivateJwk()', () => {
    it('returns true for a valid OKP private key JWK', () => {
      const validOkpJwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-encoded-x-value',
        d   : 'base64url-encoded-private-key'
      };
      expect(isOkpPrivateJwk(validOkpJwk)).toBe(true);
    });

    it('returns false for non-object inputs', () => {
      expect(isOkpPrivateJwk(null)).toBe(false);
      expect(isOkpPrivateJwk(undefined)).toBe(false);
      expect(isOkpPrivateJwk(123)).toBe(false);
      expect(isOkpPrivateJwk('string')).toBe(false);
      expect(isOkpPrivateJwk([])).toBe(false);
    });

    it('returns false if any required property is missing', () => {
      const missingKty = { crv: 'Ed25519', x: 'base64url-encoded-x-value', d: 'base64url-encoded-private-key' };
      const missingCrv = { kty: 'OKP', x: 'base64url-encoded-x-value', d: 'base64url-encoded-private-key' };
      const missingX = { kty: 'OKP', crv: 'Ed25519', d: 'base64url-encoded-private-key' };
      const missingD = { kty: 'OKP', crv: 'Ed25519', x: 'base64url-encoded-x-value' };

      expect(isOkpPrivateJwk(missingKty)).toBe(false);
      expect(isOkpPrivateJwk(missingCrv)).toBe(false);
      expect(isOkpPrivateJwk(missingX)).toBe(false);
      expect(isOkpPrivateJwk(missingD)).toBe(false);
    });

    it('returns false if kty is not OKP', () => {
      const invalidKty = { kty: 'EC', crv: 'Ed25519', x: 'base64url-encoded-x-value', d: 'base64url-encoded-private-key' };
      expect(isOkpPrivateJwk(invalidKty)).toBe(false);
    });

    it('returns false if any property is of incorrect type', () => {
      const invalidDType = { kty: 'OKP', crv: 'Ed25519', x: 'base64url-encoded-x-value', d: 123 };
      const invalidXType = { kty: 'OKP', crv: 'Ed25519', x: 123, d: 'base64url-encoded-private-key' };

      expect(isOkpPrivateJwk(invalidDType)).toBe(false);
      expect(isOkpPrivateJwk(invalidXType)).toBe(false);
    });

    it('returns true for valid OKP private JWK with extra properties', () => {
      const validOkpJwkExtra = {
        kty   : 'OKP',
        crv   : 'Ed25519',
        x     : 'base64url-encoded-x-value',
        d     : 'base64url-encoded-private-key',
        extra : 'extra-value'
      };
      expect(isOkpPrivateJwk(validOkpJwkExtra)).toBe(true);
    });
  });

  describe('isOkpPublicJwk()', () => {
    it('returns true for a valid OKP public key JWK', () => {
      const validOkpJwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-encoded-x-value'
      };
      expect(isOkpPublicJwk(validOkpJwk)).toBe(true);
    });

    it('returns false for non-object inputs', () => {
      expect(isOkpPublicJwk(null)).toBe(false);
      expect(isOkpPublicJwk(undefined)).toBe(false);
      expect(isOkpPublicJwk(123)).toBe(false);
      expect(isOkpPublicJwk('string')).toBe(false);
      expect(isOkpPublicJwk([])).toBe(false);
    });

    it('returns false if any required property is missing', () => {
      const missingKty = { crv: 'Ed25519', x: 'base64url-encoded-x-value' };
      const missingCrv = { kty: 'OKP', x: 'base64url-encoded-x-value' };
      const missingX = { kty: 'OKP', crv: 'Ed25519' };

      expect(isOkpPublicJwk(missingKty)).toBe(false);
      expect(isOkpPublicJwk(missingCrv)).toBe(false);
      expect(isOkpPublicJwk(missingX)).toBe(false);
    });

    it('returns false if kty is not OKP', () => {
      const invalidKty = { kty: 'EC', crv: 'Ed25519', x: 'base64url-encoded-x-value' };
      expect(isOkpPublicJwk(invalidKty)).toBe(false);
    });

    it('returns false if any property is of incorrect type', () => {
      const invalidXType = { kty: 'OKP', crv: 'Ed25519', x: 123 };

      expect(isOkpPublicJwk(invalidXType)).toBe(false);
    });

    it(`returns false if the private key parameter 'd' is present`, () => {
      const withDParam = { kty: 'OKP', crv: 'Ed25519', x: 'base64url-encoded-x-value', d: 'base64url-encoded-d-value' };
      expect(isOkpPublicJwk(withDParam)).toBe(false);
    });

    it('returns true for valid OKP public JWK with extra properties', () => {
      const validOkpJwkExtra = {
        kty   : 'OKP',
        crv   : 'Ed25519',
        x     : 'base64url-encoded-x-value',
        extra : 'extra-value'
      };
      expect(isOkpPublicJwk(validOkpJwkExtra)).toBe(true);
    });
  });

  describe('isPrivateJwk()', () => {
    it('returns true for a valid EC private key JWK', () => {
      const validEcJwk = {
        kty : 'EC',
        crv : 'P-256',
        x   : 'base64url-encoded-x-value',
        d   : 'base64url-encoded-private-key'
      };
      expect(isPrivateJwk(validEcJwk)).toBe(true);
    });

    it('returns true for a valid OKP private key JWK', () => {
      const validOkpJwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-encoded-x-value',
        d   : 'base64url-encoded-private-key'
      };
      expect(isPrivateJwk(validOkpJwk)).toBe(true);
    });

    it('returns true for a valid OCT private key JWK', () => {
      const validOctJwk = {
        kty : 'oct',
        k   : 'base64url-encoded-key'
      };
      expect(isPrivateJwk(validOctJwk)).toBe(true);
    });

    it('returns true for a valid RSA private key JWK', () => {
      const validRsaJwk = {
        kty : 'RSA',
        n   : 'base64url-encoded-n-value',
        e   : 'base64url-encoded-e-value',
        d   : 'base64url-encoded-d-value'
      };
      expect(isPrivateJwk(validRsaJwk)).toBe(true);
    });

    it('returns false for an EC public key JWK', () => {
      const validEcJwk = {
        kty : 'EC',
        crv : 'P-256',
        x   : 'base64url-encoded-x-value'
      };
      expect(isPrivateJwk(validEcJwk)).toBe(false);
    });

    it('returns false for an OKP public key JWK', () => {
      const validOkpPublicJwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-encoded-x-value'
      };
      expect(isPrivateJwk(validOkpPublicJwk)).toBe(false);
    });

    it('returns false for a RSA public key JWK', () => {
      const validRsaPublicJwk = {
        kty : 'RSA',
        n   : 'base64url-encoded-n-value',
        e   : 'base64url-encoded-e-value'
      };
      expect(isPrivateJwk(validRsaPublicJwk)).toBe(false);
    });

    it('returns false for non-object inputs', () => {
      expect(isPrivateJwk(null)).toBe(false);
      expect(isPrivateJwk(undefined)).toBe(false);
      expect(isPrivateJwk(123)).toBe(false);
      expect(isPrivateJwk('string')).toBe(false);
      expect(isPrivateJwk([])).toBe(false);
    });
  });

  describe('isPublicJwk()', () => {
    it('returns true for a valid EC public key JWK', () => {
      const validEcJwk = {
        kty : 'EC',
        crv : 'P-256',
        x   : 'base64url-encoded-x-value'
      };
      expect(isPublicJwk(validEcJwk)).toBe(true);
    });

    it('returns true for a valid OKP public key JWK', () => {
      const validOkpPublicJwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-encoded-x-value'
      };
      expect(isPublicJwk(validOkpPublicJwk)).toBe(true);
    });

    it('returns true for a valid RSA public key JWK', () => {
      const validRsaPublicJwk = {
        kty : 'RSA',
        n   : 'base64url-encoded-n-value',
        e   : 'base64url-encoded-e-value'
      };
      expect(isPublicJwk(validRsaPublicJwk)).toBe(true);
    });

    it('returns false for an EC private key JWK', () => {
      const validEcJwk = {
        kty : 'EC',
        crv : 'P-256',
        x   : 'base64url-encoded-x-value',
        d   : 'base64url-encoded-private-key'
      };
      expect(isPublicJwk(validEcJwk)).toBe(false);
    });

    it('returns false for an OKP private key JWK', () => {
      const validOkpJwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : 'base64url-encoded-x-value',
        d   : 'base64url-encoded-private-key'
      };
      expect(isPublicJwk(validOkpJwk)).toBe(false);
    });

    it('returns false for an OCT private key JWK', () => {
      const validOctJwk = {
        kty : 'oct',
        k   : 'base64url-encoded-key'
      };
      expect(isPublicJwk(validOctJwk)).toBe(false);
    });

    it('returns false for a RSA private key JWK', () => {
      const validRsaJwk = {
        kty : 'RSA',
        n   : 'base64url-encoded-n-value',
        e   : 'base64url-encoded-e-value',
        d   : 'base64url-encoded-d-value'
      };
      expect(isPublicJwk(validRsaJwk)).toBe(false);
    });

    it('returns false for non-object inputs', () => {
      expect(isPublicJwk(null)).toBe(false);
      expect(isPublicJwk(undefined)).toBe(false);
      expect(isPublicJwk(123)).toBe(false);
      expect(isPublicJwk('string')).toBe(false);
      expect(isPublicJwk([])).toBe(false);
    });
  });
});
