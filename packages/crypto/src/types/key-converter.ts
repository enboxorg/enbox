import type { Jwk } from '../jose/jwk.js';

/**
 * `KeyConverter` interface for converting private keys between byte array and JWK formats.
 *
 * @typeParam BytesToPrivateKeyInput - The input type for `bytesToPrivateKey`. Defaults to
 *   `{ privateKeyBytes: Uint8Array }`.
 * @typeParam PrivateKeyToBytesInput - The input type for `privateKeyToBytes`. Defaults to
 *   `{ privateKey: Jwk }`.
 */
export interface KeyConverter<
  BytesToPrivateKeyInput = { privateKeyBytes: Uint8Array },
  PrivateKeyToBytesInput = { privateKey: Jwk }
> {

  /**
   * Converts a private key from a byte array to JWK format.
   *
   * @param params - The parameters for the private key conversion.
   * @param params.privateKeyBytes - The raw private key as a Uint8Array.
   *
   * @returns A Promise that resolves to the private key in JWK format.
   */
  bytesToPrivateKey(params: BytesToPrivateKeyInput): Promise<Jwk>;

  /**
   * Converts a private key from JWK format to a byte array.
   *
   * @param params - The parameters for the private key conversion.
   * @param params.privateKey - The private key in JWK format.
   *
   * @returns A Promise that resolves to the private key as a Uint8Array.
   */
  privateKeyToBytes(params: PrivateKeyToBytesInput): Promise<Uint8Array>;
}

/**
 * `AsymmetricKeyConverter` interface extends {@link KeyConverter | `KeyConverter`}, adding support
 * for public key conversions.
 *
 * When used with default type parameters, this interface includes all four conversion methods
 * (bytes-to/from private key AND bytes-to/from public key). When used with explicit type
 * parameters, both the private and public key conversion types can be customized.
 *
 * @typeParam BytesToPublicKeyInput - The input type for `bytesToPublicKey`. Defaults to
 *   `{ publicKeyBytes: Uint8Array }`.
 * @typeParam PublicKeyToBytesInput - The input type for `publicKeyToBytes`. Defaults to
 *   `{ publicKey: Jwk }`.
 * @typeParam BytesToPrivateKeyInput - The input type for `bytesToPrivateKey`. Defaults to
 *   `{ privateKeyBytes: Uint8Array }`.
 * @typeParam PrivateKeyToBytesInput - The input type for `privateKeyToBytes`. Defaults to
 *   `{ privateKey: Jwk }`.
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
   * @param params.publicKeyBytes - The raw public key as a Uint8Array.
   *
   * @returns A Promise that resolves to the public key in JWK format.
   */
  bytesToPublicKey(params: BytesToPublicKeyInput): Promise<Jwk>;

  /**
   * Converts a public key from JWK format to a byte array.
   *
   * @param params - The parameters for the public key conversion.
   * @param params.publicKey - The public key in JWK format.
   *
   * @returns A Promise that resolves to the public key as a Uint8Array.
   */
  publicKeyToBytes(params: PublicKeyToBytesInput): Promise<Uint8Array>;
}