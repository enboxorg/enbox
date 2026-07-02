import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes } from '@noble/ciphers/utils.js';

/**
 * AEAD tag length for AES-256-GCM (16 bytes / 128 bits).
 */
const AEAD_TAG_LENGTH = 16;

/**
 * Nonce length for AES-256-GCM encryption.
 */
const NONCE_LENGTH = 16;

/**
 * Output of an ECIES-SECP256K1 encryption operation.
 */
export type EciesSecp256k1EncryptionOutput = {
  /** The AES-GCM initialization vector. */
  initializationVector: Uint8Array;
  /** The ephemeral secp256k1 public key (compressed, 33 bytes). */
  ephemeralPublicKey: Uint8Array;
  /** The encrypted data. */
  ciphertext: Uint8Array;
  /** The AES-GCM authentication tag (16 bytes). */
  messageAuthenticationCode: Uint8Array;
};

/**
 * Input required for ECIES-SECP256K1 decryption.
 */
export type EciesSecp256k1EncryptionInput = EciesSecp256k1EncryptionOutput & {
  /** The recipient's secp256k1 private key (raw 32 bytes). */
  privateKey: Uint8Array;
};

/**
 * Browser-compatible ECIES (Elliptic Curve Integrated Encryption Scheme) using secp256k1.
 *
 * Wire-format compatible with `eciesjs` v0.4.x configured with
 * `isEphemeralKeyCompressed: true, isHkdfKeyCompressed: false` (the default).
 *
 * Protocol:
 *   1. Generate an ephemeral secp256k1 key pair.
 *   2. ECDH shared secret (uncompressed point).
 *   3. HKDF-SHA-256 key derivation: `hkdf(sha256, ephemeralPubUncompressed || sharedPointUncompressed)`.
 *   4. AES-256-GCM encryption with random 16-byte nonce.
 *
 * All underlying primitives (`@noble/ciphers`, `@noble/curves`, `@noble/hashes`)
 * are pure JavaScript and work in Node, Bun, and browsers.
 */
export class EciesSecp256k1 {
  /**
   * Encrypt plaintext for a given secp256k1 public key.
   * @param publicKeyBytes - Recipient's public key (compressed 33 bytes or uncompressed 65 bytes).
   * @param plaintext - The data to encrypt.
   */
  public static encrypt(publicKeyBytes: Uint8Array, plaintext: Uint8Array): EciesSecp256k1EncryptionOutput {
    // Generate ephemeral key pair.
    const ephemeralPrivateKey = secp256k1.utils.randomSecretKey();
    const ephemeralPubCompressed = secp256k1.getPublicKey(ephemeralPrivateKey, true);
    const ephemeralPubUncompressed = secp256k1.getPublicKey(ephemeralPrivateKey, false);

    // ECDH: shared point (uncompressed).
    const sharedPointUncompressed = secp256k1.getSharedSecret(ephemeralPrivateKey, publicKeyBytes, false);

    // HKDF-SHA-256: derive 32-byte symmetric key.
    // eciesjs (isHkdfKeyCompressed=false): master = senderPubUncompressed || sharedPointUncompressed
    const symmetricKey = hkdf(sha256, concatBytes(ephemeralPubUncompressed, sharedPointUncompressed), undefined, undefined, 32);

    // AES-256-GCM encrypt.
    const nonce = randomBytes(NONCE_LENGTH);
    const ciphered = gcm(symmetricKey, nonce).encrypt(plaintext); // ciphertext || tag

    return {
      ephemeralPublicKey        : ephemeralPubCompressed,
      initializationVector      : nonce,
      messageAuthenticationCode : ciphered.subarray(ciphered.length - AEAD_TAG_LENGTH),
      ciphertext                : ciphered.subarray(0, ciphered.length - AEAD_TAG_LENGTH),
    };
  }

  /**
   * Decrypt ciphertext produced by {@link EciesSecp256k1.encrypt}.
   * @param input - The encryption output plus the recipient's private key.
   */
  public static decrypt(input: EciesSecp256k1EncryptionInput): Uint8Array {
    const { privateKey, ephemeralPublicKey, initializationVector, messageAuthenticationCode, ciphertext } = input;

    // Decompress ephemeral public key (HKDF needs uncompressed form).
    const ephemeralPubUncompressed = secp256k1.Point.fromBytes(ephemeralPublicKey).toBytes(false);

    // ECDH: shared point (uncompressed).
    const sharedPointUncompressed = secp256k1.getSharedSecret(privateKey, ephemeralPublicKey, false);

    // HKDF-SHA-256: derive 32-byte symmetric key (same derivation as encrypt).
    const symmetricKey = hkdf(sha256, concatBytes(ephemeralPubUncompressed, sharedPointUncompressed), undefined, undefined, 32);

    // AES-256-GCM decrypt: reconstruct the wire format (ciphertext || tag).
    const ciphered = concatBytes(ciphertext, messageAuthenticationCode);
    return gcm(symmetricKey, Uint8Array.from(initializationVector)).decrypt(ciphered);
  }

  /**
   * Whether the ephemeral public key is compressed (always true for this implementation).
   */
  public static get isEphemeralKeyCompressed(): boolean {
    return true;
  }
}
