import { describe, expect, it } from 'bun:test';

import { CompactJwe } from '../../../../src/prototyping/crypto/jose/jwe-compact.js';

describe('CompactJwe — edge cases', () => {
  describe('decrypt', () => {
    it('should throw when jwe is not a string', async () => {
      await expect(CompactJwe.decrypt({
        jwe : 123 as any,
        key : 'urn:key:123',
      })).rejects.toThrow('Invalid JWE format');
    });

    it('should throw when jwe does not have 5 parts', async () => {
      await expect(CompactJwe.decrypt({
        jwe : 'only.three.parts',
        key : 'urn:key:123',
      })).rejects.toThrow('Invalid JWE format');
    });

    it('should throw when jwe has 4 parts', async () => {
      await expect(CompactJwe.decrypt({
        jwe : 'one.two.three.four',
        key : 'urn:key:123',
      })).rejects.toThrow('Invalid JWE format');
    });

    it('should throw when jwe has 6 parts', async () => {
      await expect(CompactJwe.decrypt({
        jwe : 'one.two.three.four.five.six',
        key : 'urn:key:123',
      })).rejects.toThrow('Invalid JWE format');
    });
  });
});
