import type { Jwk } from '../jose/jwk.js';

/**
 * `KeyConverter` interface for converting private keys between byte array and JWK formats.
 *
 * The generic parameters allow implementations to accept custom input types for conversion
 * operations. The defaults match the original non-generic interface for backward compatibility.
 */
export interface KeyConverter<
  BytesToPrivateKeyInput = { privateKeyBytes: Uint8Array },
  PrivateKeyToBytesInput = { privateKey: Jwk }
> {

  /**
   * Converts a private key from a byte array to JWK format.
   *
   * @param params - The parameters for the private key conversion.
   *
   * @returns A Promise that resolves to the private key in JWK format.
   */
  bytesToPrivateKey(params: BytesToPrivateKeyInput): Promise<Jwk>;

  /**
   * Converts a private key from JWK format to a byte array.
   *
   * @param params - The parameters for the private key conversion.
   *
   * @returns A Promise that resolves to the private key as a Uint8Array.
   */
  privateKeyToBytes(params: PrivateKeyToBytesInput): Promise<Uint8Array>;
}

/**
 * `AsymmetricKeyConverter` interface extends {@link KeyConverter |`KeyConverter`}, adding support
 * for public key conversions.
 *
 * The generic parameters allow implementations to accept custom input types for conversion
 * operations. The defaults match the original non-generic interface for backward compatibility.
 */
export interface AsymmetricKeyConverter<
  BytesToPublicKeyInput = { publicKeyBytes: Uint8Array },
  PublicKeyToBytesInput = { publicKey: Jwk },
  BytesToPrivateKeyInput = { privateKeyBytes: Uint8Array },
  PrivateKeyToBytesInput = { privateKey: Jwk }
> extends KeyConverter<BytesToPrivateKeyInput, PrivateKeyToBytesInput> {
  /**
   * Converts a public key from a byte array to JWK format.
   *
   * @param params - The parameters for the public key conversion.
   *
   * @returns A Promise that resolves to the public key in JWK format.
   */
  bytesToPublicKey(params: BytesToPublicKeyInput): Promise<Jwk>;

  /**
   * Converts a public key from JWK format to a byte array.
   *
   * @param params - The parameters for the public key conversion.
   *
   * @returns A Promise that resolves to the public key as a Uint8Array.
   */
  publicKeyToBytes(params: PublicKeyToBytesInput): Promise<Uint8Array>;
}
