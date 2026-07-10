import type { PrivateKeyJwk } from '../types/jose-types.js';

import { Encoder } from './encoder.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

export enum KeyDerivationScheme {
  ProtocolPath = 'protocolPath',
}

export type DerivedPrivateJwk = {
  rootKeyId: string,
  keyId?: string,
  derivationScheme: KeyDerivationScheme;
  derivationPath?: string[];
  derivedPrivateKey: PrivateKeyJwk,
};

/**
 * Class containing hierarchical deterministic key related utility methods used by the DWN.
 */
export class HdKey {
  /**
   * Derives a hardened hierarchical deterministic private key.
   */
  public static async derivePrivateKeyBytes(privateKey: Uint8Array, relativePath: string[]): Promise<Uint8Array> {
    HdKey.validateKeyDerivationPath(relativePath);

    let currentPrivateKey = privateKey;
    for (const segment of relativePath) {
      const segmentBytes = Encoder.stringToBytes(segment);
      currentPrivateKey = await HdKey.deriveKeyUsingHkdf({
        hashAlgorithm      : 'SHA-256',
        initialKeyMaterial : currentPrivateKey,
        info               : segmentBytes, // use the segment as the application specific info for key derivation
        keyLengthInBytes   : 32 // 32 bytes = 256 bits
      });
    }

    return currentPrivateKey;
  }

  /**
   * Derives a key using  HMAC-based Extract-and-Expand Key Derivation Function (HKDF) as defined in RFC 5869.
   */
  public static async deriveKeyUsingHkdf(params: {
    hashAlgorithm: 'SHA-256' | 'SHA-384' | 'SHA-512',
    initialKeyMaterial: Uint8Array,
    info: Uint8Array,
    keyLengthInBytes: number
  }): Promise<Uint8Array> {
    const { hashAlgorithm, initialKeyMaterial, info, keyLengthInBytes } = params;

    const webCrypto = globalThis.crypto.subtle;

    // Import the `initialKeyMaterial` into the Web Crypto API to use for the key derivation operation.
    const webCryptoKey = await webCrypto.importKey('raw', initialKeyMaterial as BufferSource, { name: 'HKDF' }, false, ['deriveBits']);

    // Derive the bytes using the Web Crypto API.
    const derivedKeyBuffer = await crypto.subtle.deriveBits(
      {
        name : 'HKDF',
        hash : hashAlgorithm,
        salt : new Uint8Array(0), // `info` should be sufficient in our use case
        info : info as BufferSource
      },
      webCryptoKey,
      keyLengthInBytes * 8 // convert from bytes to bits
    );

    // Convert from ArrayBuffer to Uint8Array.
    const derivedKeyBytes = new Uint8Array(derivedKeyBuffer);
    return derivedKeyBytes;
  }

  /**
   * Validates that no empty strings exist within the derivation path segments array.
   * @throws {DwnError} with `DwnErrorCode.HdKeyDerivationPathInvalid` if derivation path fails validation.
   */
  private static validateKeyDerivationPath(pathSegments: string[]): void {
    if (pathSegments.includes('')) {
      throw new DwnError(DwnErrorCode.HdKeyDerivationPathInvalid, `Invalid key derivation path: ${pathSegments}`);
    }
  }
}
