/**
 * Re-exports from `@enbox/crypto` — the canonical types now live upstream.
 */
export type {
  BytesToPrivateKeyParams,
  BytesToPublicKeyParams,
  CipherParams,
  DeriveKeyBytesParams,
  PrivateKeyToBytesParams,
  PublicKeyToBytesParams,
  UnwrapKeyParams,
  WrapKeyParams,
} from '@enbox/crypto';

/**
 * Parameters for direct key derivation operations.
 *
 * This type uses raw key bytes and an algorithm identifier rather than a JWK reference,
 * which is the convention for direct (non-KMS) cryptographic operations in the agent layer.
 *
 * Note: This differs from `@enbox/crypto`'s `DeriveKeyParams` which uses `{ key: Jwk }`.
 */
export interface DeriveKeyParams {
  /** The algorithm identifier for the key derivation. */
  algorithm: string;

  /** The base key to be used for derivation as a byte array. */
  baseKeyBytes: Uint8Array;

  /** The algorithm identifier for the derived key. */
  derivedKeyAlgorithm?: string;

  /** Additional algorithm-specific parameters for key derivation. */
  [key: string]: unknown;
}
