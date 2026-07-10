import type { AlgorithmIdentifier } from './identifier.js';
import type { Jwk } from '../jose/jwk.js';

/**
 * Parameters for converting raw private key bytes to a JWK.
 */
export interface BytesToPrivateKeyParams {
  /** The algorithm identifier. */
  algorithm: AlgorithmIdentifier;

  /** The raw private key bytes. */
  privateKeyBytes: Uint8Array;
}

/**
 * Parameters for converting raw public key bytes to a JWK.
 */
export interface BytesToPublicKeyParams {
  /** The algorithm identifier. */
  algorithm: AlgorithmIdentifier;

  /** The raw public key bytes. */
  publicKeyBytes: Uint8Array;
}

/**
 * Parameters for computing a public key.
 */
export interface ComputePublicKeyParams extends GetPublicKeyParams { }

/**
 * Parameters for encryption and decryption operations.
 *
 * Intended for use with a Key Management System.
 */
export interface CipherParams {
  /** A {@link Jwk} containing the key to be used for encryption or decryption. */
  key: Jwk;

  /** Data to be encrypted or decrypted. */
  data: Uint8Array;

  /** Additional algorithm-specific parameters for encryption or decryption. */
  [key: string]: unknown;
}

/**
 * Parameters for decrypting data.
 */
export interface DecryptParams {
  /** A {@link Jwk} containing the key to be used for decryption. */
  key: Jwk;

  /** Data to be decrypted. */
  data: Uint8Array;
}

/**
 * Parameters for deriving a key from raw byte-based key material.
 *
 * This interface works with raw byte arrays as the base key input, making it suitable for
 * agent-level key derivation where keys originate from passphrases, seed phrases, or other
 * byte-oriented sources.
 */
export interface DeriveKeyFromBytesParams {
  /** The algorithm identifier. */
  algorithm: string;

  /** The base key to be used for derivation as a byte array. */
  baseKeyBytes: Uint8Array;

  /** The algorithm identifier for the derived key. */
  derivedKeyAlgorithm?: string;

  /** Additional algorithm-specific parameters for key derivation. */
  [key: string]: unknown;
}

/**
 * Parameters for derivation of cryptographic byte arrays.
 */
export interface DeriveKeyBytesParams {
  /** The base key to be used for derivation as a byte array. */
  baseKeyBytes: Uint8Array;

  /** The desired length of the derived key in bits. */
  length: number;
}

/**
 * Parameters for computing a hash digest.
 */
export interface DigestParams {
  /** The algorithm identifier. */
  algorithm: AlgorithmIdentifier;

  /** Data to be digested. */
  data: Uint8Array;
}

/**
 * Parameters for encrypting data.
 */
export interface EncryptParams {
  /** A {@link Jwk} containing the key to be used for encryption. */
  key: Jwk;

  /** Data to be encrypted. */
  data: Uint8Array;
}

/**
 * Parameters for generating a key.
 */
export interface GenerateKeyParams {
  /** The algorithm identifier. */
  algorithm: AlgorithmIdentifier;
}

/**
 * Parameters for retrieving a public key.
 */
export interface GetPublicKeyParams {
  /** A {@link Jwk} containing the key from which to derive the public key. */
  key: Jwk;
}

/**
 * Parameters for signing data.
 */
export interface SignParams {
  /** A {@link Jwk} containing the key used for signing. */
  key: Jwk;

  /** Data to be signed. */
  data: Uint8Array;
}

/**
 * Parameters for converting a private key JWK to raw bytes.
 */
export interface PrivateKeyToBytesParams {
  /** The private key in JWK format. */
  privateKey: Jwk;
}

/**
 * Parameters for converting a public key JWK to raw bytes.
 */
export interface PublicKeyToBytesParams {
  /** The public key in JWK format. */
  publicKey: Jwk;
}

/**
 * Parameters for unwrapping a key.
 */
export interface UnwrapKeyParams {
  /** A {@link Jwk} containing the key used to decrypt the unwrapped key. */
  decryptionKey: Jwk;

  /** The wrapped private key as a byte array. */
  wrappedKeyBytes: Uint8Array;

  /** The algorithm identifier of the key encrypted in `wrappedKeyBytes`. */
  wrappedKeyAlgorithm: string;

  /** An object defining the algorithm-specific parameters for decrypting the `wrappedKeyBytes`. */
  decryptParams?: unknown;
}

/**
 * Parameters for verifying a signature.
 */
export interface VerifyParams {
  /** A {@link Jwk} containing the key used for verification. */
  key: Jwk;

  /** The signature to verify. */
  signature: Uint8Array;

  /** The data associated with the signature. */
  data: Uint8Array;
}

/**
 * Parameters for wrapping a key.
 */
export interface WrapKeyParams {
  /** A {@link Jwk} containing the key used to encrypt the unwrapped key. */
  encryptionKey: Jwk;

  /** A {@link Jwk} containing the private key to be wrapped. */
  unwrappedKey: Jwk;

  /** An object defining the algorithm-specific parameters for encrypting the `unwrappedKey`. */
  encryptParams?: unknown;
}