import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { Hkdf } from '../../src/primitives/hkdf.js';
import { hkdfTestVectors } from '../fixtures/test-vectors/hkdf.js';

describe('Hkdf', () => {
  describe('deriveKeyBytes', () => {
    it.each([
      ['SHA-256', 256, 32],
      ['SHA-384', 384, 48],
      ['SHA-512', 512, 64],
    ] as const)('should derive a key using %s', async (hash, length, expectedByteLength) => {
      const baseKeyBytes = new Uint8Array([1, 2, 3]);
      const salt = new Uint8Array([4, 5, 6]);
      const info = new Uint8Array([7, 8, 9]);
      const derivedKey = await Hkdf.deriveKeyBytes({
        hash,
        baseKeyBytes,
        length,
        salt,
        info,
      });
      expect(derivedKey).toBeInstanceOf(Uint8Array);
      expect(derivedKey).toHaveLength(expectedByteLength);
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
