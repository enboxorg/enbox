import type { Jwk } from '../../src/jose/jwk.js';

import { Convert } from '@enbox/common';
import { beforeAll, describe, expect, it } from 'bun:test';

import { AesGcmAlgorithm } from '../../src/algorithms/aes-gcm.js';
import { CryptoUtils } from '../../src/utils.js';
import { isChrome } from '../utils/runtimes.js';

describe('AesGcmAlgorithm', () => {
  let aesGcm: AesGcmAlgorithm;
  let dataEncryptionKey: Jwk;

  beforeAll(async () => {
    aesGcm = new AesGcmAlgorithm();
    dataEncryptionKey = await aesGcm.generateKey({ algorithm: 'A128GCM' });
  });

  describe('encrypt()', () => {
    it('returns ciphertext as a Uint8Array', async () => {
      // Setup.
      const plaintext = new Uint8Array([1, 2, 3, 4]);
      const iv = CryptoUtils.randomBytes(12); // Initialization vector.
      const tagLength = 128; // Size in bits of the authentication tag.

      // Test the method.
      const ciphertext = await aesGcm.encrypt({
        key  : dataEncryptionKey,
        data : plaintext,
        iv,
        tagLength
      });

      // Validate the results.
      expect(ciphertext).toBeInstanceOf(Uint8Array);
      expect(ciphertext.byteLength).toBe(plaintext.byteLength + tagLength / 8);
    });
  });

  describe('decrypt()', () => {
    it('returns plaintext as a Uint8Array', async () => {
      // Setup.
      const privateKey: Jwk = {
        k   : '3k6i3iaSl7-_S-NH3N1GMQ',
        kty : 'oct',
        kid : 'HLYc5oFZYs3OfBfOa-dWL5md__xFUIpx1BJ6ueCPQQQ'
      };
      const ciphertext = Convert.hex('f27e81aa63c315a5cd03e2abcbc62a5665').toUint8Array();

      // Test the method.
      const plaintext = await aesGcm.decrypt({
        key  : privateKey,
        data : ciphertext,
        iv   : new Uint8Array(12)
      });

      // Validate the results.
      expect(plaintext).toBeInstanceOf(Uint8Array);
    });
  });

  describe('generateKey()', () => {
    it('returns a private key in JWK format', async () => {
      const privateKey = await aesGcm.generateKey({ algorithm: 'A128GCM' });

      expect(privateKey).toHaveProperty('alg', 'A128GCM');
      expect(privateKey).toHaveProperty('k');
      expect(privateKey).toHaveProperty('kid');
      expect(privateKey).toHaveProperty('kty', 'oct');
    });

    it(`supports 'A128GCM' and 'A256GCM' algorithms in all supported runtimes`, async () => {
      const algorithms = ['A128GCM', 'A256GCM'] as const;
      for (const algorithm of algorithms) {
        const privateKey = await aesGcm.generateKey({ algorithm });
        expect(privateKey).toHaveProperty('alg', algorithm);
        if (!privateKey.k) {throw new Error('Expected privateKey to have a `k` property');} // TypeScript type guard.
        const privateKeyBytes = Convert.base64Url(privateKey.k).toUint8Array();
        expect(privateKeyBytes.byteLength * 8).toBe(parseInt(algorithm.slice(1, 4)));
      }
    });

    it.skipIf(isChrome)(`supports 'A192GCM' algorithm in all supported runtimes except Chrome browser`, async () => {
      const algorithms = ['A192GCM'] as const;
      for (const algorithm of algorithms) {
        const privateKey = await aesGcm.generateKey({ algorithm });
        expect(privateKey).toHaveProperty('alg', algorithm);
        if (!privateKey.k) {throw new Error('Expected privateKey to have a `k` property');} // TypeScript type guard.
        const privateKeyBytes = Convert.base64Url(privateKey.k).toUint8Array();
        expect(privateKeyBytes.byteLength * 8).toBe(parseInt(algorithm.slice(1, 4)));
      }
    });
  });

  describe('bytesToPrivateKey()', () => {
    it('returns a private key in JWK format', async () => {
      const privateKeyBytes = new Uint8Array(16);
      crypto.getRandomValues(privateKeyBytes);
      const privateKey = await aesGcm.bytesToPrivateKey({ privateKeyBytes });

      expect(privateKey).toHaveProperty('kty', 'oct');
      expect(privateKey).toHaveProperty('k');
    });

    it('sets alg to A128GCM for 128-bit keys', async () => {
      const privateKeyBytes = new Uint8Array(16);
      const privateKey = await aesGcm.bytesToPrivateKey({ privateKeyBytes });
      expect(privateKey.alg).toBe('A128GCM');
    });

    it.skipIf(isChrome)('sets alg to A192GCM for 192-bit keys', async () => {
      const privateKeyBytes = new Uint8Array(24);
      const privateKey = await aesGcm.bytesToPrivateKey({ privateKeyBytes });
      expect(privateKey.alg).toBe('A192GCM');
    });

    it('sets alg to A256GCM for 256-bit keys', async () => {
      const privateKeyBytes = new Uint8Array(32);
      const privateKey = await aesGcm.bytesToPrivateKey({ privateKeyBytes });
      expect(privateKey.alg).toBe('A256GCM');
    });
  });

  describe('privateKeyToBytes()', () => {
    it('returns key material as a Uint8Array', async () => {
      const privateKey = await aesGcm.generateKey({ algorithm: 'A256GCM' });
      const privateKeyBytes = await aesGcm.privateKeyToBytes({ privateKey });

      expect(privateKeyBytes).toBeInstanceOf(Uint8Array);
      expect(privateKeyBytes.byteLength).toBe(32);
    });

    it('round-trips with bytesToPrivateKey', async () => {
      const originalBytes = new Uint8Array(32);
      crypto.getRandomValues(originalBytes);
      const privateKey = await aesGcm.bytesToPrivateKey({ privateKeyBytes: originalBytes });
      const recoveredBytes = await aesGcm.privateKeyToBytes({ privateKey });
      expect(recoveredBytes).toEqual(originalBytes);
    });
  });
});
