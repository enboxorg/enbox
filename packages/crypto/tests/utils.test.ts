import type { Jwk } from '../src/jose/jwk.js';

import { describe, expect, it } from 'bun:test';

import { CryptoUtils, isCipher, isKeyExporter, isKeyImporter, isKeyWrapper } from '../src/utils.js';

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
      expect(() => CryptoUtils.randomBytes(-1)).toThrow('"bytesLength" expected integer >= 0'); // Length cannot be negative.
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

    it('uses enough random bytes to generate the full 10-digit PIN range', () => {
      const originalRandomBytes = CryptoUtils.randomBytes;
      const observedLengths: number[] = [];

      try {
        CryptoUtils.randomBytes = (bytesLength: number): Uint8Array => {
          observedLengths.push(bytesLength);
          return numberToBytes(5_000_000_000, bytesLength);
        };

        expect(CryptoUtils.randomPin({ length: 10 })).toBe('5000000000');
        expect(observedLengths).toEqual([5]);
      } finally {
        CryptoUtils.randomBytes = originalRandomBytes;
      }
    });

    it('rejects random values outside the unbiased sampling range', () => {
      const originalRandomBytes = CryptoUtils.randomBytes;
      const values = [65535, 999];

      try {
        CryptoUtils.randomBytes = (bytesLength: number): Uint8Array => {
          return numberToBytes(values.shift()!, bytesLength);
        };

        expect(CryptoUtils.randomPin({ length: 3 })).toBe('999');
      } finally {
        CryptoUtils.randomBytes = originalRandomBytes;
      }
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

  describe('isCipher()', () => {
    it('returns true for objects with encrypt and decrypt functions', () => {
      const cipher = {
        encrypt : (): Uint8Array => new Uint8Array(0),
        decrypt : (): Uint8Array => new Uint8Array(0),
      };
      expect(isCipher(cipher)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isCipher(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isCipher(undefined)).toBe(false);
    });

    it('returns false for empty objects', () => {
      expect(isCipher({})).toBe(false);
    });

    it('returns false when encrypt is missing', () => {
      expect(isCipher({ decrypt: (): void => {} })).toBe(false);
    });

    it('returns false when decrypt is missing', () => {
      expect(isCipher({ encrypt: (): void => {} })).toBe(false);
    });

    it('returns false when encrypt is not a function', () => {
      expect(isCipher({ encrypt: 'not-a-function', decrypt: (): void => {} })).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isCipher(42)).toBe(false);
      expect(isCipher('string')).toBe(false);
      expect(isCipher(true)).toBe(false);
    });
  });

  describe('isKeyExporter()', () => {
    it('returns true for objects with an exportKey function', () => {
      const exporter = { exportKey: (): void => {} };
      expect(isKeyExporter(exporter)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isKeyExporter(null)).toBe(false);
    });

    it('returns false for empty objects', () => {
      expect(isKeyExporter({})).toBe(false);
    });

    it('returns false when exportKey is not a function', () => {
      expect(isKeyExporter({ exportKey: 'not-a-function' })).toBe(false);
    });
  });

  describe('isKeyImporter()', () => {
    it('returns true for objects with an importKey function', () => {
      const importer = { importKey: (): void => {} };
      expect(isKeyImporter(importer)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isKeyImporter(null)).toBe(false);
    });

    it('returns false for empty objects', () => {
      expect(isKeyImporter({})).toBe(false);
    });

    it('returns false when importKey is not a function', () => {
      expect(isKeyImporter({ importKey: 'not-a-function' })).toBe(false);
    });
  });

  describe('isKeyWrapper()', () => {
    it('returns true for objects with wrapKey and unwrapKey functions', () => {
      const wrapper = {
        wrapKey   : (): void => {},
        unwrapKey : (): void => {},
      };
      expect(isKeyWrapper(wrapper)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isKeyWrapper(null)).toBe(false);
    });

    it('returns false for empty objects', () => {
      expect(isKeyWrapper({})).toBe(false);
    });

    it('returns false when wrapKey is missing', () => {
      expect(isKeyWrapper({ unwrapKey: (): void => {} })).toBe(false);
    });

    it('returns false when unwrapKey is missing', () => {
      expect(isKeyWrapper({ wrapKey: (): void => {} })).toBe(false);
    });

    it('returns false when wrapKey is not a function', () => {
      expect(isKeyWrapper({ wrapKey: 'not-a-function', unwrapKey: (): void => {} })).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isKeyWrapper(42)).toBe(false);
      expect(isKeyWrapper('string')).toBe(false);
    });
  });
});

function numberToBytes(value: number, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let index = byteLength - 1; index >= 0; index--) {
    bytes[index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return bytes;
}
