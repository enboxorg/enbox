import type { Jwk } from '@enbox/crypto';

import { beforeEach, describe, expect, it } from 'bun:test';

import type { EnboxPlatformAgent } from '../../../../src/types/agent.js';

import { AgentCryptoApi } from '../../../../src/crypto-api.js';
import { FlattenedJwe } from '../../../../src/prototyping/crypto/jose/jwe-flattened.js';
import { LocalKeyManager } from '../../../../src/local-key-manager.js';

describe('FlattenedJwe', () => {
  const crypto = new AgentCryptoApi();
  let keyManager: LocalKeyManager;

  beforeEach(async () => {
    keyManager = new LocalKeyManager({ agent: {} as EnboxPlatformAgent });
  });

  describe('decrypt()', () => {
    it('returns the expected result given a decryption JWK and Flattened JWE', async () => {
      const key: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
        kid : '5CWawXBcFqty31Fb5vb5bABh-SbKpfFQAO596UfODRY',
      };

      const result = await FlattenedJwe.decrypt({
        jwe: {
          protected  : 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
          iv         : 'cCbtijzQbvD0p6ED',
          ciphertext : 'v1uDcQ',
          tag        : 'lksRf79sT-j3cRV6kSK08Q'
        },
        key,
        crypto,
        keyManager
      });

      expect(result.plaintext).toBeInstanceOf(Uint8Array);
      expect(result.plaintext).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(result.protectedHeader).toEqual({ alg: 'dir', enc: 'A256GCM' });
      expect(result.unprotectedHeader).toBeUndefined();
      expect(result.additionalAuthenticatedData).toBeUndefined();
      expect(result.sharedUnprotectedHeader).toBeUndefined();
    });

    it('returns the expected result given a decryption Key URI and Flattened JWE', async () => {
      const testKey: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
        kid : '5CWawXBcFqty31Fb5vb5bABh-SbKpfFQAO596UfODRY',
      };

      const keyUri = await keyManager.importKey({ key: testKey });

      const result = await FlattenedJwe.decrypt({
        jwe: {
          protected  : 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
          iv         : 'cCbtijzQbvD0p6ED',
          ciphertext : 'v1uDcQ',
          tag        : 'lksRf79sT-j3cRV6kSK08Q'
        },
        key: keyUri,
        crypto,
        keyManager
      });

      expect(result.plaintext).toBeInstanceOf(Uint8Array);
      expect(result.plaintext).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(result.protectedHeader).toEqual({ alg: 'dir', enc: 'A256GCM' });
      expect(result.unprotectedHeader).toBeUndefined();
      expect(result.additionalAuthenticatedData).toBeUndefined();
      expect(result.sharedUnprotectedHeader).toBeUndefined();
    });
  });

  describe('encrypt()', () => {
    it('encrypts and returns a Flattened JWE given an encryption JWK', async () => {
      const key: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
        kid : '5CWawXBcFqty31Fb5vb5bABh-SbKpfFQAO596UfODRY',
      };

      const flattenedJwe = await FlattenedJwe.encrypt({
        plaintext       : new Uint8Array([1, 2, 3, 4]),
        protectedHeader : { alg: 'dir', enc: 'A256GCM' },
        key,
        crypto,
        keyManager
      });

      expect(flattenedJwe.aad).toBeUndefined();
      expect(typeof flattenedJwe.ciphertext).toBe('string');
      expect(typeof flattenedJwe.iv).toBe('string');
      expect(typeof flattenedJwe.protected).toBe('string');
      expect(typeof flattenedJwe.tag).toBe('string');
      expect(flattenedJwe.unprotected).toBeUndefined();
      expect(flattenedJwe.header).toBeUndefined();
      expect(flattenedJwe.encrypted_key).toBeUndefined();
    });

    it('encrypts and returns a Flattened JWE given an encryption Key URI', async () => {
      const testKey: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
        kid : '5CWawXBcFqty31Fb5vb5bABh-SbKpfFQAO596UfODRY',
      };

      const keyUri = await keyManager.importKey({ key: testKey });

      const flattenedJwe = await FlattenedJwe.encrypt({
        plaintext       : new Uint8Array([1, 2, 3, 4]),
        protectedHeader : { alg: 'dir', enc: 'A256GCM' },
        key             : keyUri,
        crypto,
        keyManager
      });

      expect(flattenedJwe.aad).toBeUndefined();
      expect(typeof flattenedJwe.ciphertext).toBe('string');
      expect(typeof flattenedJwe.iv).toBe('string');
      expect(typeof flattenedJwe.protected).toBe('string');
      expect(typeof flattenedJwe.tag).toBe('string');
      expect(flattenedJwe.unprotected).toBeUndefined();
      expect(flattenedJwe.header).toBeUndefined();
      expect(flattenedJwe.encrypted_key).toBeUndefined();
    });
  });
});
