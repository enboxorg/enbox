import type {
  Cipher,
  Jwk,
  KeyDeleter,
  KeyExporter,
  KeyIdentifier,
  KeyImporter,
  KeyManager,
  KmsCipherParams,
  KmsDeleteKeyParams,
  KmsExportKeyParams,
  KmsImportKeyParams,
  PublicKeyJwk,
} from '@enbox/crypto';

import type { EnboxPlatformAgent } from './agent.js';

export interface AgentKeyManager extends KeyManager,
  Cipher<KmsCipherParams, KmsCipherParams>,
  KeyImporter<KmsImportKeyParams, KeyIdentifier>,
  KeyExporter<KmsExportKeyParams, Jwk>,
  KeyDeleter<KmsDeleteKeyParams> {

  agent: EnboxPlatformAgent;

  /**
   * Derives an HD child public key from a stored private key using HKDF-SHA256
   * iteratively through the given derivation path segments.
   *
   * The private key never leaves the KMS boundary — only the public key is returned.
   *
   * @param params.keyUri - URI of the stored ancestor private key (X25519)
   * @param params.derivationPath - Array of HKDF path segments to derive through
   * @returns The derived child public key as a JWK
   */
  derivePublicKey(params: {
    keyUri: KeyIdentifier;
    derivationPath: string[];
  }): Promise<PublicKeyJwk>;

  /**
   * Unwraps a DWN content-encryption key using a derived X25519 private key.
   *
   * This method:
   * 1. Derives the leaf private key via HKDF through the derivation path
   * 2. Performs X25519 key agreement with the ephemeral public key
   * 3. Derives the KEK via HKDF-SHA256 and unwraps the CEK with AES-256 Key Unwrap
   *
   * The derived private key is used internally and discarded after unwrapping.
   *
   * @param params.keyUri - URI of the stored ancestor private key (X25519)
   * @param params.derivationPath - Array of HKDF path segments to derive the leaf key
   * @param params.encryptedKey - The wrapped CEK bytes from the key-encryption entry
   * @param params.ephemeralPublicKey - Ephemeral X25519 public key from the key-encryption entry
   * @returns The unwrapped CEK bytes (typically 32 bytes for AES-256)
   */
  unwrapContentKey(params: {
    keyUri: KeyIdentifier;
    derivationPath: string[];
    encryptedKey: Uint8Array;
    ephemeralPublicKey: PublicKeyJwk;
  }): Promise<Uint8Array>;

  /**
   * Derives an HD child private key from a stored private key using HKDF-SHA256
   * iteratively through the given derivation path segments.
   *
   * Unlike derivePublicKey(), this returns the derived private key bytes.
   * This is used for scoped decryption-key delivery, where the derived key
   * must be serialized and delivered to another participant.
   *
   * Security: The ROOT private key never leaves the KMS — only the derived
   * child key (scoped to a grant) is exported. The child key is
   * immediately encrypted with the recipient's public key and the raw bytes
   * are discarded after encryption.
   *
   * @param params.keyUri - URI of the stored ancestor private key (X25519)
   * @param params.derivationPath - Array of HKDF path segments to derive through
   * @returns The derived child private key as raw bytes
   */
  derivePrivateKeyBytes(params: {
    keyUri: KeyIdentifier;
    derivationPath: string[];
  }): Promise<Uint8Array>;
}
