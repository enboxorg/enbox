import type { Jwk } from '../jose/jwk.js';

type ExportedJwk = JsonWebKey & Jwk;

interface WebcryptoSubtleFacade {
  decrypt(...args: unknown[]): Promise<ArrayBuffer>;
  deriveBits(...args: unknown[]): Promise<ArrayBuffer>;
  deriveKey(...args: unknown[]): Promise<CryptoKey>;
  digest(...args: unknown[]): Promise<ArrayBuffer>;
  encrypt(...args: unknown[]): Promise<ArrayBuffer>;
  exportKey(format: 'jwk', ...args: unknown[]): Promise<ExportedJwk>;
  exportKey(format: 'raw' | 'spki' | 'pkcs8', ...args: unknown[]): Promise<ArrayBuffer>;
  generateKey(...args: unknown[]): Promise<CryptoKey>;
  importKey(...args: unknown[]): Promise<CryptoKey>;
  sign(...args: unknown[]): Promise<ArrayBuffer>;
  unwrapKey(...args: unknown[]): Promise<CryptoKey>;
  verify(...args: unknown[]): Promise<boolean>;
  wrapKey(...args: unknown[]): Promise<ArrayBuffer>;
}

type WebcryptoFacade = Omit<Crypto, 'subtle'> & {
  subtle: WebcryptoSubtleFacade;
};

export function getWebcrypto(): WebcryptoFacade {
  const webCrypto = globalThis.crypto;
  if (!webCrypto) {
    throw new Error('crypto must be defined');
  }

  return webCrypto as unknown as WebcryptoFacade;
}

export function getWebcryptoSubtle(): WebcryptoSubtleFacade {
  const subtle = getWebcrypto().subtle;
  if (!subtle) {
    throw new Error('crypto.subtle must be defined');
  }

  return subtle;
}
