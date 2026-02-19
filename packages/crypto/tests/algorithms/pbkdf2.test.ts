import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { Pbkdf2Algorithm } from '../../src/algorithms/pbkdf2.js';

describe('Pbkdf2Algorithm', () => {
  const pbkdf2 = new Pbkdf2Algorithm();

  describe('deriveKeyBytes()', () => {
    it('returns derived key bytes as a Uint8Array', async () => {
      const baseKeyBytes = Convert.string('password').toUint8Array();
      const salt = Convert.string('salt').toUint8Array();

      const derivedKeyBytes = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS256+A128KW',
        baseKeyBytes,
        length     : 128,
        hash       : 'SHA-256',
        iterations : 1000,
        salt,
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(16);
    });

    it('supports PBES2-HS256+A128KW algorithm', async () => {
      const baseKeyBytes = Convert.string('passphrase').toUint8Array();
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);

      const derivedKeyBytes = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS256+A128KW',
        baseKeyBytes,
        length     : 128,
        hash       : 'SHA-256',
        iterations : 1000,
        salt,
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(16);
    });

    it('supports PBES2-HS384+A192KW algorithm', async () => {
      const baseKeyBytes = Convert.string('passphrase').toUint8Array();
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);

      const derivedKeyBytes = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS384+A192KW',
        baseKeyBytes,
        length     : 192,
        hash       : 'SHA-384',
        iterations : 1000,
        salt,
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(24);
    });

    it('supports PBES2-HS512+A256KW algorithm', async () => {
      const baseKeyBytes = Convert.string('passphrase').toUint8Array();
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);

      const derivedKeyBytes = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS512+A256KW',
        baseKeyBytes,
        length     : 256,
        hash       : 'SHA-512',
        iterations : 1000,
        salt,
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(32);
    });

    it('produces deterministic output for the same inputs', async () => {
      const baseKeyBytes = Convert.string('my-password').toUint8Array();
      const salt = Convert.string('fixed-salt').toUint8Array();

      const derivedKeyBytes1 = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS512+A256KW',
        baseKeyBytes,
        length     : 256,
        hash       : 'SHA-512',
        iterations : 1000,
        salt,
      });

      const derivedKeyBytes2 = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS512+A256KW',
        baseKeyBytes,
        length     : 256,
        hash       : 'SHA-512',
        iterations : 1000,
        salt,
      });

      expect(derivedKeyBytes1).toEqual(derivedKeyBytes2);
    });

    it('produces different outputs for different passwords', async () => {
      const salt = Convert.string('salt').toUint8Array();

      const derivedKeyBytes1 = await pbkdf2.deriveKeyBytes({
        algorithm    : 'PBES2-HS512+A256KW',
        baseKeyBytes : Convert.string('password1').toUint8Array(),
        length       : 256,
        hash         : 'SHA-512',
        iterations   : 1000,
        salt,
      });

      const derivedKeyBytes2 = await pbkdf2.deriveKeyBytes({
        algorithm    : 'PBES2-HS512+A256KW',
        baseKeyBytes : Convert.string('password2').toUint8Array(),
        length       : 256,
        hash         : 'SHA-512',
        iterations   : 1000,
        salt,
      });

      expect(derivedKeyBytes1).not.toEqual(derivedKeyBytes2);
    });

    it('produces different outputs for different salts', async () => {
      const baseKeyBytes = Convert.string('password').toUint8Array();

      const derivedKeyBytes1 = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS512+A256KW',
        baseKeyBytes,
        length     : 256,
        hash       : 'SHA-512',
        iterations : 1000,
        salt       : Convert.string('salt1').toUint8Array(),
      });

      const derivedKeyBytes2 = await pbkdf2.deriveKeyBytes({
        algorithm  : 'PBES2-HS512+A256KW',
        baseKeyBytes,
        length     : 256,
        hash       : 'SHA-512',
        iterations : 1000,
        salt       : Convert.string('salt2').toUint8Array(),
      });

      expect(derivedKeyBytes1).not.toEqual(derivedKeyBytes2);
    });
  });
});
