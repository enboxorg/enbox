import type { Jwk } from '../../src/jose/jwk.js';

import { Convert } from '@enbox/common';
import { beforeAll, describe, expect, it } from 'bun:test';

import { AesKwAlgorithm } from '../../src/algorithms/aes-kw.js';

describe('AesKwAlgorithm', () => {
  let aesKw: AesKwAlgorithm;

  beforeAll(() => {
    aesKw = new AesKwAlgorithm();
  });

  describe('bytesToPrivateKey()', () => {
    it('returns a private key in JWK format', async () => {
      const privateKeyBytes = new Uint8Array(16); // 128-bit key
      const privateKey = await aesKw.bytesToPrivateKey({ privateKeyBytes });

      expect(privateKey).toHaveProperty('kty', 'oct');
      expect(privateKey).toHaveProperty('k');
      expect(privateKey).toHaveProperty('alg', 'A128KW');
    });

    it('sets alg to A128KW for 128-bit keys', async () => {
      const privateKeyBytes = new Uint8Array(16);
      const privateKey = await aesKw.bytesToPrivateKey({ privateKeyBytes });
      expect(privateKey.alg).toBe('A128KW');
    });

    it('sets alg to A192KW for 192-bit keys', async () => {
      const privateKeyBytes = new Uint8Array(24);
      const privateKey = await aesKw.bytesToPrivateKey({ privateKeyBytes });
      expect(privateKey.alg).toBe('A192KW');
    });

    it('sets alg to A256KW for 256-bit keys', async () => {
      const privateKeyBytes = new Uint8Array(32);
      const privateKey = await aesKw.bytesToPrivateKey({ privateKeyBytes });
      expect(privateKey.alg).toBe('A256KW');
    });

    it('round-trips with privateKeyToBytes', async () => {
      const originalBytes = new Uint8Array(32);
      crypto.getRandomValues(originalBytes);
      const privateKey = await aesKw.bytesToPrivateKey({ privateKeyBytes: originalBytes });
      const recoveredBytes = await aesKw.privateKeyToBytes({ privateKey });
      expect(recoveredBytes).toEqual(originalBytes);
    });
  });

  describe('generateKey()', () => {
    it('returns a private key in JWK format', async () => {
      const privateKey = await aesKw.generateKey({ algorithm: 'A256KW' });

      expect(privateKey).toHaveProperty('alg', 'A256KW');
      expect(privateKey).toHaveProperty('k');
      expect(privateKey).toHaveProperty('kid');
      expect(privateKey).toHaveProperty('kty', 'oct');
    });

    it('supports A128KW, A192KW, and A256KW algorithms', async () => {
      const algorithms = ['A128KW', 'A192KW', 'A256KW'] as const;
      for (const algorithm of algorithms) {
        const privateKey = await aesKw.generateKey({ algorithm });
        expect(privateKey).toHaveProperty('alg', algorithm);
        if (!privateKey.k) { throw new Error('Expected privateKey to have a `k` property'); }
        const privateKeyBytes = Convert.base64Url(privateKey.k).toUint8Array();
        expect(privateKeyBytes.byteLength * 8).toBe(parseInt(algorithm.slice(1, 4)));
      }
    });

    it('generates unique keys on each call', async () => {
      const key1 = await aesKw.generateKey({ algorithm: 'A256KW' });
      const key2 = await aesKw.generateKey({ algorithm: 'A256KW' });
      expect(key1.k).not.toBe(key2.k);
    });
  });

  describe('privateKeyToBytes()', () => {
    it('returns the key material as a Uint8Array', async () => {
      const privateKey = await aesKw.generateKey({ algorithm: 'A256KW' });
      const privateKeyBytes = await aesKw.privateKeyToBytes({ privateKey });

      expect(privateKeyBytes).toBeInstanceOf(Uint8Array);
      expect(privateKeyBytes.byteLength).toBe(32);
    });

    it('produces correct byte length for each algorithm', async () => {
      const algorithms = ['A128KW', 'A192KW', 'A256KW'] as const;
      const expectedLengths = [16, 24, 32];
      for (let i = 0; i < algorithms.length; i++) {
        const privateKey = await aesKw.generateKey({ algorithm: algorithms[i] });
        const privateKeyBytes = await aesKw.privateKeyToBytes({ privateKey });
        expect(privateKeyBytes.byteLength).toBe(expectedLengths[i]);
      }
    });
  });

  describe('wrapKey() / unwrapKey()', () => {
    let wrappingKey: Jwk;
    let keyToWrap: Jwk;

    beforeAll(async () => {
      wrappingKey = await aesKw.generateKey({ algorithm: 'A256KW' });
      keyToWrap = await aesKw.generateKey({ algorithm: 'A256KW' });
    });

    it('wraps a key and returns a Uint8Array', async () => {
      const wrappedKeyBytes = await aesKw.wrapKey({
        encryptionKey : wrappingKey,
        unwrappedKey  : keyToWrap,
      });

      expect(wrappedKeyBytes).toBeInstanceOf(Uint8Array);
      expect(wrappedKeyBytes.byteLength).toBeGreaterThan(0);
    });

    it('unwraps a key and returns a JWK', async () => {
      const wrappedKeyBytes = await aesKw.wrapKey({
        encryptionKey : wrappingKey,
        unwrappedKey  : keyToWrap,
      });

      const unwrappedKey = await aesKw.unwrapKey({
        decryptionKey       : wrappingKey,
        wrappedKeyBytes,
        wrappedKeyAlgorithm : 'A256KW',
      });

      expect(unwrappedKey).toHaveProperty('kty', 'oct');
      expect(unwrappedKey).toHaveProperty('k');
    });

    it('round-trips a key through wrap/unwrap', async () => {
      const wrappedKeyBytes = await aesKw.wrapKey({
        encryptionKey : wrappingKey,
        unwrappedKey  : keyToWrap,
      });

      const unwrappedKey = await aesKw.unwrapKey({
        decryptionKey       : wrappingKey,
        wrappedKeyBytes,
        wrappedKeyAlgorithm : 'A256KW',
      });

      expect(unwrappedKey.k).toBe(keyToWrap.k);
    });
  });
});
