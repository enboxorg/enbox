import type { JweKeyUnwrapPayload } from '../utils/encryption.js';
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
 * A callback interface for decrypting JWE-wrapped Content Encryption Keys (CEKs).
 * The implementor performs HKDF key derivation, ECDH-ES key agreement, and AES Key Unwrap
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
   * Unwraps a JWE-encrypted Content Encryption Key (CEK) after deriving the
   * leaf decryption key via HKDF through the given derivation path, then
   * performing ECDH-ES key agreement and AES-256 Key Unwrap.
   *
   * @param fullDerivationPath - The complete HKDF path to derive the leaf key
   * @param jweKeyUnwrapPayload - The wrapped CEK and ephemeral public key from the JWE recipient
   * @returns The unwrapped CEK bytes (typically 32 bytes for AES-256)
   */
  decrypt(
    fullDerivationPath: string[],
    jweKeyUnwrapPayload: JweKeyUnwrapPayload,
  ): Promise<Uint8Array>;
}
