import type { Jwk } from '../jwk.js';
import type { JweEnc, JweHeaderParams } from './header.js';

import { Convert } from '@enbox/common';

import { AesGcm } from '../../primitives/aes-gcm.js';
import { AesKw } from '../../primitives/aes-kw.js';
import { ConcatKdf } from '../../primitives/concat-kdf.js';
import { Hkdf } from '../../primitives/hkdf.js';
import { Pbkdf2 } from '../../primitives/pbkdf2.js';
import { X25519 } from '../../primitives/x25519.js';
import { XChaCha20Poly1305 } from '../../primitives/xchacha20-poly1305.js';
import { CryptoError, CryptoErrorCode } from '../../crypto-error.js';

/**
 * The HKDF "info" value used by the optional PIN-strengthening KDF wrapper applied to an
 * ECDH-ES derived Content Encryption Key.
 */
const ECDH_ES_PIN_KDF_INFO = 'enbox/connect/v2/pin';

/**
 * The PBES2 family of "alg" (Algorithm) Header Parameter values supported by this engine.
 */
type Pbes2Alg = 'PBES2-HS256+A128KW' | 'PBES2-HS384+A192KW' | 'PBES2-HS512+A256KW';

/**
 * Maps each supported "enc" (Encryption Algorithm) Header Parameter value to the length in bits
 * of the Content Encryption Key it requires.
 */
const CEK_BIT_LENGTH_BY_ENC: Record<JweEnc, number> = {
  'A128GCM' : 128,
  'A192GCM' : 192,
  'A256GCM' : 256,
  'XC20P'   : 256,
};

/**
 * Key management input for encrypting with `"alg": "ECDH-ES"` (Direct Key Agreement).
 *
 * A fresh ephemeral X25519 key pair is generated for every encrypt operation and the public key
 * is placed in the JWE Protected Header as the "epk" parameter.
 */
export type JweEcdhEsEncryptKey = {
  /** Discriminates ECDH-ES key management input from JWK / Key Identifier / passphrase inputs. */
  mode: 'ecdh-es';

  /** The recipient's static X25519 public key in JWK format. */
  peerPublicKey: Jwk;

  /**
   * Optional PIN used to strengthen the derived Content Encryption Key. The PIN never transits:
   * when provided, the CEK is passed through HKDF-SHA256 with salt UTF8(pin) and
   * info UTF8('enbox/connect/v2/pin') after Concat KDF derivation. A recipient using the wrong
   * PIN derives a different CEK and fails closed with an AEAD authentication tag failure.
   */
  pin?: string;
};

/**
 * Key management input for decrypting with `"alg": "ECDH-ES"` (Direct Key Agreement).
 */
export type JweEcdhEsDecryptKey = {
  /** Discriminates ECDH-ES key management input from JWK / Key Identifier / passphrase inputs. */
  mode: 'ecdh-es';

  /** The recipient's static X25519 private key in JWK format. */
  privateKey: Jwk;

  /** {@inheritDoc JweEcdhEsEncryptKey.pin} */
  pin?: string;
};

/**
 * The key management key material accepted by {@link JweKeyManagement.decrypt}.
 */
export type JweKeyManagementDecryptKey = string | Jwk | Uint8Array | JweEcdhEsDecryptKey;

/**
 * The key management key material accepted by {@link JweKeyManagement.encrypt}.
 */
export type JweKeyManagementEncryptKey = string | Jwk | Uint8Array | JweEcdhEsEncryptKey;

/**
 * Represents the result of the JWE key management encryption process, encapsulating the Content
 * Encryption Key (CEK) and optionally the encrypted CEK.
 */
export interface JweKeyManagementEncryptResult {
  /**
   * The Content Encryption Key (CEK) used for encrypting the JWE payload. It can be a Key
   * Identifier such as a KMS URI or a JSON Web Key (JWK).
   */
  cek: string | Jwk;

  /**
   * The encrypted version of the CEK, provided as a byte array. The encrypted version of the CEK
   * is returned for all key management modes other than "dir" (Direct Encryption Mode) and
   * "ECDH-ES" (Direct Key Agreement Mode).
   */
  encryptedKey?: Uint8Array;

  /**
   * Header parameters produced during key management (e.g. the ECDH-ES "epk" value) that MUST be
   * merged into the JWE Protected Header before it is encoded so that they are covered by the
   * Additional Authenticated Data.
   */
  headerParams?: Partial<JweHeaderParams>;
}

/**
 * Defines the parameters required to decrypt a JWE encrypted key, including the key management
 * details.
 */
export interface JweKeyManagementDecryptParams {
  /**
   * The decryption key which can be a Key Identifier such as a KMS key URI, a JSON Web Key (JWK),
   * raw key material represented as a byte array, or an ECDH-ES key agreement input.
   */
  key: JweKeyManagementDecryptKey;

  /**
   * The encrypted key extracted from the JWE, represented as a byte array. This parameter is
   * optional and is used when the key is wrapped.
   */
  encryptedKey?: Uint8Array;

  /**
   * The JWE header parameters that define the characteristics of the decryption process, specifying
   * the algorithm and encryption method among other settings.
   */
  joseHeader: JweHeaderParams;
}

/**
 * Defines the parameters required for encrypting a JWE CEK, including the key management details.
 */
export interface JweKeyManagementEncryptParams {
  /**
   * The encryption key which can be a Key Identifier such as a KMS key URI, a JSON Web Key (JWK),
   * raw key material represented as a byte array, or an ECDH-ES key agreement input.
   */
  key: JweKeyManagementEncryptKey;

  /**
   * The JWE header parameters that define the characteristics of the encryption process, specifying
   * the algorithm and encryption method among other settings.
   */
  joseHeader: JweHeaderParams;
}

/**
 * Type guard function that checks whether the given key management key is an ECDH-ES key
 * agreement input (either the encrypt-side or decrypt-side shape).
 */
function isJweEcdhEsKey(key: unknown): key is JweEcdhEsEncryptKey | JweEcdhEsDecryptKey {
  return typeof key === 'object' && key !== null
    && 'mode' in key && key.mode === 'ecdh-es';
}

/**
 * Generates a random Content Encryption Key (CEK) in JWK format for the given "enc" (Encryption
 * Algorithm) Header Parameter value.
 *
 * @param enc - The JWE "enc" value identifying the content encryption algorithm.
 * @returns A Promise that resolves to the generated CEK in JWK format.
 * @throws {@link CryptoError} with code `AlgorithmNotSupported` if the "enc" value is not
 *         supported.
 */
export async function generateCek(enc: string): Promise<Jwk> {
  switch (enc) {
    case 'A128GCM':
    case 'A192GCM':
    case 'A256GCM':
      return await AesGcm.generateKey({ length: CEK_BIT_LENGTH_BY_ENC[enc] as 128 | 192 | 256 });

    case 'XC20P':
      return await XChaCha20Poly1305.generateKey();

    default:
      throw new CryptoError(
        CryptoErrorCode.AlgorithmNotSupported,
        `Unsupported "enc" (Encryption Algorithm) Header Parameter value: ${enc}`
      );
  }
}

/**
 * The `JweKeyManagement` class implements the key management aspects of JSON Web Encryption (JWE)
 * as specified in {@link https://datatracker.ietf.org/doc/html/rfc7516 | RFC 7516}.
 *
 * It supports algorithms for encrypting and decrypting keys, thereby enabling the secure
 * transmission of information where the payload is encrypted, and the encryption key is also
 * encrypted or agreed upon using key agreement techniques.
 *
 * The choice of algorithm is determined by the "alg" parameter in the JWE
 * header, and the class is designed to handle the intricacies associated with each algorithm,
 * ensuring the secure handling of the encryption keys.
 *
 * Supported algorithms include:
 * - `"dir"`: Direct Encryption Mode
 * - `"ECDH-ES"`: Direct Key Agreement Mode using Elliptic Curve Diffie-Hellman Ephemeral Static
 *   (X25519 only) with the Concat KDF, per RFC 7518, Section 4.6.
 * - `"PBES2-HS256+A128KW"`, `"PBES2-HS384+A192KW"`, `"PBES2-HS512+A256KW"`: Password-Based
 *   Encryption Mode with Key Wrapping (PBES2) using HMAC-SHA and AES Key Wrap algorithms for key
 *   wrapping and encryption.
 *
 * @example
 * ```ts
 * // To encrypt a key:
 * const keyEncryptionKey = Convert.string(passphrase).toUint8Array();
 * const { cek, encryptedKey: encryptedCek } = await JweKeyManagement.encrypt({
 *   key        : keyEncryptionKey,
 *   joseHeader : {
 *     alg : 'PBES2-HS512+A256KW',
 *     enc : 'A256GCM',
 *     p2c : 210_000,
 *     p2s : Convert.uint8Array(saltInput).toBase64Url()
 *   }
 * });
 *
 * // To decrypt a key:
 * const cek = await JweKeyManagement.decrypt({
 *   key          : keyEncryptionKey,
 *   encryptedKey : encryptedCek,
 *   joseHeader   : {
 *     alg : 'PBES2-HS512+A256KW',
 *     enc : 'A256GCM',
 *     p2c : 210_000,
 *     p2s : Convert.uint8Array(saltInput).toBase64Url()
 *   }
 * });
 * ```
 */
export class JweKeyManagement {
  /**
   * Decrypts the encrypted key (JWE Encrypted Key) using the specified key encryption algorithm
   * defined in the JWE Header's "alg" parameter.
   *
   * This method supports multiple key management algorithms, including Direct Encryption (dir),
   * Direct Key Agreement (ECDH-ES), and PBES2 schemes with key wrapping.
   *
   * The method takes a key, which can be a Key Identifier, JWK, raw byte array, or ECDH-ES key
   * agreement input, and the encrypted key along with the JWE header. It returns the decrypted
   * Content Encryption Key (CEK) which can then be used to decrypt the JWE ciphertext.
   *
   * @example
   * ```ts
   * // Decrypting the CEK with the PBES2-HS512+A256KW algorithm
   * const cek = await JweKeyManagement.decrypt({
   *   key          : Convert.string(passphrase).toUint8Array(),
   *   encryptedKey : encryptedCek,
   *   joseHeader   : {
   *     alg : 'PBES2-HS512+A256KW',
   *     enc : 'A256GCM',
   *     p2c : 210_000,
   *     p2s : Convert.uint8Array(saltInput).toBase64Url(),
   *   }
   * });
   * ```
   *
   * @param params - The decryption parameters.
   * @param options - Options controlling decryption constraints (e.g. the minimum acceptable
   *                  PBES2 iteration count).
   * @throws Throws an error if the key management algorithm is not supported or if required
   *         parameters are missing or invalid.
   */
  public static async decrypt({ key, encryptedKey, joseHeader }: JweKeyManagementDecryptParams,
    options?: { minP2cCount?: number }
  ): Promise<string | Jwk> {
    const minP2cCount = options?.minP2cCount ?? 1000;
    // Determine the Key Management Mode employed by the algorithm specified by the "alg"
    // (algorithm) Header Parameter.
    switch (joseHeader.alg) {
      case 'dir':
        return JweKeyManagement.decryptDirect({ key, encryptedKey });

      case 'ECDH-ES':
        return await JweKeyManagement.decryptEcdhEs({ key, encryptedKey, joseHeader });

      case 'PBES2-HS256+A128KW':
      case 'PBES2-HS384+A192KW':
      case 'PBES2-HS512+A256KW':
        return await JweKeyManagement.decryptPbes2({ key, encryptedKey, joseHeader, minP2cCount });

      default: {
        throw new CryptoError(
          CryptoErrorCode.AlgorithmNotSupported,
          `Unsupported "alg" (Algorithm) Header Parameter value: ${joseHeader.alg}`
        );
      }
    }
  }

  /**
   * Decrypts the CEK for `"alg": "dir"` (Direct Encryption Mode): the provided key management
   * `key` is used directly as the Content Encryption Key (CEK) to decrypt the JWE payload.
   *
   * @throws {@link CryptoError} if a JWE Encrypted Key is present, or if `key` is not a Key
   *         Identifier or JWK.
   */
  private static decryptDirect({ key, encryptedKey }: {
    key: JweKeyManagementDecryptKey;
    encryptedKey?: Uint8Array;
  }): string | Jwk {
    // Verify that the JWE Encrypted Key value is empty.
    if (encryptedKey !== undefined) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JWE "encrypted_key" is not allowed when using "dir" (Direct Encryption Mode).');
    }

    // Verify the key management `key` is a Key Identifier or JWK.
    if (key instanceof Uint8Array || isJweEcdhEsKey(key)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'Key management "key" must be a Key URI or JWK when using "dir" (Direct Encryption Mode).');
    }

    // return the key management `key` as the CEK.
    return key;
  }

  /**
   * Decrypts the CEK for `"alg": "ECDH-ES"` (Direct Key Agreement Mode): a JWE "Encrypted Key" is
   * not provided. Instead, an ECDH shared secret is computed between the recipient's static
   * private key and the ephemeral public key ("epk") from the JOSE Header, and the Content
   * Encryption Key (CEK) is derived from the shared secret using the Concat KDF per RFC 7518,
   * Section 4.6.
   *
   * @throws {@link CryptoError} if a JWE Encrypted Key is present, `key` is not an ECDH-ES
   *         decrypt input with a private key, the private key curve is unsupported, or the "epk"
   *         Header Parameter is missing or malformed.
   */
  private static async decryptEcdhEs({ key, encryptedKey, joseHeader }: {
    key: JweKeyManagementDecryptKey;
    encryptedKey?: Uint8Array;
    joseHeader: JweHeaderParams;
  }): Promise<Jwk> {
    // Verify that the JWE Encrypted Key value is empty.
    if (encryptedKey !== undefined) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JWE "encrypted_key" is not allowed when using "ECDH-ES" (Direct Key Agreement Mode).');
    }

    // Verify the key management `key` is an ECDH-ES decrypt input with a private key.
    if (!(isJweEcdhEsKey(key) && 'privateKey' in key)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe,
        'Key management "key" must be an object with "mode": "ecdh-es" and "privateKey" when using "ECDH-ES" (Direct Key Agreement Mode).'
      );
    }

    // Only the X25519 curve is supported for ECDH-ES key agreement.
    if (key.privateKey.crv !== 'X25519') {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `Unsupported ECDH-ES private key curve: ${key.privateKey.crv}`);
    }

    // Validate the ephemeral public key ("epk") from the JOSE Header.
    const ephemeralPublicKey = JweKeyManagement.validateEpk(joseHeader.epk);

    // Compute the ECDH shared secret between the recipient's static private key and the
    // ephemeral public key.
    const sharedSecret = await X25519.sharedSecret({
      privateKeyA : key.privateKey,
      publicKeyB  : ephemeralPublicKey
    });

    // Derive the CEK from the shared secret using the Concat KDF (and the optional PIN
    // strengthening wrapper).
    return await JweKeyManagement.deriveEcdhEsCek({ sharedSecret, joseHeader, pin: key.pin });
  }

  /**
   * Decrypts the CEK for the PBES2 family (`"alg": "PBES2-HS256+A128KW"`,
   * `"PBES2-HS384+A192KW"`, `"PBES2-HS512+A256KW"`) — Key Encryption Mode with key wrapping: the
   * given passphrase, salt (p2s), and iteration count (p2c) are used with the PBKDF2 key
   * derivation function to derive the Key Encryption Key (KEK), which is then used to decrypt the
   * JWE Encrypted Key to obtain the Content Encryption Key (CEK).
   *
   * @throws {@link CryptoError} if "p2c" or "p2s" are missing/invalid, "p2c" is below
   *         `minP2cCount`, `key` is not a `Uint8Array`, or the JWE Encrypted Key is missing.
   */
  private static async decryptPbes2({ key, encryptedKey, joseHeader, minP2cCount }: {
    key: JweKeyManagementDecryptKey;
    encryptedKey?: Uint8Array;
    joseHeader: JweHeaderParams;
    minP2cCount: number;
  }): Promise<Jwk> {
    if (typeof joseHeader.p2c !== 'number') {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JOSE Header "p2c" (PBES2 Count) is missing or not a number.');
    }

    // Per RFC 7518, Section 4.8.1.2, a minimum iteration count of 1000 is RECOMMENDED.
    // Enforce this floor to prevent an attacker from supplying a crafted JWE with a
    // trivially low iteration count that would weaken key derivation.
    if (joseHeader.p2c < minP2cCount) {
      throw new CryptoError(
        CryptoErrorCode.InvalidJwe,
        `JOSE Header "p2c" (PBES2 Count) is ${joseHeader.p2c}, which is below the minimum of ${minP2cCount}.`
      );
    }

    if (typeof joseHeader.p2s !== 'string') {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JOSE Header "p2s" (PBES2 salt) is missing or not a string.');
    }

    // Throw an error if the key management `key` is not a byte array. For PBES2, the key is
    // expected to be a low-entropy passphrase as a byte array.
    if (!(key instanceof Uint8Array)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'Key management "key" must be a Uint8Array when using "PBES2" (Key Encryption Mode).');
    }

    // Verify that the JWE Encrypted Key value is present.
    if (encryptedKey === undefined) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JWE "encrypted_key" is required when using "PBES2" (Key Encryption Mode).');
    }

    // Derive the Key Encryption Key (KEK) from the given passphrase, salt, and iteration count.
    const kek = await JweKeyManagement.derivePbes2Kek({
      alg        : joseHeader.alg as Pbes2Alg,
      passphrase : key,
      p2c        : joseHeader.p2c,
      p2s        : joseHeader.p2s
    });

    // Decrypt the Content Encryption Key (CEK) with the derived KEK.
    return await AesKw.unwrapKey({
      decryptionKey       : kek,
      wrappedKeyBytes     : encryptedKey,
      wrappedKeyAlgorithm : joseHeader.enc
    });
  }

  /**
   * Encrypts a Content Encryption Key (CEK) using the key management algorithm specified in the
   * JWE Header's "alg" parameter.
   *
   * This method supports various key management algorithms, including Direct Encryption (dir),
   * Direct Key Agreement (ECDH-ES), and PBES2 with key wrapping.
   *
   * For PBES2, it generates a random CEK for the specified encryption algorithm in the JWE header,
   * which can then be used to encrypt the actual payload, and returns the CEK along with the
   * encrypted key. For ECDH-ES, it generates a fresh ephemeral X25519 key pair, derives the CEK
   * from the shared secret, and returns the ephemeral public key as a header parameter that MUST
   * be merged into the JWE Protected Header.
   *
   * @example
   * ```ts
   * // Encrypting the CEK with the PBES2-HS512+A256KW algorithm
   * const { cek, encryptedKey } = await JweKeyManagement.encrypt({
   *   key        : Convert.string(passphrase).toUint8Array(),
   *   joseHeader : {
   *     alg : 'PBES2-HS512+A256KW',
   *     enc : 'A256GCM',
   *     p2c : 210_000,
   *     p2s : Convert.uint8Array(saltInput).toBase64Url(),
   *   }
   * });
   * ```
   *
   * @param params - The encryption parameters.
   * @returns The encrypted key result containing the CEK, optionally the encrypted CEK
   *          (JWE Encrypted Key), and optionally header parameters that must be added to the JWE
   *          Protected Header.
   * @throws Throws an error if the key management algorithm is not supported or if required
   *         parameters are missing or invalid.
   */
  public static async encrypt({ key, joseHeader }: JweKeyManagementEncryptParams
  ): Promise<JweKeyManagementEncryptResult> {
    let cek: string | Jwk;
    let encryptedKey: Uint8Array | undefined;
    let headerParams: Partial<JweHeaderParams> | undefined;

    // Determine the Key Management Mode employed by the algorithm specified by the "alg"
    // (algorithm) Header Parameter.
    switch (joseHeader.alg) {
      case 'dir': {
        // In Direct Encryption mode (dir), a JWE "Encrypted Key" is not provided. Instead, the
        // provided key management `key` is directly used as the Content Encryption Key (CEK) to
        // decrypt the JWE payload.

        // Verify the key management `key` is a Key Identifier or JWK.
        if (key instanceof Uint8Array || isJweEcdhEsKey(key)) {
          throw new CryptoError(CryptoErrorCode.InvalidJwe, 'Key management "key" must be a Key URI or JWK when using "dir" (Direct Encryption Mode).');
        }

        // Set the CEK to the key management `key`.
        cek = key;

        break;
      }

      case 'ECDH-ES': {
        // In Direct Key Agreement mode (ECDH-ES), a fresh ephemeral X25519 key pair is generated
        // and an ECDH shared secret is computed between the ephemeral private key and the
        // recipient's static public key. The Content Encryption Key (CEK) is derived from the
        // shared secret using the Concat KDF per RFC 7518, Section 4.6, and the ephemeral public
        // key is placed in the JWE Protected Header as the "epk" parameter.

        // Verify the key management `key` is an ECDH-ES encrypt input with a peer public key.
        if (!(isJweEcdhEsKey(key) && 'peerPublicKey' in key)) {
          throw new CryptoError(CryptoErrorCode.InvalidJwe,
            'Key management "key" must be an object with "mode": "ecdh-es" and "peerPublicKey" when using "ECDH-ES" (Direct Key Agreement Mode).'
          );
        }

        // Only the X25519 curve is supported for ECDH-ES key agreement.
        if (!(key.peerPublicKey.kty === 'OKP' && key.peerPublicKey.crv === 'X25519' && typeof key.peerPublicKey.x === 'string')) {
          throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported,
            `Unsupported ECDH-ES peer public key: must be an OKP JWK on the X25519 curve with an "x" value.`
          );
        }

        // Generate a fresh ephemeral X25519 key pair for this encryption operation.
        const ephemeralPrivateKey = await X25519.generateKey();

        // Compute the ECDH shared secret between the ephemeral private key and the recipient's
        // static public key.
        const sharedSecret = await X25519.sharedSecret({
          privateKeyA : ephemeralPrivateKey,
          publicKeyB  : key.peerPublicKey
        });

        // Derive the CEK from the shared secret using the Concat KDF (and the optional PIN
        // strengthening wrapper).
        cek = await JweKeyManagement.deriveEcdhEsCek({ sharedSecret, joseHeader, pin: key.pin });

        // The ephemeral public key MUST be integrity-protected, so return it as a header
        // parameter to be merged into the JWE Protected Header.
        headerParams = { epk: { kty: 'OKP', crv: 'X25519', x: ephemeralPrivateKey.x } };

        break;
      }

      case 'PBES2-HS256+A128KW':
      case 'PBES2-HS384+A192KW':
      case 'PBES2-HS512+A256KW': {
        // In Key Encryption mode (PBES2) with key wrapping (A128KW, A192KW, A256KW), a randomly
        // generated Content Encryption Key (CEK) is encrypted with a Key Encryption Key (KEK)
        // derived from the given passphrase, salt (p2s), and iteration count (p2c) using the
        // PBKDF2 key derivation function.

        if (typeof joseHeader.p2c !== 'number') {
          throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JOSE Header "p2c" (PBES2 Count) is missing or not a number.');
        }

        if (typeof joseHeader.p2s !== 'string') {
          throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JOSE Header "p2s" (PBES2 salt) is missing or not a string.');
        }

        // Throw an error if the key management `key` is not a byte array.
        if (!(key instanceof Uint8Array)) {
          throw new CryptoError(CryptoErrorCode.InvalidJwe, 'Key management "key" must be a Uint8Array when using "PBES2" (Key Encryption Mode).');
        }

        // Generate a random Content Encryption Key (CEK) using the algorithm specified by the "enc"
        // (encryption) Header Parameter.
        cek = await generateCek(joseHeader.enc);

        // Derive a Key Encryption Key (KEK) from the given passphrase, salt, and iteration count.
        const kek = await JweKeyManagement.derivePbes2Kek({
          alg        : joseHeader.alg as Pbes2Alg,
          passphrase : key,
          p2c        : joseHeader.p2c,
          p2s        : joseHeader.p2s
        });

        // Encrypt the randomly generated CEK with the derived Key Encryption Key (KEK).
        encryptedKey = await AesKw.wrapKey({ encryptionKey: kek, unwrappedKey: cek });

        break;
      }

      default: {
        throw new CryptoError(
          CryptoErrorCode.AlgorithmNotSupported,
          `Unsupported "alg" (Algorithm) Header Parameter value: ${joseHeader.alg}`
        );
      }
    }

    return { cek, encryptedKey, headerParams };
  }

  /**
   * Derives the Content Encryption Key (CEK) for "ECDH-ES" (Direct Key Agreement Mode) from an
   * ECDH shared secret using the Concat KDF, per
   * {@link https://datatracker.ietf.org/doc/html/rfc7518#section-4.6.2 | RFC 7518, Section 4.6.2}:
   * - AlgorithmID is the value of the "enc" Header Parameter.
   * - PartyUInfo / PartyVInfo are the decoded values of the "apu" / "apv" Header Parameters, or
   *   the empty octet sequence when absent.
   * - SuppPubInfo is keydatalen, the bit length of the key used by the "enc" algorithm.
   *
   * When a `pin` is provided, the derived CEK is additionally passed through HKDF-SHA256 with
   * salt UTF8(pin) and info UTF8('enbox/connect/v2/pin'). The PIN never transits; a recipient
   * using the wrong PIN derives a different CEK and fails closed with an AEAD authentication tag
   * failure.
   *
   * @param params - The CEK derivation parameters.
   * @returns A Promise that resolves to the derived CEK in JWK format.
   * @throws {@link CryptoError} if the shared secret is all zeros (low-order point rejection), the
   *         "enc" value is unsupported, or the "apu" / "apv" values cannot be decoded.
   */
  private static async deriveEcdhEsCek({ sharedSecret, joseHeader, pin }: {
    sharedSecret: Uint8Array;
    joseHeader: JweHeaderParams;
    pin?: string;
  }): Promise<Jwk> {
    // Reject an all-zero shared secret, which results from an X25519 exchange with a low-order
    // public key and would yield an attacker-predictable CEK.
    if (sharedSecret.every((byte): boolean => byte === 0)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'ECDH-ES shared secret must not be all zeros.');
    }

    // Determine the desired CEK length (keydatalen) from the "enc" (Encryption Algorithm)
    // Header Parameter value.
    const keyDataLen = CEK_BIT_LENGTH_BY_ENC[joseHeader.enc as JweEnc];
    if (keyDataLen === undefined) {
      throw new CryptoError(
        CryptoErrorCode.AlgorithmNotSupported,
        `Unsupported "enc" (Encryption Algorithm) Header Parameter value: ${joseHeader.enc}`
      );
    }

    // Decode the "apu" (Agreement PartyUInfo) and "apv" (Agreement PartyVInfo) Header Parameters,
    // which default to the empty octet sequence when absent.
    const partyUInfo = JweKeyManagement.decodeAgreementParty('apu', joseHeader.apu);
    const partyVInfo = JweKeyManagement.decodeAgreementParty('apv', joseHeader.apv);

    // Derive the CEK from the shared secret using the Concat KDF.
    let cekBytes = await ConcatKdf.deriveKey({
      sharedSecret,
      keyDataLen,
      fixedInfo: {
        algorithmId : joseHeader.enc,
        partyUInfo,
        partyVInfo,
        suppPubInfo : keyDataLen,
      }
    });

    // If a PIN was provided, strengthen the CEK with the HKDF-SHA256 PIN wrapper.
    if (pin !== undefined) {
      cekBytes = await Hkdf.deriveKeyBytes({
        baseKeyBytes : cekBytes,
        hash         : 'SHA-256',
        salt         : Convert.string(pin).toUint8Array(),
        info         : Convert.string(ECDH_ES_PIN_KDF_INFO).toUint8Array(),
        length       : keyDataLen,
      });
    }

    // Convert the derived CEK bytes to JWK format using the "enc" appropriate converter.
    return joseHeader.enc === 'XC20P'
      ? await XChaCha20Poly1305.bytesToPrivateKey({ privateKeyBytes: cekBytes })
      : await AesGcm.bytesToPrivateKey({ privateKeyBytes: cekBytes });
  }

  /**
   * Decodes an agreement party ("apu" / "apv") Header Parameter from Base64 URL format to a byte
   * array, returning the empty octet sequence when the parameter is absent.
   *
   * @param param - The name of the Header Parameter being decoded; used for error messaging.
   * @param value - The Base64 URL encoded value of the Header Parameter, if present.
   * @returns The decoded value as a byte array.
   * @throws {@link CryptoError} if the value is present but not a properly encoded Base64 URL
   *         string.
   */
  private static decodeAgreementParty(param: string, value?: unknown): Uint8Array {
    if (value === undefined) {
      return new Uint8Array(0);
    }

    try {
      if (typeof value !== 'string') { throw new TypeError(`JOSE Header "${param}" value must be a string.`); }
      return Convert.base64Url(value).toUint8Array();
    } catch {
      throw new CryptoError(CryptoErrorCode.EncodingError, `Failed to decode the JOSE Header "${param}" value from Base64 URL format.`);
    }
  }

  /**
   * Derives the PBES2 Key Encryption Key (KEK) from a passphrase using PBKDF2, per
   * {@link https://www.rfc-editor.org/rfc/rfc7518.html#section-4.8 | RFC 7518, Section 4.8}.
   *
   * The salt value used is (UTF8(Alg) || 0x00 || Salt Input), where Alg is the "alg" (algorithm)
   * Header Parameter value. This reduces the potential for a precomputed dictionary attack (also
   * known as a rainbow table attack).
   *
   * @param params - The KEK derivation parameters.
   * @returns A Promise that resolves to the derived AES Key Wrap KEK in JWK format.
   * @throws {@link CryptoError} if the "p2s" value cannot be decoded.
   */
  private static async derivePbes2Kek({ alg, passphrase, p2c, p2s }: {
    alg: Pbes2Alg;
    passphrase: Uint8Array;
    p2c: number;
    p2s: string;
  }): Promise<Jwk> {
    // Map the PBES2 "alg" value to the PBKDF2 hash function and derived key length in bits.
    const { hash, length } = {
      'PBES2-HS256+A128KW' : { hash: 'SHA-256' as const, length: 128 },
      'PBES2-HS384+A192KW' : { hash: 'SHA-384' as const, length: 192 },
      'PBES2-HS512+A256KW' : { hash: 'SHA-512' as const, length: 256 },
    }[alg];

    // Per {@link https://www.rfc-editor.org/rfc/rfc7518.html#section-4.8.1.1 | RFC 7518, Section 4.8.1.1},
    // the salt value used with PBES2 should be of the format (UTF8(Alg) || 0x00 || Salt Input),
    // where Alg is the "alg" (algorithm) Header Parameter value.
    let salt: Uint8Array;
    try {
      salt = new Uint8Array([
        ...Convert.string(alg).toUint8Array(),
        0x00,
        ...Convert.base64Url(p2s).toUint8Array()
      ]);
    } catch {
      throw new CryptoError(CryptoErrorCode.EncodingError, 'Failed to decode the JOSE Header "p2s" (PBES2 salt) value.');
    }

    // Derive the KEK bytes from the given passphrase, salt, and iteration count using PBKDF2.
    const kekBytes = await Pbkdf2.deriveKeyBytes({
      baseKeyBytes : passphrase,
      hash,
      salt,
      iterations   : p2c,
      length,
    });

    // Convert the derived KEK bytes to an AES Key Wrap JWK.
    return await AesKw.bytesToPrivateKey({ privateKeyBytes: kekBytes });
  }

  /**
   * Validates the "epk" (Ephemeral Public Key) Header Parameter for ECDH-ES key agreement.
   *
   * @param epk - The "epk" value from the JOSE Header.
   * @returns The validated ephemeral public key in JWK format.
   * @throws {@link CryptoError} if the "epk" value is missing, malformed, or uses an unsupported
   *         curve.
   */
  private static validateEpk(epk: unknown): Jwk {
    if (typeof epk !== 'object' || epk === null || !('kty' in epk)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwe, 'JOSE Header "epk" (Ephemeral Public Key) is missing or not a JWK.');
    }

    const ephemeralPublicKey = epk as Jwk;

    // Only the X25519 curve is supported for ECDH-ES key agreement.
    if (!(ephemeralPublicKey.kty === 'OKP' && ephemeralPublicKey.crv === 'X25519' && typeof ephemeralPublicKey.x === 'string')) {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported,
        `Unsupported JOSE Header "epk" (Ephemeral Public Key): must be an OKP JWK on the X25519 curve with an "x" value.`
      );
    }

    return ephemeralPublicKey;
  }
}
