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
  KmsUnwrapKeyParams,
  KmsWrapKeyParams,
  PublicKeyJwk,
} from '@enbox/crypto';

import type { Web5PlatformAgent } from './agent.js';

export interface AgentKeyManager extends KeyManager,
  Cipher<KmsCipherParams, KmsCipherParams>,
  KeyImporter<KmsImportKeyParams, KeyIdentifier>,
  KeyExporter<KmsExportKeyParams, Jwk>,
  KeyDeleter<KmsDeleteKeyParams>,
  KeyWrapper<KmsWrapKeyParams, KmsUnwrapKeyParams> {

  agent: Web5PlatformAgent;

  /**
   * Derives an HD child public key from a stored private key using HKDF-SHA256
   * iteratively through the given derivation path segments.
   *
   * The private key never leaves the KMS boundary — only the public key is returned.
   *
   * @param params.keyUri - URI of the stored ancestor private key (secp256k1)
   * @param params.derivationPath - Array of HKDF path segments to derive through
   * @returns The derived child public key as a JWK
   */
  derivePublicKey(params: {
    keyUri: KeyIdentifier;
    derivationPath: string[];
  }): Promise<PublicKeyJwk>;

  /**
   * Decrypts an ECIES-SECP256K1 encrypted payload using a derived private key.
   *
   * This method:
   * 1. Derives the leaf private key via HKDF through the derivation path
   * 2. Performs ECIES decryption using the derived key
   * 3. Returns the decrypted plaintext (typically a 32-byte DEK)
   *
   * The derived private key is used internally and discarded after decryption.
   *
   * @param params.keyUri - URI of the stored ancestor private key (secp256k1)
   * @param params.derivationPath - Array of HKDF path segments to derive the leaf key
   * @param params.ciphertext - The ECIES encrypted payload
   * @param params.ephemeralPublicKey - Ephemeral public key from ECIES encryption
   * @param params.initializationVector - IV for the symmetric encryption step
   * @param params.messageAuthenticationCode - MAC tag for integrity verification
   * @returns The decrypted plaintext bytes
   */
  eciesSecp256k1Decrypt(params: {
    keyUri: KeyIdentifier;
    derivationPath: string[];
    ciphertext: Uint8Array;
    ephemeralPublicKey: Uint8Array;
    initializationVector: Uint8Array;
    messageAuthenticationCode: Uint8Array;
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
   * @param params.keyUri - URI of the stored ancestor private key (secp256k1)
   * @param params.derivationPath - Array of HKDF path segments to derive through
   * @returns The derived child private key as raw bytes
   */
  derivePrivateKeyBytes(params: {
    keyUri: KeyIdentifier;
    derivationPath: string[];
  }): Promise<Uint8Array>;
}
