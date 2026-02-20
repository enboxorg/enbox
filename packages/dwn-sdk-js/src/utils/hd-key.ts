import type { PrivateKeyJwk, PublicKeyJwk } from '../types/jose-types.js';

import { Encoder } from './encoder.js';
import { getWebcryptoSubtle } from '@noble/ciphers/webcrypto';
import { X25519 } from '@enbox/crypto';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

export enum KeyDerivationScheme {
  /**
   * Key derivation using the `dataFormat` value for Flat-space records.
   */
  DataFormats = 'dataFormats',
  ProtocolContext = 'protocolContext',
  ProtocolPath = 'protocolPath',

  /**
   * Key derivation using the `schema` value for Flat-space records.
   */
  Schemas = 'schemas'
}

export type DerivedPrivateJwk = {
  rootKeyId: string,
  derivationScheme: KeyDerivationScheme;
  derivationPath?: string[];
  derivedPrivateKey: PrivateKeyJwk,
};

/**
 * Class containing hierarchical deterministic key related utility methods used by the DWN.
 */
export class HdKey {
  /**
   * Derives a descendant private key.
   * Uses X25519 keys for encryption key derivation.
   */
  public static async derivePrivateKey(ancestorKey: DerivedPrivateJwk, subDerivationPath: string[]): Promise<DerivedPrivateJwk> {
    const ancestorPrivateKey = await X25519.privateKeyToBytes({ privateKey: ancestorKey.derivedPrivateKey });
    const ancestorPrivateKeyDerivationPath = ancestorKey.derivationPath ?? [];
    const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(ancestorPrivateKey, subDerivationPath);
    const derivedPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedPrivateKeyBytes });
    const derivedDescendantPrivateKey: DerivedPrivateJwk = {
      rootKeyId         : ancestorKey.rootKeyId,
      derivationScheme  : ancestorKey.derivationScheme,
      derivationPath    : [...ancestorPrivateKeyDerivationPath, ...subDerivationPath],
      derivedPrivateKey : derivedPrivateKeyJwk as PrivateKeyJwk
    };

    return derivedDescendantPrivateKey;
  }

  /**
   * Derives a descendant public key from an ancestor private key.
   * Uses X25519 keys for encryption key derivation.
   */
  public static async derivePublicKey(ancestorKey: DerivedPrivateJwk, subDerivationPath: string[]): Promise<PublicKeyJwk> {
    const derivedDescendantPrivateKey = await HdKey.derivePrivateKey(ancestorKey, subDerivationPath);
    const derivedDescendantPublicKey = await X25519.getPublicKey({ key: derivedDescendantPrivateKey.derivedPrivateKey });

    return derivedDescendantPublicKey as PublicKeyJwk;
  }

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

    const webCrypto = getWebcryptoSubtle() as SubtleCrypto;

    // Import the `initialKeyMaterial` into the Web Crypto API to use for the key derivation operation.
    const webCryptoKey = await webCrypto.importKey('raw', initialKeyMaterial, { name: 'HKDF' }, false, ['deriveBits']);

    // Derive the bytes using the Web Crypto API.
    const derivedKeyBuffer = await crypto.subtle.deriveBits(
      {
        name : 'HKDF',
        hash : hashAlgorithm,
        salt : new Uint8Array(0), // `info` should be sufficient in our use case
        info
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
