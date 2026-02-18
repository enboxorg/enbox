import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import Sha256DigestTestVector from '../fixtures/test-vectors/sha256/digest.json' with { type: 'json' };

import { Sha256 } from '../../src/primitives/sha256.js';

describe('Sha256', () => {
  describe('digest()', () => {
    it('returns a Uint8Array digest of length 32', async () => {
      const digest = await Sha256.digest({
        data: new Uint8Array(10)
      });

      expect(digest).toBeInstanceOf(Uint8Array);
      expect(digest.byteLength).toBe(32);
    });

    for (const vector of Sha256DigestTestVector.vectors) {
      it(vector.description, async () => {
        const digest = await Sha256.digest({
          data: Convert.string(vector.input).toUint8Array()
        });

        expect(digest).toEqual(
          Convert.hex(vector.output).toUint8Array()
        );
      });
    }
  });
});
