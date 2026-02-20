import type {
  Cipher,
  Jwk,
  KeyDeleter,
  KeyExporter,
  KeyIdentifier,
  KeyImporter,
  KeyManager,
  KeyWrapper,
  KmsCipherParams,
  KmsDeleteKeyParams,
  KmsExportKeyParams,
  KmsImportKeyParams,
  KmsUriUnwrapKeyParams,
  KmsUriWrapKeyParams,
  PublicKeyJwk,
} from '@enbox/crypto';

import type { Web5PlatformAgent } from './agent.js';

export interface AgentKeyManager extends KeyManager,
  Cipher<KmsCipherParams, KmsCipherParams>,
  KeyImporter<KmsImportKeyParams, KeyIdentifier>,
  KeyExporter<KmsExportKeyParams, Jwk>,
  KeyDeleter<KmsDeleteKeyParams>,
  KeyWrapper<KmsUriWrapKeyParams, KmsUriUnwrapKeyParams> {

  agent: Web5PlatformAgent;

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
   * Unwraps a JWE-encrypted Content Encryption Key (CEK) using a derived X25519 private key.
   *
   * This method:
   * 1. Derives the leaf private key via HKDF through the derivation path
   * 2. Performs ECDH-ES key agreement with the ephemeral public key
   * 3. Derives the KEK via Concat KDF and unwraps the CEK with AES-256 Key Unwrap
   *
   * The derived private key is used internally and discarded after unwrapping.
   *
   * @param params.keyUri - URI of the stored ancestor private key (X25519)
   * @param params.derivationPath - Array of HKDF path segments to derive the leaf key
   * @param params.encryptedKey - The wrapped CEK bytes from the JWE recipient
   * @param params.ephemeralPublicKey - Ephemeral X25519 public key from the JWE recipient header
   * @returns The unwrapped CEK bytes (typically 32 bytes for AES-256)
   */
  jweKeyUnwrap(params: {
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
   * This is used ONLY for context-derived key sharing in multi-party
   * encryption, where the derived key must be serialized and delivered
   * to another participant.
   *
   * Security: The ROOT private key never leaves the KMS — only the derived
   * child key (scoped to a single context) is exported. The child key is
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
