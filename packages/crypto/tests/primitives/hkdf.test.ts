import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { Hkdf } from '../../src/primitives/hkdf.js';
import { hkdfTestVectors } from '../fixtures/test-vectors/hkdf.js';

describe('Hkdf', () => {
  describe('deriveKeyBytes', () => {
    it('should derive a key using SHA-256', async () => {
      const baseKeyBytes = new Uint8Array([1, 2, 3]);
      const salt = new Uint8Array([4, 5, 6]);
      const info = new Uint8Array([7, 8, 9]);
      const derivedKey = await Hkdf.deriveKeyBytes({
        hash   : 'SHA-256',
        baseKeyBytes,
        length : 256,
        salt,
        info,
      });
      expect(derivedKey).toBeInstanceOf(Uint8Array);
      expect(derivedKey).toHaveLength(32);
    });

    it('should derive a key using SHA-384', async () => {
      const baseKeyBytes = new Uint8Array([1, 2, 3]);
      const salt = new Uint8Array([4, 5, 6]);
      const info = new Uint8Array([7, 8, 9]);
      const derivedKey = await Hkdf.deriveKeyBytes({
        hash   : 'SHA-384',
        baseKeyBytes,
        length : 384,
        salt,
        info,
      });
      expect(derivedKey).toBeInstanceOf(Uint8Array);
      expect(derivedKey).toHaveLength(48);
    });

    it('should derive a key using SHA-512', async () => {
      const baseKeyBytes = new Uint8Array([1, 2, 3]);
      const salt = new Uint8Array([4, 5, 6]);
      const info = new Uint8Array([7, 8, 9]);
      const derivedKey = await Hkdf.deriveKeyBytes({
        hash   : 'SHA-512',
        baseKeyBytes,
        length : 512,
        salt,
        info,
      });
      expect(derivedKey).toBeInstanceOf(Uint8Array);
      expect(derivedKey).toHaveLength(64);
    });

    for (const vector of hkdfTestVectors) {
      it(`passes test vector ${vector.id}`, async () => {
        const outputKeyingMaterial = await Hkdf.deriveKeyBytes({
          hash         : vector.hash as 'SHA-256' | 'SHA-384' | 'SHA-512',
          baseKeyBytes : Convert.hex(vector.baseKeyBytes).toUint8Array(),
          info         : Convert.hex(vector.info).toUint8Array(),
          salt         : Convert.hex(vector.salt).toUint8Array(),
          length       : vector.length
        });
        expect(Convert.uint8Array(outputKeyingMaterial).toHex()).toEqual(vector.output);
      });
    }
  });
});
