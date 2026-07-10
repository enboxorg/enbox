import type { Jwk } from '../jose/jwk.js';
import type { AlgorithmIdentifier, KeyIdentifier } from './identifier.js';

/**
 * Parameters for KMS-based digest computation. Intended for use with a Key Management System.
 */
export interface KmsDigestParams {
  /** The algorithm identifier. */
  algorithm: AlgorithmIdentifier;

  /** Data to be digested. */
  data: Uint8Array;
}

/**
 * Parameters for exporting a key from a KMS. Intended for use with a Key Management System.
 */
export interface KmsExportKeyParams {
  /** Identifier for the private key to be exported from the KMS. */
  keyUri: KeyIdentifier;
}

/**
 * Parameters for generating a key in a KMS. Intended for use with a Key Management System.
 */
export interface KmsGenerateKeyParams {
  /** The algorithm identifier. */
  algorithm: AlgorithmIdentifier;
}

/**
 * Parameters for computing the Key URI of a public key. Intended for use with a Key Management
 * System.
 */
export interface KmsGetKeyUriParams {
  /** A {@link Jwk} containing the public key for which the Key URI will be computed. */
  key: Jwk;
}

/**
 * Parameters for retrieving a public key from a KMS using the private key's URI. Intended for use
 * with a Key Management System.
 */
export interface KmsGetPublicKeyParams {
  /** Identifier for the private key in the KMS. */
  keyUri: KeyIdentifier;
}

/**
 * Parameters for importing a private key into a KMS. Intended for use with a Key Management System.
 */
export interface KmsImportKeyParams {
  /** A {@link Jwk} containing the key to be imported into the KMS. */
  key: Jwk;
}

/**
 * Parameters for KMS-based signing operations. Intended for use with a Key Management System.
 */
export interface KmsSignParams {
  /** Identifier for the signing private key in the KMS. */
  keyUri: KeyIdentifier;

  /** Data to be signed. */
  data: Uint8Array;
}

/**
 * Parameters for verifying a signature using a key from a KMS. Intended for use with a Key
 * Management System.
 */
export interface KmsVerifyParams {
  /** A {@link Jwk} containing the public key to be used for verification. */
  key: Jwk;

  /** The signature to verify. */
  signature: Uint8Array;

  /** The data associated with the signature. */
  data: Uint8Array;
}

/**
 * Parameters for KMS-based encryption and decryption operations.
 *
 * Intended for use with a Key Management System where the key is referenced by URI.
 */
export interface KmsCipherParams {
  /** Identifier for the private key in the KMS. */
  keyUri: KeyIdentifier;

  /** Data to be encrypted or decrypted. */
  data: Uint8Array;
}

/**
 * Parameters for KMS-based key deletion. Intended for use with a Key Management System.
 */
export interface KmsDeleteKeyParams {
  /** Identifier for the key to be deleted in the KMS. */
  keyUri: KeyIdentifier;
}