import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { HkdfAlgorithm } from '../../src/algorithms/hkdf.js';

describe('HkdfAlgorithm', () => {
  const hkdf = new HkdfAlgorithm();

  describe('deriveKeyBytes()', () => {
    it('returns derived key bytes as a Uint8Array', async () => {
      const baseKeyBytes = new Uint8Array(32);
      crypto.getRandomValues(baseKeyBytes);

      const derivedKeyBytes = await hkdf.deriveKeyBytes({
        algorithm : 'HKDF-256',
        baseKeyBytes,
        length    : 256,
        hash      : 'SHA-256',
        info      : new Uint8Array(0),
        salt      : new Uint8Array(0),
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(32);
    });

    it('supports HKDF-256 algorithm', async () => {
      const baseKeyBytes = Convert.hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b').toUint8Array();

      const derivedKeyBytes = await hkdf.deriveKeyBytes({
        algorithm : 'HKDF-256',
        baseKeyBytes,
        length    : 256,
        hash      : 'SHA-256',
        info      : new Uint8Array(0),
        salt      : new Uint8Array(0),
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(32);
    });

    it('supports HKDF-384 algorithm', async () => {
      const baseKeyBytes = new Uint8Array(32);
      crypto.getRandomValues(baseKeyBytes);

      const derivedKeyBytes = await hkdf.deriveKeyBytes({
        algorithm : 'HKDF-384',
        baseKeyBytes,
        length    : 384,
        hash      : 'SHA-384',
        info      : new Uint8Array(0),
        salt      : new Uint8Array(0),
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(48);
    });

    it('supports HKDF-512 algorithm', async () => {
      const baseKeyBytes = new Uint8Array(32);
      crypto.getRandomValues(baseKeyBytes);

      const derivedKeyBytes = await hkdf.deriveKeyBytes({
        algorithm : 'HKDF-512',
        baseKeyBytes,
        length    : 512,
        hash      : 'SHA-512',
        info      : new Uint8Array(0),
        salt      : new Uint8Array(0),
      });

      expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(derivedKeyBytes.byteLength).toBe(64);
    });

    it('produces deterministic output for the same inputs', async () => {
      const baseKeyBytes = Convert.hex('000102030405060708090a0b0c0d0e0f').toUint8Array();
      const salt = Convert.hex('000102030405060708090a0b0c').toUint8Array();
      const info = Convert.hex('f0f1f2f3f4f5f6f7f8f9').toUint8Array();

      const derivedKeyBytes1 = await hkdf.deriveKeyBytes({
        algorithm : 'HKDF-256',
        baseKeyBytes,
        length    : 256,
        hash      : 'SHA-256',
        info,
        salt,
      });

      const derivedKeyBytes2 = await hkdf.deriveKeyBytes({
        algorithm : 'HKDF-256',
        baseKeyBytes,
        length    : 256,
        hash      : 'SHA-256',
        info,
        salt,
      });

      expect(derivedKeyBytes1).toEqual(derivedKeyBytes2);
    });

    it('produces different outputs for different inputs', async () => {
      const baseKeyBytes1 = new Uint8Array(32);
      const baseKeyBytes2 = new Uint8Array(32);
      crypto.getRandomValues(baseKeyBytes1);
      crypto.getRandomValues(baseKeyBytes2);

      const derivedKeyBytes1 = await hkdf.deriveKeyBytes({
        algorithm    : 'HKDF-256',
        baseKeyBytes : baseKeyBytes1,
        length       : 256,
        hash         : 'SHA-256',
        info         : new Uint8Array(0),
        salt         : new Uint8Array(0),
      });

      const derivedKeyBytes2 = await hkdf.deriveKeyBytes({
        algorithm    : 'HKDF-256',
        baseKeyBytes : baseKeyBytes2,
        length       : 256,
        hash         : 'SHA-256',
        info         : new Uint8Array(0),
        salt         : new Uint8Array(0),
      });

      expect(derivedKeyBytes1).not.toEqual(derivedKeyBytes2);
    });
  });
});
