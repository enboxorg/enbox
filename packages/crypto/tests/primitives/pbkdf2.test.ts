import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { Pbkdf2 } from '../../src/primitives/pbkdf2.js';

describe('Pbkdf2', () => {
  const password = Convert.string('password').toUint8Array();
  const salt = Convert.string('salt').toUint8Array();
  const iterations = 1;
  const length = 256; // 32 bytes

  describe('deriveKey', () => {
    it('successfully derives a key', async () => {
      const derivedKey = await Pbkdf2.deriveKey({ hash: 'SHA-256', password, salt, iterations, length });

      expect(derivedKey).toBeInstanceOf(Uint8Array);
      expect(derivedKey.byteLength).toBe(length / 8);
    });

    const hashFunctions: ('SHA-256' | 'SHA-384' | 'SHA-512')[] = ['SHA-256', 'SHA-384', 'SHA-512'];
    hashFunctions.forEach(hash => {
      it(`handles ${hash} hash function`, async () => {
        const options = { hash, password, salt, iterations, length };

        const derivedKey = await Pbkdf2.deriveKey(options);
        expect(derivedKey).toBeInstanceOf(Uint8Array);
        expect(derivedKey.byteLength).toBe(length / 8);
      });
    });

    it('throws an error when an invalid hash function is specified', async () => {
      const options = {
        hash: 'SHA-2' as const, password, salt, iterations, length
      };

      // @ts-expect-error for testing purposes
      await expect(Pbkdf2.deriveKey(options)).rejects.toThrow();
    });

    it('throws an error when iterations count is not a positive number', async () => {
      const options = {
        hash       : 'SHA-256' as const, password, salt,
        iterations : -1, length
      };

      // Every browser throws a different error message so a specific message cannot be checked.
      await expect(Pbkdf2.deriveKey(options)).rejects.toThrow();
    });
  });

  describe('deriveKeyBytes', () => {
    it('successfully derives key bytes', async () => {
      const derivedKeyBytes = await Pbkdf2.deriveKeyBytes({
        hash         : 'SHA-256',
        baseKeyBytes : password,
        salt,
        iterations,
        length
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(length / 8);
    });

    const hashFunctions: ('SHA-256' | 'SHA-384' | 'SHA-512')[] = ['SHA-256', 'SHA-384', 'SHA-512'];
    hashFunctions.forEach((hash: 'SHA-256' | 'SHA-384' | 'SHA-512') => {
      it(`handles ${hash} hash function`, async () => {
        const derivedKeyBytes = await Pbkdf2.deriveKeyBytes({
          hash, baseKeyBytes: password, salt, iterations, length
        });
        expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
        expect(derivedKeyBytes.byteLength).toBe(length / 8);
      });
    });

    it('produces the same output as deriveKey for equivalent inputs', async () => {
      const derivedKey = await Pbkdf2.deriveKey({
        hash       : 'SHA-256',
        password,
        salt,
        iterations : 1000,
        length
      });

      const derivedKeyBytes = await Pbkdf2.deriveKeyBytes({
        hash         : 'SHA-256',
        baseKeyBytes : password,
        salt,
        iterations   : 1000,
        length
      });

      expect(derivedKeyBytes).toEqual(derivedKey);
    });

    it('throws an error when iterations count is not a positive number', async () => {
      // Every browser throws a different error message so a specific message cannot be checked.
      await expect(
        Pbkdf2.deriveKeyBytes({
          hash         : 'SHA-256',
          baseKeyBytes : password,
          salt,
          iterations   : -1,
          length
        })
      ).rejects.toThrow();
    });
  });
});
