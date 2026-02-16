import type { EciesEncryptionOutput } from '../utils/encryption.js';
import type { KeyDerivationScheme } from '../utils/hd-key.js';
import type { PublicKeyJwk } from './jose-types.js';

/**
 * A callback interface for deriving HD public encryption keys.
 * The implementor performs HKDF key derivation and public key computation
 * internally — the private key never leaves the implementation boundary.
 *
 * Analogous to `MessageSigner` for signing operations.
 */
export interface EncryptionKeyDeriver {
  /** Fully qualified key ID (e.g. did:example:alice#enc) */
  rootKeyId: string;
  /** The derivation scheme (e.g. KeyDerivationScheme.ProtocolPath) */
  derivationScheme: KeyDerivationScheme;
  /**
   * Derives an HD child public key for the given full derivation path.
   * The private key material stays within the implementor's boundary.
   *
   * @param fullDerivationPath - The complete HKDF path segments
   *   (e.g. ['protocolPath', 'https://chat.example', 'thread', 'message'])
   * @returns The derived child public key as a JWK
   */
  derivePublicKey(fullDerivationPath: string[]): Promise<PublicKeyJwk>;
}

/**
 * A callback interface for decrypting ECIES-encrypted data encryption keys.
 * The implementor performs HKDF key derivation and ECIES decryption
 * internally — the private key never leaves the implementation boundary.
 *
 * Analogous to `MessageSigner` for signing operations.
 */
export interface KeyDecrypter {
  /** Fully qualified key ID (e.g. did:example:alice#enc) */
  rootKeyId: string;
  /** The derivation scheme (e.g. KeyDerivationScheme.ProtocolPath) */
  derivationScheme: KeyDerivationScheme;
  /**
   * Decrypts an ECIES-SECP256K1 encrypted payload after deriving the
   * leaf decryption key via HKDF through the given derivation path.
   *
   * @param fullDerivationPath - The complete HKDF path to derive the leaf key
   * @param eciesEncryptedPayload - The ECIES ciphertext components
   * @returns The decrypted plaintext bytes (typically a 32-byte DEK)
   */
  decrypt(
    fullDerivationPath: string[],
    eciesEncryptedPayload: EciesEncryptionOutput,
  ): Promise<Uint8Array>;
}
