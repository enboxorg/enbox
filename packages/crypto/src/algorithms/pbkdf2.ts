import type { DeriveKeyBytesParams } from '../types/params-direct.js';
import type { KeyBytesDeriver } from '../types/key-deriver.js';
import type { Pbkdf2Params } from '../primitives/pbkdf2.js';

import { CryptoAlgorithm } from './crypto-algorithm.js';
import { Pbkdf2 } from '../primitives/pbkdf2.js';

/**
 * The `Pbkdf2DeriveKeyBytesParams` interface defines the algorithm-specific parameters that
 * should be passed into the `deriveKeyBytes()` method when using the PBKDF2 algorithm.
 */
export interface Pbkdf2DeriveKeyBytesParams extends DeriveKeyBytesParams {
  /** Specifies the algorithm variant for PBKDF2 key derivation.
   * The value determines the hash function that will be used and must be one of the following:
   * - `"PBES2-HS256+A128KW"`: PBKDF2 with HMAC SHA-256 and A128KW key wrapping.
   * - `"PBES2-HS384+A192KW"`: PBKDF2 with HMAC SHA-384 and A192KW key wrapping.
   * - `"PBES2-HS512+A256KW"`: PBKDF2 with HMAC SHA-512 and A256KW key wrapping.
   */
  algorithm: 'PBES2-HS256+A128KW' | 'PBES2-HS384+A192KW' | 'PBES2-HS512+A256KW';
}

/**
 * The `Pbkdf2Algorithm` class provides a concrete implementation for PBKDF2 key derivation. It
 * wraps the {@link Pbkdf2} primitive and maps PBES2 JOSE algorithm names to hash functions.
 */
export class Pbkdf2Algorithm extends CryptoAlgorithm
  implements KeyBytesDeriver<Pbkdf2DeriveKeyBytesParams, Uint8Array> {

  /**
   * Derives a cryptographic byte array using PBKDF2.
   *
   * @param params - The parameters for the key derivation operation.
   * @param params.algorithm - The PBES2 algorithm variant (e.g., `'PBES2-HS512+A256KW'`).
   * @param params.baseKeyBytes - The password or passphrase as bytes.
   * @param params.length - The desired length of the output in bits.
   *
   * @returns A Promise that resolves to the derived key bytes.
   */
  public async deriveKeyBytes({ algorithm, ...params }:
    Pbkdf2DeriveKeyBytesParams & Omit<Pbkdf2Params, 'hash'>
  ): Promise<Uint8Array> {
    // Extract the hash function component of the `algorithm` parameter.
    const [, hashFunction] = algorithm.split(/[-+]/);

    // Map from JOSE algorithm name to "SHA" hash function identifier.
    const hash = {
      'HS256' : 'SHA-256' as const,
      'HS384' : 'SHA-384' as const,
      'HS512' : 'SHA-512' as const
    }[hashFunction]!;

    // Derive a cryptographic byte array using PBKDF2.
    const derivedKeyBytes = await Pbkdf2.deriveKeyBytes({ ...params, hash });

    return derivedKeyBytes;
  }
}
