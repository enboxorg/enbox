import type { JoseHeaderParams } from '../jws.js';
import type { Jwk } from '../jwk.js';
import type { KeyIdentifier } from '../../types/identifier.js';

/**
 * JWE "alg" (Algorithm) Header Parameter values supported by this engine's key management.
 *
 * @see {@link https://datatracker.ietf.org/doc/html/rfc7518#section-4.1 | RFC 7518, Section 4.1}
 */
export type JweAlg =
  // Direct use of a shared symmetric key as the CEK
  | 'dir'
  // Elliptic Curve Diffie-Hellman Ephemeral Static key agreement using Concat KDF
  | 'ECDH-ES'
  // PBES2 with HMAC SHA-256 and "A128KW" wrapping
  | 'PBES2-HS256+A128KW'
  // PBES2 with HMAC SHA-384 and "A192KW" wrapping
  | 'PBES2-HS384+A192KW'
  // PBES2 with HMAC SHA-512 and "A256KW" wrapping
  | 'PBES2-HS512+A256KW';

/**
 * JWE "enc" (Encryption Algorithm) Header Parameter values supported by this engine's content
 * encryption.
 *
 * @see {@link https://datatracker.ietf.org/doc/html/rfc7518#section-5.1 | RFC 7518, Section 5.1}
 */
export type JweEnc =
  // AES GCM using 128-bit key
  | 'A128GCM'
  // AES GCM using 192-bit key
  | 'A192GCM'
  // AES GCM using 256-bit key
  | 'A256GCM'
  // XChaCha20-Poly1305 authenticated encryption algorithm
  | 'XC20P';

/**
 * Specifies options for decrypting a JWE, allowing the caller to define constraints on the JWE
 * decryption process, particularly regarding the algorithms used.
 *
 * These options ensure that only expected and permitted algorithms are utilized during the
 * decryption, enhancing security by preventing unexpected algorithm usage.
 */
export interface JweDecryptOptions {
  /**
   * The exhaustive list of "alg" (Algorithm) Header Parameter values the caller accepts for this
   * decrypt operation. Decryption fails before any key management processing if the JWE's "alg"
   * value is not in this list, preventing algorithm-confusion attacks between callers that share
   * the same engine (e.g. vault PBES2 vs. connect ECDH-ES).
   */
  allowedAlgs: JweAlg[];

  /**
   * The exhaustive list of "enc" (Encryption Algorithm) Header Parameter values the caller accepts
   * for this decrypt operation. Decryption fails before any key management processing if the JWE's
   * "enc" value is not in this list.
   */
  allowedEncs: JweEnc[];

  /**
   * Minimum acceptable PBES2 iteration count ("p2c") for key derivation during decryption.
   * Per RFC 7518 Section 4.8.1.2, a minimum of 1000 is RECOMMENDED. Set to a lower value
   * only for test environments where speed is prioritized over security.
   *
   * @default 1000
   */
  minP2cCount?: number;
}

/**
 * Placeholder for specifying options during the JWE encryption process. Currently, this interface
 * does not define any specific options but can be extended in the future to include parameters
 * that control various aspects of the JWE encryption workflow.
 */
export interface JweEncryptOptions {}

/**
 * A minimal cipher interface over {@link KeyIdentifier} (e.g. KMS URI) referenced keys.
 *
 * When a JWE uses "dir" (Direct Encryption Mode) with a Content Encryption Key that is referenced
 * by a Key Identifier rather than provided as a JWK, the engine delegates content encryption and
 * decryption to an injected implementation of this interface. The agent's `LocalKeyManager`
 * satisfies this interface structurally.
 */
export interface JweCipher {
  /**
   * Decrypts the provided data using the key identified by `keyUri`.
   *
   * @param params - The parameters for the decryption operation.
   * @returns A Promise that resolves to the decrypted data as a byte array.
   */
  decrypt(params: { keyUri: KeyIdentifier; data: Uint8Array; iv?: Uint8Array; additionalData?: Uint8Array }): Promise<Uint8Array>;

  /**
   * Encrypts the provided data using the key identified by `keyUri`.
   *
   * @param params - The parameters for the encryption operation.
   * @returns A Promise that resolves to the ciphertext (including the authentication tag) as a
   *          byte array.
   */
  encrypt(params: { keyUri: KeyIdentifier; data: Uint8Array; iv?: Uint8Array; additionalData?: Uint8Array }): Promise<Uint8Array>;
}

/**
 * JSON Web Encryption (JWE) Header Parameters
 *
 * The Header Parameter names for use in JWEs are registered in the IANA "JSON Web Signature and
 * Encryption Header Parameters" registry.
 *
 * @see {@link https://datatracker.ietf.org/doc/html/rfc7516#section-4.1 | RFC 7516, Section 4.1}
 */
export interface JweHeaderParams extends JoseHeaderParams {
  /**
   * Algorithm Header Parameter
   *
   * Identifies the cryptographic algorithm used to encrypt or determine the value of the Content
   * Encryption Key (CEK). The encrypted content is not usable if the "alg" value does not represent
   * a supported algorithm, or if the recipient does not have a key that can be used with that
   * algorithm.
   *
   * "alg" values should either be registered in the IANA "JSON Web Signature and Encryption
   * Algorithms" registry or be a value that contains a Collision-Resistant Name. The "alg" value is
   * a case-sensitive ASCII string.  This Header Parameter MUST be present and MUST be understood
   * and processed by implementations.
   *
   * @see {@link https://datatracker.ietf.org/doc/html/rfc7516#section-4.1.1 | RFC 7516, Section 4.1.1}
   */
  alg:
    // Algorithms supported by this engine's key management
    | JweAlg
    // an unregistered, case-sensitive, collision-resistant string
    // `string & {}` preserves the literal hints above while still accepting any string.
    | (string & {});

  /**
   * Agreement PartyUInfo Header Parameter
   *
   * The "apu" (agreement PartyUInfo) value is a base64url-encoded octet sequence containing
   * information about the producer of the JWE.  This information is used by the recipient to
   * determine the key agreement algorithm and key encryption algorithm to use to decrypt the JWE.
   *
   * Note: This parameter is intended only for use when the recipient is a key agreement algorithm
   * that uses public key cryptography.
   */
  apu?: string;

  /**
   * Agreement PartyVInfo Header Parameter
   *
   * The "apv" (agreement PartyVInfo) value is a base64url-encoded octet sequence containing
   * information about the recipient of the JWE.  This information is used by the recipient to
   * determine the key agreement algorithm and key encryption algorithm to use to decrypt the JWE.
   *
   * Note: This parameter is intended only for use when the recipient is a key agreement algorithm
   * that uses public key cryptography.
   */
  apv?: string;

  /**
   * Critical Header Parameter
   *
   * Indicates that extensions to JOSE RFCs are being used that MUST be understood and processed.
   */
  crit?: string[];

  /**
   * Encryption Algorithm Header Parameter
   *
   * Identifies the content encryption algorithm used to encrypt and integrity-protect (also
   * known as "authenticated encryption") the plaintext and to integrity-protect the Additional
   * Authenticated Data (AAD), if any.  This algorithm MUST be an AEAD algorithm with a specified
   * key length.
   *
   * The encrypted content is not usable if the "enc" value does not represent a supported
   * algorithm.  "enc" values should either be registered in the IANA "JSON Web Signature and
   * Encryption Algorithms" registry or be a value that contains a Collision-Resistant Name. The
   * "enc" value is a case-sensitive ASCII string containing a StringOrURI value. This Header
   * Parameter MUST be present and MUST be understood and processed by implementations.
   *
   * @see {@link https://datatracker.ietf.org/doc/html/rfc7516#section-4.1.2 | RFC 7516, Section 4.1.2}
   */
  enc:
    // Algorithms supported by this engine's content encryption
    | JweEnc
    // an unregistered, case-sensitive, collision-resistant string
    // `string & {}` preserves the literal hints above while still accepting any string.
    | (string & {});

  /**
   * Ephemeral Public Key Header Parameter
   *
   * The "epk" (ephemeral public key) value created by the originator for the use in key agreement
   * algorithms.  It is the ephemeral public key that corresponds to the key used to encrypt the
   * JWE.  This value is represented as a JSON Web Key (JWK).
   *
   * Note: This parameter is intended only for use when the recipient is a key agreement algorithm
   * that uses public key cryptography.
   */
  epk?: Jwk;

  /**
   * Initialization Vector Header Parameter
   *
   * The "iv" (initialization vector) value is a base64url-encoded octet sequence used by the
   * specified "enc" algorithm.  The length of this Initialization Vector value MUST be exactly
   * equal to the value that would be produced by the "enc" algorithm.
   *
   * Note: With symmetric encryption algorithms such as AES GCM, this Header Parameter MUST
   * be present and MUST be understood and processed by implementations.
   */
  iv?: string;

  /**
   * PBES2 Count Header Parameter
   *
   * The "p2c" (PBES2 count) value is an integer indicating the number of iterations of the PBKDF2
   * algorithm performed during key derivation.
   *
   * Note: The iteration count adds computational expense, ideally compounded by the possible range
   * of keys introduced by the salt.  A minimum iteration count of 1000 is RECOMMENDED.
   */
  p2c?: number;

  /**
   * PBES2 Salt Input Header Parameter
   *
   * The "p2s" (PBES2 salt) value is a base64url-encoded octet sequence used as the salt value
   * input to the PBKDF2 algorithm during key derivation.
   *
   * The salt value used is (UTF8(Alg) || 0x00 || Salt Input), where Alg is the "alg" (algorithm)
   * Header Parameter value.
   *
   * Note: The salt value is used to ensure that each key derived from the master key is
   * independent of every other key. A suitable source of salt value is a sequence of
   * cryptographically random bytes containing 8 or more octets.
   */
  p2s?: string;

  /**
   * Authentication Tag Header Parameter
   *
   * The "tag" value is a base64url-encoded octet sequence containing the value of the
   * Authentication Tag output by the specified "enc" algorithm.  The length of this
   * Authentication Tag value MUST be exactly equal to the value that would be produced by the
   * "enc" algorithm.
   *
   * Note: With authenticated encryption algorithms such as AES GCM, this Header Parameter MUST
   * be present and MUST be understood and processed by implementations.
   */
  tag?: string;

  /**
   * Additional Public or Private Header Parameter names.
   */
  [key: string]: unknown;
}

/**
 * Checks if the provided object is a valid JWE (JSON Web Encryption) header.
 *
 * This function evaluates whether the given object adheres to the structure expected for
 * a JWE header, specifically looking for the presence and proper format of the "alg" (algorithm)
 * and "enc" (encryption algorithm) properties, which are essential for defining the JWE's
 * cryptographic operations.
 *
 * @example
 * ```ts
 * const header = {
 *   alg: 'dir',
 *   enc: 'A256GCM'
 * };
 *
 * if (isValidJweHeader(header)) {
 *   console.log('The object is a valid JWE header.');
 * } else {
 *   console.log('The object is not a valid JWE header.');
 * }
 * ```
 *
 * @param obj - The object to be validated as a JWE header.
 * @returns Returns `true` if the object is a valid JWE header, otherwise `false`.
 */
export function isValidJweHeader(obj: unknown): obj is JweHeaderParams {
  return typeof obj === 'object' && obj !== null
    && 'alg' in obj && obj.alg !== undefined
    && 'enc' in obj && obj.enc !== undefined;
}
