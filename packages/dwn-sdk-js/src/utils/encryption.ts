import type { Jwk } from '@enbox/crypto';
import type { PublicKeyJwk } from '../types/jose-types.js';

import { concatBytes } from '@noble/ciphers/utils';
import { Encoder } from './encoder.js';
import { KeyDerivationScheme } from './hd-key.js';
import { AesGcm, AesKw, ConcatKdf, X25519, XChaCha20Poly1305 } from '@enbox/crypto';

/**
 * Content encryption algorithms supported by the DWN.
 * Both are AEAD (Authenticated Encryption with Associated Data) ciphers.
 */
export enum ContentEncryptionAlgorithm {
  /** AES-256 in Galois/Counter Mode. NIST-approved, hardware-accelerated. 96-bit nonce. */
  A256GCM = 'A256GCM',
  /** XChaCha20-Poly1305. 192-bit nonce (safe to randomize). Constant-time. */
  XC20P = 'XC20P',
}

/**
 * Key agreement algorithm used by the DWN.
 * ECDH-ES with X25519 key agreement and AES-256 Key Wrap.
 */
export enum KeyAgreementAlgorithm {
  EcdhEsA256kw = 'ECDH-ES+A256KW',
}

/** Size of the AES-GCM authentication tag in bytes. */
const AES_GCM_TAG_LENGTH_BYTES = 16;

/** Size of the Poly1305 authentication tag in bytes. */
const POLY1305_TAG_LENGTH_BYTES = 16;

/**
 * JWE Protected Header for DWN encryption.
 */
export type JweProtectedHeader = {
  alg: KeyAgreementAlgorithm;
  enc: ContentEncryptionAlgorithm;
};

/**
 * Per-recipient header in a JWE General JSON Serialization.
 */
export type JweRecipientHeader = {
  /** Fully qualified key ID of the root key used in key derivation (e.g. did:example:alice#enc). */
  kid: string;
  /** Ephemeral X25519 public key used for ECDH key agreement. */
  epk: PublicKeyJwk;
  /** Key derivation scheme used to derive the recipient's key. */
  derivationScheme: KeyDerivationScheme;
  /** Derived public key. Present when derivationScheme is 'protocolContext'. */
  derivedPublicKey?: PublicKeyJwk;
};

/**
 * A single recipient entry in the JWE General JSON Serialization.
 */
export type JweRecipient = {
  header: JweRecipientHeader;
  encrypted_key: string;
};

/**
 * JWE-inspired structure used as the `encryption` property on RecordsWrite messages.
 *
 * This follows the JWE General JSON Serialization (RFC 7516 Section 7.2) with one adaptation:
 * the `ciphertext` is NOT included here because the encrypted record data is stored separately
 * in the DataStore (or as inline `encodedData`). Only the key wrapping metadata, IV, and
 * authentication tag are stored in this structure.
 */
export type JweEncryption = {
  /** Base64url-encoded JWE Protected Header. */
  protected: string;
  /** Base64url-encoded initialization vector for content encryption. */
  iv: string;
  /** Base64url-encoded authentication tag from the AEAD cipher. */
  tag: string;
  /** Array of recipient entries, one per recipient or derivation path. */
  recipients: JweRecipient[];
};

/**
 * Input describing how to encrypt a key for a single recipient.
 */
export type KeyEncryptionInput = {
  /** Fully qualified key ID of the recipient's root encryption key. */
  publicKeyId: string;
  /** The recipient's derived X25519 public key. */
  publicKey: PublicKeyJwk;
  /** Key derivation scheme. */
  derivationScheme: KeyDerivationScheme;
  /** Algorithm for key agreement. Defaults to ECDH-ES+A256KW. */
  algorithm?: KeyAgreementAlgorithm;
};

/**
 * Input describing how to encrypt record data.
 */
export type EncryptionInput = {
  /** Content encryption algorithm. Defaults to A256GCM. */
  algorithm?: ContentEncryptionAlgorithm;
  /** The Content Encryption Key (CEK). Must be 32 bytes (256-bit). */
  key: Uint8Array;
  /** Initialization vector. 12 bytes for A256GCM, 24 bytes for XC20P. */
  initializationVector: Uint8Array;
  /** Authentication tag from the AEAD encryption of the record data. */
  authenticationTag: Uint8Array;
  /** Recipient key encryption inputs. */
  keyEncryptionInputs: KeyEncryptionInput[];
};

/**
 * Payload passed to a KeyDecrypter callback for JWE-based key unwrapping.
 */
export type JweKeyUnwrapPayload = {
  /** The wrapped CEK bytes. */
  encryptedKey: Uint8Array;
  /** The ephemeral X25519 public key used for ECDH. */
  ephemeralPublicKey: PublicKeyJwk;
};

/**
 * Utility class for DWN encryption operations using JWE (RFC 7516).
 * Uses ECDH-ES+A256KW key agreement with X25519 and either AES-256-GCM or XChaCha20-Poly1305
 * for authenticated content encryption.
 */
export class Encryption {

  /**
   * Encrypts data using an AEAD cipher (A256GCM or XC20P).
   * Returns ciphertext with the authentication tag appended.
   */
  public static async aeadEncrypt(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    iv: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; tag: Uint8Array }> {
    if (algorithm === ContentEncryptionAlgorithm.A256GCM) {
      const keyJwk: Jwk = { kty: 'oct', k: Encoder.bytesToBase64Url(keyBytes), alg: 'A256GCM' };
      // Web Crypto AES-GCM returns ciphertext || tag
      const combined = await AesGcm.encrypt({ data: plaintext, iv, key: keyJwk });
      const ciphertext = combined.slice(0, combined.length - AES_GCM_TAG_LENGTH_BYTES);
      const tag = combined.slice(combined.length - AES_GCM_TAG_LENGTH_BYTES);
      return { ciphertext, tag };

    } else if (algorithm === ContentEncryptionAlgorithm.XC20P) {
      // @noble/ciphers XChaCha20-Poly1305 returns ciphertext || tag
      const combined = await XChaCha20Poly1305.encryptRaw({ data: plaintext, keyBytes, nonce: iv });
      const ciphertext = combined.slice(0, combined.length - POLY1305_TAG_LENGTH_BYTES);
      const tag = combined.slice(combined.length - POLY1305_TAG_LENGTH_BYTES);
      return { ciphertext, tag };

    } else {
      throw new Error(`Unsupported content encryption algorithm: ${algorithm as string}`);
    }
  }

  /**
   * Decrypts data using an AEAD cipher (A256GCM or XC20P).
   * Expects ciphertext and tag as separate inputs.
   */
  public static async aeadDecrypt(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    iv: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
  ): Promise<Uint8Array> {
    // Both Web Crypto (AES-GCM) and @noble/ciphers (XChaCha20-Poly1305) expect ciphertext || tag
    const combined = concatBytes(ciphertext, tag);

    if (algorithm === ContentEncryptionAlgorithm.A256GCM) {
      const keyJwk: Jwk = { kty: 'oct', k: Encoder.bytesToBase64Url(keyBytes), alg: 'A256GCM' };
      return AesGcm.decrypt({ data: combined, iv, key: keyJwk });

    } else if (algorithm === ContentEncryptionAlgorithm.XC20P) {
      return XChaCha20Poly1305.decryptRaw({ data: combined, keyBytes, nonce: iv });

    } else {
      throw new Error(`Unsupported content encryption algorithm: ${algorithm as string}`);
    }
  }

  /**
   * Encrypts data as a ReadableStream using an AEAD cipher.
   * Collects all chunks, encrypts, and returns a new stream of ciphertext || tag.
   * The iv and tag are NOT embedded in the stream — they are stored in the JWE structure.
   */
  public static async aeadEncryptStream(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    iv: Uint8Array,
    plaintextStream: ReadableStream<Uint8Array>,
  ): Promise<{ ciphertextStream: ReadableStream<Uint8Array>; tag: Uint8Array }> {
    const plaintext = await Encryption.readStream(plaintextStream);
    const { ciphertext, tag } = await Encryption.aeadEncrypt(algorithm, keyBytes, iv, plaintext);
    const ciphertextStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(ciphertext);
        controller.close();
      }
    });
    return { ciphertextStream, tag };
  }

  /**
   * Decrypts a ciphertext stream using an AEAD cipher.
   * Returns a ReadableStream of plaintext.
   */
  public static async aeadDecryptStream(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    iv: Uint8Array,
    ciphertextStream: ReadableStream<Uint8Array>,
    tag: Uint8Array,
  ): Promise<ReadableStream<Uint8Array>> {
    const ciphertext = await Encryption.readStream(ciphertextStream);
    const plaintext = await Encryption.aeadDecrypt(algorithm, keyBytes, iv, ciphertext, tag);
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(plaintext);
        controller.close();
      }
    });
  }

  /**
   * Performs ECDH-ES key agreement with X25519 and wraps the CEK using AES-256 Key Wrap.
   *
   * @param ephemeralPrivateKey - Ephemeral X25519 private key (JWK).
   * @param recipientPublicKey - Recipient's X25519 public key (JWK).
   * @param cek - The Content Encryption Key to wrap.
   * @returns The wrapped CEK bytes.
   */
  public static async ecdhEsWrapKey(
    ephemeralPrivateKey: Jwk,
    recipientPublicKey: Jwk,
    cek: Uint8Array,
  ): Promise<Uint8Array> {
    // 1. ECDH shared secret
    const sharedSecret = await X25519.sharedSecret({
      privateKeyA : ephemeralPrivateKey,
      publicKeyB  : recipientPublicKey,
    });

    // 2. Derive KEK via Concat KDF (RFC 7518 Section 4.6.2)
    const kek = await ConcatKdf.deriveKey({
      sharedSecret,
      keyDataLen : 256,
      fixedInfo  : {
        algorithmId : 'A256KW',
        partyUInfo  : '',
        partyVInfo  : '',
        suppPubInfo : 256,
      },
    });

    // 3. AES-256 Key Wrap
    const cekJwk: Jwk = { kty: 'oct', k: Encoder.bytesToBase64Url(cek), alg: 'A256GCM' };
    const kekJwk: Jwk = { kty: 'oct', k: Encoder.bytesToBase64Url(kek), alg: 'A256KW' };
    const wrappedKey = await AesKw.wrapKey({ unwrappedKey: cekJwk, encryptionKey: kekJwk });

    return wrappedKey;
  }

  /**
   * Performs ECDH-ES key agreement with X25519 and unwraps the CEK using AES-256 Key Unwrap.
   *
   * @param recipientPrivateKey - Recipient's X25519 private key (JWK).
   * @param ephemeralPublicKey - Ephemeral X25519 public key from the JWE recipient header (JWK).
   * @param wrappedKey - The wrapped CEK bytes.
   * @returns The unwrapped CEK bytes.
   */
  public static async ecdhEsUnwrapKey(
    recipientPrivateKey: Jwk,
    ephemeralPublicKey: Jwk,
    wrappedKey: Uint8Array,
  ): Promise<Uint8Array> {
    // 1. ECDH shared secret
    const sharedSecret = await X25519.sharedSecret({
      privateKeyA : recipientPrivateKey,
      publicKeyB  : ephemeralPublicKey,
    });

    // 2. Derive KEK via Concat KDF
    const kek = await ConcatKdf.deriveKey({
      sharedSecret,
      keyDataLen : 256,
      fixedInfo  : {
        algorithmId : 'A256KW',
        partyUInfo  : '',
        partyVInfo  : '',
        suppPubInfo : 256,
      },
    });

    // 3. AES-256 Key Unwrap
    const kekJwk: Jwk = { kty: 'oct', k: Encoder.bytesToBase64Url(kek), alg: 'A256KW' };
    const unwrappedJwk = await AesKw.unwrapKey({
      wrappedKeyBytes     : wrappedKey,
      wrappedKeyAlgorithm : 'A256GCM',
      decryptionKey       : kekJwk,
    });

    return Encoder.base64UrlToBytes(unwrappedJwk.k!);
  }

  /**
   * Builds a JWE encryption property structure from encryption input.
   * The ciphertext (encrypted record data) is stored separately in the DataStore,
   * so only the key wrapping metadata, IV, and authentication tag are included here.
   *
   * @param encryptionInput - Describes the CEK, IV, and recipient key encryption inputs.
   * @param tag - The authentication tag produced by the AEAD cipher during data encryption.
   */
  public static async buildJwe(
    encryptionInput: EncryptionInput,
    tag: Uint8Array,
  ): Promise<JweEncryption> {
    const enc = encryptionInput.algorithm ?? ContentEncryptionAlgorithm.A256GCM;
    const protectedHeader: JweProtectedHeader = {
      alg: KeyAgreementAlgorithm.EcdhEsA256kw,
      enc,
    };

    const protectedHeaderBase64url = Encoder.stringToBase64Url(JSON.stringify(protectedHeader));

    const recipients: JweRecipient[] = [];
    for (const keyInput of encryptionInput.keyEncryptionInputs) {
      // Generate ephemeral X25519 key pair for each recipient
      const ephemeralPrivateKey = await X25519.generateKey();
      const ephemeralPublicKey = await X25519.getPublicKey({ key: ephemeralPrivateKey });

      // Wrap the CEK
      const wrappedKey = await Encryption.ecdhEsWrapKey(
        ephemeralPrivateKey,
        keyInput.publicKey as Jwk,
        encryptionInput.key,
      );

      const recipientHeader: JweRecipientHeader = {
        kid              : keyInput.publicKeyId,
        epk              : ephemeralPublicKey as PublicKeyJwk,
        derivationScheme : keyInput.derivationScheme,
      };

      // Attach derived public key for protocolContext scheme
      if (keyInput.derivationScheme === (KeyDerivationScheme.ProtocolContext as KeyDerivationScheme)) {
        recipientHeader.derivedPublicKey = keyInput.publicKey;
      }

      recipients.push({
        header        : recipientHeader,
        encrypted_key : Encoder.bytesToBase64Url(wrappedKey),
      });
    }

    return {
      protected : protectedHeaderBase64url,
      iv        : Encoder.bytesToBase64Url(encryptionInput.initializationVector),
      tag       : Encoder.bytesToBase64Url(tag),
      recipients,
    };
  }

  /**
   * Parses the JWE protected header from its base64url encoding.
   */
  public static parseProtectedHeader(protectedBase64url: string): JweProtectedHeader {
    return Encoder.base64UrlToObject(protectedBase64url) as JweProtectedHeader;
  }

  /**
   * Reads a ReadableStream to completion and returns all bytes concatenated.
   */
  private static async readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      chunks.push(value);
    }
    return concatBytes(...chunks);
  }
}
