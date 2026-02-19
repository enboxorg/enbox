import type { DeriveKeyBytesParams } from '../types/params-direct.js';
import type { HkdfParams } from '../primitives/hkdf.js';
import type { KeyBytesDeriver } from '../types/key-deriver.js';

import { CryptoAlgorithm } from './crypto-algorithm.js';
import { Hkdf } from '../primitives/hkdf.js';

/**
 * The `HkdfDeriveKeyBytesParams` interface defines the algorithm-specific parameters that should be
 * passed into the `deriveKeyBytes()` method when using the HKDF algorithm.
 */
export interface HkdfDeriveKeyBytesParams extends DeriveKeyBytesParams {
  /** Specifies the algorithm variant for HKDF key derivation.
   * The value determines the hash function that will be used and must be one of the following:
   * - `"HKDF-256"`: HKDF with SHA-256.
   * - `"HKDF-384"`: HKDF with SHA-384.
   * - `"HKDF-512"`: HKDF with SHA-512.
   */
  algorithm: 'HKDF-256' | 'HKDF-384' | 'HKDF-512';
}

/**
 * The `HkdfAlgorithm` class provides a concrete implementation for HKDF key derivation. It wraps
 * the {@link Hkdf} primitive and maps JOSE algorithm names to hash functions.
 */
export class HkdfAlgorithm extends CryptoAlgorithm
  implements KeyBytesDeriver<HkdfDeriveKeyBytesParams, Uint8Array> {

  /**
   * Derives a cryptographic byte array using HKDF.
   *
   * @param params - The parameters for the key derivation operation.
   * @param params.algorithm - The HKDF algorithm variant (e.g., `'HKDF-256'`).
   * @param params.baseKeyBytes - The input key material.
   * @param params.length - The desired length of the output in bits.
   *
   * @returns A Promise that resolves to the derived key bytes.
   */
  public async deriveKeyBytes({ algorithm, ...params }:
    HkdfDeriveKeyBytesParams & Omit<HkdfParams, 'hash'>
  ): Promise<Uint8Array> {
    // Map algorithm name to hash function.
    const hash = {
      'HKDF-256' : 'SHA-256' as const,
      'HKDF-384' : 'SHA-384' as const,
      'HKDF-512' : 'SHA-512' as const
    }[algorithm];

    // Derive a cryptographic byte array using HKDF.
    const derivedKeyBytes = await Hkdf.deriveKeyBytes({ ...params, hash });

    return derivedKeyBytes;
  }
}
