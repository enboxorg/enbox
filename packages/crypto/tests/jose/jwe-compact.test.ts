import type { Jwk } from '../../src/jose/jwk.js';

import { describe, expect, it } from 'bun:test';

import { CompactJwe } from '../../src/jose/jwe/compact.js';

describe('CompactJwe', () => {
  describe('decrypt()', () => {
    it('returns the protected header and decrypted payload given a decryption JWK', async () => {
      const key: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
        kid : '5CWawXBcFqty31Fb5vb5bABh-SbKpfFQAO596UfODRY',
      };

      const { plaintext, protectedHeader } = await CompactJwe.decrypt({
        jwe     : 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..cCbtijzQbvD0p6ED.v1uDcQ.lksRf79sT-j3cRV6kSK08Q',
        key,
        options : { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] }
      });

      expect(plaintext).toBeInstanceOf(Uint8Array);
      expect(protectedHeader).toEqual({ alg: 'dir', enc: 'A256GCM' });
    });
  });

  describe('encrypt()', () => {
    it('encrypts and returns a Compact JWE given an encryption JWK', async () => {
      const key: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
        kid : '5CWawXBcFqty31Fb5vb5bABh-SbKpfFQAO596UfODRY',
      };

      const jwe = await CompactJwe.encrypt({
        plaintext       : new Uint8Array([1, 2, 3, 4]),
        protectedHeader : { alg: 'dir', enc: 'A256GCM' },
        key,
      });

      expect(typeof jwe).toBe('string');
      expect(jwe.split('.')).toHaveLength(5);
    });

    it('round-trips a Compact JWE through encrypt and decrypt', async () => {
      const key: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
      };

      const jwe = await CompactJwe.encrypt({
        plaintext       : new Uint8Array([1, 2, 3, 4]),
        protectedHeader : { alg: 'dir', enc: 'A256GCM' },
        key,
      });

      const { plaintext } = await CompactJwe.decrypt({
        jwe,
        key,
        options: { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] }
      });

      expect(plaintext).toEqual(new Uint8Array([1, 2, 3, 4]));
    });
  });

  describe('edge cases', () => {
    describe('decrypt', () => {
      it('should throw when jwe is not a string', async () => {
        await expect(CompactJwe.decrypt({
          jwe     : 123 as any,
          key     : 'urn:key:123',
          options : { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] },
        })).rejects.toThrow('Invalid JWE format');
      });

      it('should throw when jwe does not have 5 parts', async () => {
        await expect(CompactJwe.decrypt({
          jwe     : 'only.three.parts',
          key     : 'urn:key:123',
          options : { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] },
        })).rejects.toThrow('Invalid JWE format');
      });

      it('should throw when jwe has 4 parts', async () => {
        await expect(CompactJwe.decrypt({
          jwe     : 'one.two.three.four',
          key     : 'urn:key:123',
          options : { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] },
        })).rejects.toThrow('Invalid JWE format');
      });

      it('should throw when jwe has 6 parts', async () => {
        await expect(CompactJwe.decrypt({
          jwe     : 'one.two.three.four.five.six',
          key     : 'urn:key:123',
          options : { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] },
        })).rejects.toThrow('Invalid JWE format');
      });
    });
  });
});
