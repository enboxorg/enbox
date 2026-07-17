import type { AsymmetricKeyGenerator } from '../types/key-generator.js';
import type { Jwk } from '../jose/jwk.js';
import type { KeyConverter } from '../types/key-converter.js';
import type {
  BytesToPrivateKeyParams,
  ComputePublicKeyParams,
  GenerateKeyParams,
  GetPublicKeyParams,
  PrivateKeyToBytesParams,
} from '../types/params-direct.js';

import { CryptoAlgorithm } from './crypto-algorithm.js';
import { isOkpPrivateJwk } from '../jose/jwk.js';
import { X25519 } from '../primitives/x25519.js';

import { CryptoError, CryptoErrorCode } from '../crypto-error.js';

/**
 * The `X25519GenerateKeyParams` interface defines the algorithm-specific parameters that should be
 * passed into the `generateKey()` method when using the X25519 key agreement algorithm.
 */
export interface X25519GenerateKeyParams extends GenerateKeyParams {
  /**
   * A string defining the type of key to generate. The value must be:
   * - `"X25519"`: Elliptic-curve Diffie-Hellman (ECDH) using Curve25519.
   */
  algorithm: 'X25519';
}

/**
 * The `X25519Algorithm` class provides a concrete implementation for key generation,
 * public key derivation, and key conversion using the X25519 elliptic curve. X25519 is a
 * key agreement curve (not a signature curve) used for ECDH key exchange in JWE encryption.
 *
 * This class implements the {@link AsymmetricKeyGenerator | `AsymmetricKeyGenerator`} and
 * {@link KeyConverter | `KeyConverter`} interfaces, providing private key generation,
 * public key derivation, and byte/JWK conversion.
 */
export class X25519Algorithm extends CryptoAlgorithm
  implements AsymmetricKeyGenerator<X25519GenerateKeyParams, Jwk, GetPublicKeyParams>,
             KeyConverter {

  /**
   * Converts a raw private key in bytes to its corresponding JWK format.
   *
   * @param params - The parameters for the private key conversion.
   * @param params.algorithm - Must be `'X25519'`.
   * @param params.privateKeyBytes - The raw private key as a Uint8Array.
   *
   * @returns A Promise that resolves to the private key in JWK format.
   */
  public async bytesToPrivateKey({ algorithm, privateKeyBytes }:
    BytesToPrivateKeyParams & { algorithm: 'X25519' }
  ): Promise<Jwk> {
    if (algorithm === 'X25519') {
      return X25519.bytesToPrivateKey({ privateKeyBytes });
    }

    throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `Algorithm not supported: ${algorithm}`);
  }

  /**
   * Derives the public key in JWK format from a given X25519 private key.
   *
   * @param params - The parameters for the public key derivation.
   * @param params.key - The private key in JWK format from which to derive the public key.
   *
   * @returns A Promise that resolves to the derived public key in JWK format.
   */
  public async computePublicKey({ key }:
    ComputePublicKeyParams
  ): Promise<Jwk> {
    if (!isOkpPrivateJwk(key)) {throw new TypeError('Invalid key provided. Must be an octet key pair (OKP) private key.');}

    if (key.crv === 'X25519') {
      return X25519.computePublicKey({ key });
    }

    throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `Unsupported curve: ${key.crv}`);
  }

  /**
   * Generates a new X25519 private key in JWK format.
   *
   * @param params - The parameters for key generation.
   * @param params.algorithm - Must be `'X25519'`.
   *
   * @returns A Promise that resolves to the generated private key in JWK format.
   */
  async generateKey({ algorithm }:
    X25519GenerateKeyParams
  ): Promise<Jwk> {
    if (algorithm === 'X25519') {
      return X25519.generateKey();
    }

    throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `Algorithm not supported: ${algorithm}`);
  }

  /**
   * Retrieves the public key properties from a given X25519 private key in JWK format.
   *
   * @param params - The parameters for retrieving the public key properties.
   * @param params.key - The private key in JWK format.
   *
   * @returns A Promise that resolves to the public key in JWK format.
   */
  public async getPublicKey({ key }:
    GetPublicKeyParams
  ): Promise<Jwk> {
    if (!isOkpPrivateJwk(key)) {throw new TypeError('Invalid key provided. Must be an octet key pair (OKP) private key.');}

    if (key.crv === 'X25519') {
      return X25519.getPublicKey({ key });
    }

    throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `Unsupported curve: ${key.crv}`);
  }

  /**
   * Converts a private key from JWK format to a byte array.
   *
   * @param params - The parameters for the private key conversion.
   * @param params.privateKey - The private key in JWK format.
   *
   * @returns A Promise that resolves to the private key as a Uint8Array.
   */
  public async privateKeyToBytes({ privateKey }:
    PrivateKeyToBytesParams
  ): Promise<Uint8Array> {
    return X25519.privateKeyToBytes({ privateKey });
  }
}
