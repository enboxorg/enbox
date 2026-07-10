import type { Jwk } from '../../src/jose/jwk.js';

import { Convert } from '@enbox/common';
import { beforeAll, describe, expect, it } from 'bun:test';

import { AesKwAlgorithm } from '../../src/algorithms/aes-kw.js';
import { isChrome } from '../utils/runtimes.js';

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

    it(`supports 'A128KW' and 'A256KW' algorithms in all supported runtimes`, async () => {
      const algorithms = ['A128KW', 'A256KW'] as const;
      for (const algorithm of algorithms) {
        const privateKey = await aesKw.generateKey({ algorithm });
        expect(privateKey).toHaveProperty('alg', algorithm);
        if (!privateKey.k) { throw new Error('Expected privateKey to have a `k` property'); }
        const privateKeyBytes = Convert.base64Url(privateKey.k).toUint8Array();
        expect(privateKeyBytes.byteLength * 8).toBe(parseInt(algorithm.slice(1, 4)));
      }
    });

    it(`supports 'A192KW' algorithm in all supported runtimes except Chrome browser`, async () => {
      if (isChrome) { return; }

      const algorithms = ['A192KW'] as const;
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

    it('produces correct byte length for A128KW and A256KW in all supported runtimes', async () => {
      const testCases = [
        { algorithm: 'A128KW' as const, expectedLength: 16 },
        { algorithm: 'A256KW' as const, expectedLength: 32 },
      ];
      for (const { algorithm, expectedLength } of testCases) {
        const privateKey = await aesKw.generateKey({ algorithm });
        const privateKeyBytes = await aesKw.privateKeyToBytes({ privateKey });
        expect(privateKeyBytes.byteLength).toBe(expectedLength);
      }
    });

    it('produces correct byte length for A192KW in all supported runtimes except Chrome browser', async () => {
      if (isChrome) { return; }

      const privateKey = await aesKw.generateKey({ algorithm: 'A192KW' });
      const privateKeyBytes = await aesKw.privateKeyToBytes({ privateKey });
      expect(privateKeyBytes.byteLength).toBe(24);
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

  describe('known-answer vectors', () => {
    const unwrappedKeyVector: Jwk = {
      kty : 'oct',
      k   : 'hX-1yAAU6aZCwGqViYfAhIiaTyu1PURMswoI4IQmiY4',
      alg : 'A256GCM',
      kid : '-TssSnJNgh10-YTwuBtyZTnv0LY6sdT-TQl9WFTSetI',
    };

    const wrappingKeyVector: Jwk = {
      kty : 'oct',
      k   : '47Fn3ZXGbmntoAKErKN5-d7yuwMejCJtOqgAeq_Ojk0',
      alg : 'A256KW',
      kid : 'izA6N7g3xmPWStB6Qe6BbGgfrXvrptzuH2eJ1wmdrtk',
    };

    const wrappedKeyBytesVector = Convert.hex('8c55fb6fc4c7bb0b6b483df65ba52bee7ed6e0f861ac8097b2394f61067d1157901295aba72c514b').toUint8Array();

    it('bytesToPrivateKey() returns the expected JWK given byte array input', async () => {
      const privateKeyBytes = Convert.hex('dc5ace47f88a59c992f6ad05fa15ccbe').toUint8Array();

      const privateKey = await aesKw.bytesToPrivateKey({ privateKeyBytes });

      const expectedOutput: Jwk = {
        kty : 'oct',
        k   : '3FrOR_iKWcmS9q0F-hXMvg',
        alg : 'A128KW',
        kid : 'u09ksgd0kCHfNK1BDhzP_N7lOvljazw443nfbO7k6Fo',
      };
      expect(privateKey).toEqual(expectedOutput);
    });

    it('wrapKey() returns the expected wrapped key for given input', async () => {
      const wrappedKeyBytes = await aesKw.wrapKey({
        unwrappedKey  : unwrappedKeyVector,
        encryptionKey : wrappingKeyVector,
      });

      // 32 bytes for the wrapped private key, 8 bytes for the initialization vector.
      expect(wrappedKeyBytes.byteLength).toBe(32 + 8);
      expect(wrappedKeyBytes).toEqual(wrappedKeyBytesVector);
    });

    it('unwrapKey() returns the expected unwrapped key for given input', async () => {
      const unwrappedKey = await aesKw.unwrapKey({
        wrappedKeyBytes     : wrappedKeyBytesVector,
        wrappedKeyAlgorithm : 'A256GCM',
        decryptionKey       : wrappingKeyVector,
      });

      expect(unwrappedKey).toEqual(unwrappedKeyVector);
    });
  });
});
