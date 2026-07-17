import type { JweCipher } from '../../src/jose/jwe/header.js';
import type { Jwk } from '../../src/jose/jwk.js';

import { Convert } from '@enbox/common';
import { beforeEach, describe, expect, it } from 'bun:test';

import { AesGcm } from '../../src/primitives/aes-gcm.js';
import { computeJwkThumbprint } from '../../src/jose/jwk.js';
import { FlattenedJwe } from '../../src/jose/jwe/flattened.js';
import { X25519 } from '../../src/primitives/x25519.js';

/**
 * Minimal in-memory {@link JweCipher} implementation used to exercise the Key Identifier CEK
 * path. Mirrors the structural surface the agent's `LocalKeyManager` provides.
 */
class TestJweCipher implements JweCipher {
  private _keys = new Map<string, Jwk>();

  public async importKey({ key }: { key: Jwk }): Promise<string> {
    const keyUri = `urn:jwk:${await computeJwkThumbprint({ jwk: key })}`;
    this._keys.set(keyUri, key);
    return keyUri;
  }

  public async decrypt({ keyUri, data, iv, additionalData }: {
    keyUri: string;
    data: Uint8Array;
    iv?: Uint8Array;
    additionalData?: Uint8Array;
  }): Promise<Uint8Array> {
    const key = this.getKey(keyUri);
    return await AesGcm.decrypt({ key, data, iv: iv!, additionalData });
  }

  public async encrypt({ keyUri, data, iv, additionalData }: {
    keyUri: string;
    data: Uint8Array;
    iv?: Uint8Array;
    additionalData?: Uint8Array;
  }): Promise<Uint8Array> {
    const key = this.getKey(keyUri);
    return await AesGcm.encrypt({ key, data, iv: iv!, additionalData });
  }

  private getKey(keyUri: string): Jwk {
    const key = this._keys.get(keyUri);
    if (key === undefined) { throw new Error(`TestJweCipher: Key not found: ${keyUri}`); }
    return key;
  }
}

describe('FlattenedJwe', () => {
  let keyManager: TestJweCipher;

  beforeEach(() => {
    keyManager = new TestJweCipher();
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
        options: { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] }
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
        key     : keyUri,
        keyManager,
        options : { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] }
      });

      expect(result.plaintext).toBeInstanceOf(Uint8Array);
      expect(result.plaintext).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(result.protectedHeader).toEqual({ alg: 'dir', enc: 'A256GCM' });
      expect(result.unprotectedHeader).toBeUndefined();
      expect(result.additionalAuthenticatedData).toBeUndefined();
      expect(result.sharedUnprotectedHeader).toBeUndefined();
    });

    it('throws when a Key URI CEK is used without a keyManager', async () => {
      const testKey: Jwk = {
        kty : 'oct',
        k   : 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs',
        alg : 'A256GCM',
      };

      const keyUri = await keyManager.importKey({ key: testKey });

      await expect(FlattenedJwe.decrypt({
        jwe: {
          protected  : 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
          iv         : 'cCbtijzQbvD0p6ED',
          ciphertext : 'v1uDcQ',
          tag        : 'lksRf79sT-j3cRV6kSK08Q'
        },
        key     : keyUri,
        options : { allowedAlgs: ['dir'], allowedEncs: ['A256GCM'] }
      })).rejects.toThrow('"keyManager" is required');
    });

    it('throws when the JWE "alg" is not in the allowed algorithms list', async () => {
      const key: Jwk = { kty: 'oct', k: 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs', alg: 'A256GCM' };

      await expect(FlattenedJwe.decrypt({
        jwe: {
          protected  : 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
          iv         : 'cCbtijzQbvD0p6ED',
          ciphertext : 'v1uDcQ',
          tag        : 'lksRf79sT-j3cRV6kSK08Q'
        },
        key,
        options: { allowedAlgs: ['PBES2-HS512+A256KW'], allowedEncs: ['A256GCM'] }
      })).rejects.toThrow('"alg" (Algorithm) Header Parameter value is not allowed');
    });

    it('throws when the JWE "enc" is not in the allowed encryption algorithms list', async () => {
      const key: Jwk = { kty: 'oct', k: 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs', alg: 'A256GCM' };

      await expect(FlattenedJwe.decrypt({
        jwe: {
          protected  : 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
          iv         : 'cCbtijzQbvD0p6ED',
          ciphertext : 'v1uDcQ',
          tag        : 'lksRf79sT-j3cRV6kSK08Q'
        },
        key,
        options: { allowedAlgs: ['dir'], allowedEncs: ['XC20P'] }
      })).rejects.toThrow('"enc" (Encryption Algorithm) Header Parameter value is not allowed');
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
        keyManager,
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

    it('generates a 24-byte nonce for XC20P content encryption', async () => {
      const key: Jwk = { kty: 'oct', k: 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs' };

      const flattenedJwe = await FlattenedJwe.encrypt({
        plaintext       : new Uint8Array([1, 2, 3, 4]),
        protectedHeader : { alg: 'dir', enc: 'XC20P' },
        key,
      });

      expect(Convert.base64Url(flattenedJwe.iv!).toUint8Array()).toHaveLength(24);
    });

    it('round-trips XC20P content encryption through dir mode', async () => {
      const key: Jwk = { kty: 'oct', k: 'x_6M0CwMITqmj0a-u1EggAmolpXWty6UxwlfWVtWgFs' };
      const plaintext = Convert.string('xchacha20-poly1305 round trip').toUint8Array();

      const flattenedJwe = await FlattenedJwe.encrypt({
        plaintext,
        protectedHeader: { alg: 'dir', enc: 'XC20P' },
        key,
      });

      const result = await FlattenedJwe.decrypt({
        jwe     : flattenedJwe,
        key,
        options : { allowedAlgs: ['dir'], allowedEncs: ['XC20P'] }
      });

      expect(result.plaintext).toEqual(plaintext);
    });

    it('round-trips ECDH-ES + XC20P including the epk protected header parameter', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey });
      const plaintext = Convert.string('ecdh-es round trip').toUint8Array();

      const flattenedJwe = await FlattenedJwe.encrypt({
        plaintext,
        protectedHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
        key             : { mode: 'ecdh-es', peerPublicKey: recipientPublicKey },
      });

      // The engine must have merged the ephemeral public key into the protected header.
      const parsedProtectedHeader = Convert.base64Url(flattenedJwe.protected!).toObject() as Record<string, Jwk>;
      expect(parsedProtectedHeader.epk?.crv).toBe('X25519');
      expect(flattenedJwe.encrypted_key).toBeUndefined();

      const result = await FlattenedJwe.decrypt({
        jwe     : flattenedJwe,
        key     : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
        options : { allowedAlgs: ['ECDH-ES'], allowedEncs: ['XC20P'] }
      });

      expect(result.plaintext).toEqual(plaintext);
    });
  });
});
