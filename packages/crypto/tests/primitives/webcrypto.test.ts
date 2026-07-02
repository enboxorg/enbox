import { afterEach, describe, expect, it } from 'bun:test';

import { getWebcrypto, getWebcryptoSubtle } from '../../src/primitives/webcrypto.js';

type MutableGlobalThis = typeof globalThis & { crypto?: Crypto };

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function setGlobalCrypto(crypto: Crypto | undefined): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable : true,
    value        : crypto,
    writable     : true,
  });
}

function restoreGlobalCrypto(): void {
  if (originalCryptoDescriptor !== undefined) {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    return;
  }

  delete (globalThis as MutableGlobalThis).crypto;
}

describe('webcrypto', () => {
  afterEach(() => {
    restoreGlobalCrypto();
  });

  describe('getWebcrypto()', () => {
    it('should return globalThis.crypto', () => {
      expect(getWebcrypto()).toBe(globalThis.crypto);
    });

    it('should throw when crypto is missing', () => {
      setGlobalCrypto(undefined);

      expect(() => getWebcrypto()).toThrow('crypto must be defined');
    });
  });

  describe('getWebcryptoSubtle()', () => {
    it('should return globalThis.crypto.subtle', () => {
      expect(getWebcryptoSubtle()).toBe(globalThis.crypto.subtle);
    });

    it('should throw when crypto.subtle is missing', () => {
      setGlobalCrypto({} as Crypto);

      expect(() => getWebcryptoSubtle()).toThrow('crypto.subtle must be defined');
    });
  });
});
