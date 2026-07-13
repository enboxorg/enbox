import type { Jwk } from '../jose/jwk.js';
import type { UnwrapKeyParams, WrapKeyParams } from '../types/params-direct.js';

import { aeskw } from '@noble/ciphers/aes.js';
import { Convert } from '@enbox/common';

import { computeJwkThumbprint, isOctPrivateJwk } from '../jose/jwk.js';
import { CryptoError, CryptoErrorCode } from '../crypto-error.js';
import { getWebcrypto, getWebcryptoSubtle } from './webcrypto.js';

/**
 * Constant defining the AES key length values in bits.
 *
 * @remarks
 * NIST publication FIPS 197 states:
 * > The AES algorithm is capable of using cryptographic keys of 128, 192, and 256 bits to encrypt
 * > and decrypt data in blocks of 128 bits.
 *
 * This implementation does not support key lengths that are different from the three values
 * defined by this constant.
 *
 * @see {@link https://doi.org/10.6028/NIST.FIPS.197-upd1 | NIST FIPS 197}
 */
const AES_KEY_LENGTHS = [128, 192, 256] as const;

/**
 * Cached result of the one-time probe for Web Crypto 'AES-KW' support.
 *
 * Most runtimes support AES-KW, but Electron compiles Node against BoringSSL,
 * whose WebCrypto build drops AES key wrapping ("Unrecognized algorithm
 * name"). When unsupported, {@link AesKw} transparently falls back to
 * `@noble/ciphers`' RFC 3394 implementation. Every wrap/unwrap input and
 * output of this class is a plain 'oct' JWK (raw bytes in `k`), and RFC 3394
 * output is implementation-independent, so the fallback is byte-compatible
 * with native WebCrypto in both directions.
 */
let webCryptoAesKwSupport: Promise<boolean> | undefined;

function hasWebCryptoAesKw(): Promise<boolean> {
  webCryptoAesKwSupport ??= (async (): Promise<boolean> => {
    try {
      const webCrypto = getWebcryptoSubtle() as unknown as SubtleCrypto;
      await webCrypto.importKey('raw', new Uint8Array(16), { name: 'AES-KW' }, false, ['wrapKey']);
      return true;
    } catch {
      return false;
    }
  })();
  return webCryptoAesKwSupport;
}

/**
 * Resets the cached AES-KW capability probe so the next operation re-detects.
 *
 * @internal For tests only.
 */
export function _resetWebCryptoAesKwDetection(): void {
  webCryptoAesKwSupport = undefined;
}

export class AesKw {
  /**
   * Converts a raw private key in bytes to its corresponding JSON Web Key (JWK) format.
   *
   * @remarks
   * This method takes a symmetric key represented as a byte array (Uint8Array) and
   * converts it into a JWK object for use with AES (Advanced Encryption Standard)
   * for key wrapping. The conversion process involves encoding the key into
   * base64url format and setting the appropriate JWK parameters.
   *
   * The resulting JWK object includes the following properties:
   * - `kty`: Key Type, set to 'oct' for Octet Sequence (representing a symmetric key).
   * - `k`: The symmetric key, base64url-encoded.
   * - `kid`: Key ID, generated based on the JWK thumbprint.
   *
   * @example
   * ```ts
   * const privateKeyBytes = new Uint8Array([...]); // Replace with actual symmetric key bytes
   * const privateKey = await AesKw.bytesToPrivateKey({ privateKeyBytes });
   * ```
   *
   * @param params - The parameters for the symmetric key conversion.
   * @param params.privateKeyBytes - The raw symmetric key as a Uint8Array.
   *
   * @returns A Promise that resolves to the symmetric key in JWK format.
   */
  public static async bytesToPrivateKey({ privateKeyBytes }: {
    privateKeyBytes: Uint8Array;
  }): Promise<Jwk> {
    // Construct the private key in JWK format.
    const privateKey: Jwk = {
      k   : Convert.uint8Array(privateKeyBytes).toBase64Url(),
      kty : 'oct'
    };

    // Compute the JWK thumbprint and set as the key ID.
    privateKey.kid = await computeJwkThumbprint({ jwk: privateKey });

    // Add algorithm identifier based on key length.
    const lengthInBits = privateKeyBytes.length * 8;
    privateKey.alg = { 128: 'A128KW', 192: 'A192KW', 256: 'A256KW' }[lengthInBits];

    return privateKey;
  }

  /**
   * Generates a symmetric key for AES for key wrapping in JSON Web Key (JWK) format.
   *
   * @remarks
   * This method creates a new symmetric key of a specified length suitable for use with
   * AES key wrapping. It uses cryptographically secure random number generation to
   * ensure the uniqueness and security of the key. The generated key adheres to the JWK
   * format, making it compatible with common cryptographic standards and easy to use in
   * various cryptographic processes.
   *
   * The generated key includes the following components:
   * - `kty`: Key Type, set to 'oct' for Octet Sequence.
   * - `k`: The symmetric key component, base64url-encoded.
   * - `kid`: Key ID, generated based on the JWK thumbprint.
   * - `alg`: Algorithm, set to 'A128KW', 'A192KW', or 'A256KW' for AES Key Wrap with the
   *   specified key length.
   *
   * @example
   * ```ts
   * const length = 256; // Length of the key in bits (e.g., 128, 192, 256)
   * const privateKey = await AesKw.generateKey({ length });
   * ```
   *
   * @param params - The parameters for the key generation.
   * @param params.length - The length of the key in bits. Common lengths are 128, 192, and 256 bits.
   *
   * @returns A Promise that resolves to the generated symmetric key in JWK format.
   */
  public static async generateKey({ length }: {
    length: typeof AES_KEY_LENGTHS[number];
  }): Promise<Jwk> {
    // Validate the key length.
    if (!(AES_KEY_LENGTHS as readonly number[]).includes(length)) {
      throw new RangeError(`The key length is invalid: Must be ${AES_KEY_LENGTHS.join(', ')} bits`);
    }

    // BoringSSL hosts (e.g. Electron) lack Web Crypto AES-KW: generate the
    // key material directly; bytesToPrivateKey builds the identical JWK shape.
    if (!(await hasWebCryptoAesKw())) {
      const privateKeyBytes = new Uint8Array(length / 8);
      getWebcrypto().getRandomValues(privateKeyBytes);
      return AesKw.bytesToPrivateKey({ privateKeyBytes });
    }

    // Get the Web Crypto API interface.
    const webCrypto = getWebcryptoSubtle() as unknown as SubtleCrypto;

    // Generate a random private key.
    // See https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues#usage_notes for
    // an explanation for why Web Crypto generateKey() is used instead of getRandomValues().
    const webCryptoKey = await webCrypto.generateKey( { name: 'AES-KW', length }, true, ['wrapKey', 'unwrapKey']);

    // Export the private key in JWK format.
    const { ext, key_ops, ...privateKey } = await webCrypto.exportKey('jwk', webCryptoKey) as Jwk;

    // Compute the JWK thumbprint and set as the key ID.
    privateKey.kid = await computeJwkThumbprint({ jwk: privateKey });

    return privateKey;
  }

  /**
   * Converts a private key from JSON Web Key (JWK) format to a raw byte array (Uint8Array).
   *
   * @remarks
   * This method takes a symmetric key in JWK format and extracts its raw byte representation.
   * It decodes the 'k' parameter of the JWK value, which represents the symmetric key in base64url
   * encoding, into a byte array.
   *
   * @example
   * ```ts
   * const privateKey = { ... }; // A symmetric key in JWK format
   * const privateKeyBytes = await AesKw.privateKeyToBytes({ privateKey });
   * ```
   *
   * @param params - The parameters for the symmetric key conversion.
   * @param params.privateKey - The symmetric key in JWK format.
   *
   * @returns A Promise that resolves to the symmetric key as a Uint8Array.
   */
  public static async privateKeyToBytes({ privateKey }: {
    privateKey: Jwk;
  }): Promise<Uint8Array> {
    // Verify the provided JWK represents a valid oct private key.
    if (!isOctPrivateJwk(privateKey)) {
      throw new Error(`AesKw: The provided key is not a valid oct private key.`);
    }

    // Decode the provided private key to bytes.
    const privateKeyBytes = Convert.base64Url(privateKey.k).toUint8Array();

    return privateKeyBytes;
  }

  public static async unwrapKey({ wrappedKeyBytes, wrappedKeyAlgorithm, decryptionKey }:
    UnwrapKeyParams
  ): Promise<Jwk> {
    if (!('alg' in decryptionKey && decryptionKey.alg)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwk, `The decryption key is missing the 'alg' property.`);
    }

    if (!['A128KW', 'A192KW', 'A256KW'].includes(decryptionKey.alg)) {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `The 'decryptionKey' algorithm is not supported: ${decryptionKey.alg}`);
    }

    // Map the private key's JOSE algorithm name to the Web Crypto API algorithm identifier.
    const webCryptoAlgorithm = {
      A128KW  : 'AES-KW', A192KW  : 'AES-KW', A256KW  : 'AES-KW',
      A128CTR : 'AES-CTR', A192CTR : 'AES-CTR', A256CTR : 'AES-CTR',
      A128GCM : 'AES-GCM', A192GCM : 'AES-GCM', A256GCM : 'AES-GCM',
    }[wrappedKeyAlgorithm];

    if (!webCryptoAlgorithm) {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `The 'wrappedKeyAlgorithm' is not supported: ${wrappedKeyAlgorithm}`);
    }

    // BoringSSL hosts (e.g. Electron) lack Web Crypto AES-KW: unwrap via the
    // RFC 3394 fallback. The result mirrors the native path's exported JWK —
    // kty/k plus an alg named for the actual key size and algorithm family,
    // and a kid thumbprint.
    if (!(await hasWebCryptoAesKw())) {
      const decryptionKeyBytes = await AesKw.privateKeyToBytes({ privateKey: decryptionKey });
      const unwrappedKeyBytes = aeskw(decryptionKeyBytes).decrypt(wrappedKeyBytes);

      const algorithmFamily = wrappedKeyAlgorithm.replace(/^A\d{3}/, '');
      const unwrappedKey: Jwk = {
        k   : Convert.uint8Array(unwrappedKeyBytes).toBase64Url(),
        kty : 'oct',
        alg : `A${unwrappedKeyBytes.length * 8}${algorithmFamily}`,
      };
      unwrappedKey.kid = await computeJwkThumbprint({ jwk: unwrappedKey });

      return unwrappedKey;
    }

    // Get the Web Crypto API interface.
    const webCrypto = getWebcryptoSubtle() as unknown as SubtleCrypto;

    // Import the decryption key for use with the Web Crypto API.
    const decryptionCryptoKey = await webCrypto.importKey(
      'jwk', // key format
      decryptionKey as JsonWebKey, // key data
      { name: 'AES-KW' }, // algorithm identifier
      true, // key is extractable
      ['unwrapKey'] // key usages
    );

    // Unwrap the key using the Web Crypto API.
    const unwrappedCryptoKey = await webCrypto.unwrapKey(
      'raw', // output format
      wrappedKeyBytes.buffer as ArrayBuffer, // key to unwrap
      decryptionCryptoKey, // unwrapping key
      'AES-KW', // algorithm identifier
      { name: webCryptoAlgorithm }, // unwrapped key algorithm identifier
      true, // key is extractable
      ['unwrapKey'] // key usages
    );

    // Export the unwrapped key in JWK format.
    const { ext, key_ops, ...unwrappedJsonWebKey } = await webCrypto.exportKey('jwk', unwrappedCryptoKey);
    const unwrappedKey = unwrappedJsonWebKey as Jwk;

    // Compute the JWK thumbprint and set as the key ID.
    unwrappedKey.kid = await computeJwkThumbprint({ jwk: unwrappedKey });

    return unwrappedKey;
  }

  public static async wrapKey({ unwrappedKey, encryptionKey }:
    WrapKeyParams
  ): Promise<Uint8Array> {
    if (!('alg' in encryptionKey && encryptionKey.alg)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwk, `The encryption key is missing the 'alg' property.`);
    }

    if (!['A128KW', 'A192KW', 'A256KW'].includes(encryptionKey.alg)) {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `The 'encryptionKey' algorithm is not supported: ${encryptionKey.alg}`);
    }

    if (!('alg' in unwrappedKey && unwrappedKey.alg)) {
      throw new CryptoError(CryptoErrorCode.InvalidJwk, `The private key to wrap is missing the 'alg' property.`);
    }

    // Map the private key's JOSE algorithm name to the Web Crypto API algorithm identifier.
    const webCryptoAlgorithm = {
      A128KW  : 'AES-KW', A192KW  : 'AES-KW', A256KW  : 'AES-KW',
      A128CTR : 'AES-CTR', A192CTR : 'AES-CTR', A256CTR : 'AES-CTR',
      A128GCM : 'AES-GCM', A192GCM : 'AES-GCM', A256GCM : 'AES-GCM',
    }[unwrappedKey.alg];

    if (!webCryptoAlgorithm) {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `The 'unwrappedKey' algorithm is not supported: ${unwrappedKey.alg}`);
    }

    // BoringSSL hosts (e.g. Electron) lack Web Crypto AES-KW: wrap via the
    // RFC 3394 fallback — the output is byte-identical to native WebCrypto.
    if (!(await hasWebCryptoAesKw())) {
      const encryptionKeyBytes = await AesKw.privateKeyToBytes({ privateKey: encryptionKey });
      const unwrappedKeyBytes = await AesKw.privateKeyToBytes({ privateKey: unwrappedKey });

      return aeskw(encryptionKeyBytes).encrypt(unwrappedKeyBytes);
    }

    // Get the Web Crypto API interface.
    const webCrypto = getWebcryptoSubtle() as unknown as SubtleCrypto;

    // Import the encryption key for use with the Web Crypto API.
    const encryptionCryptoKey = await webCrypto.importKey(
      'jwk', // key format
      encryptionKey as JsonWebKey, // key data
      { name: 'AES-KW' }, // algorithm identifier
      true, // key is extractable
      ['wrapKey'] // key usages
    );

    // Import the private key to wrap for use with the Web Crypto API.
    const unwrappedCryptoKey = await webCrypto.importKey(
      'jwk', // key format
      unwrappedKey as JsonWebKey, // key data
      { name: webCryptoAlgorithm }, // algorithm identifier
      true, // key is extractable
      ['unwrapKey'] // key usages
    );

    // Wrap the key using the Web Crypto API.
    const wrappedKeyBuffer = await webCrypto.wrapKey(
      'raw', // output format
      unwrappedCryptoKey, // key to wrap
      encryptionCryptoKey, // wrapping key
      'AES-KW' // algorithm identifier
    );

    // Convert from ArrayBuffer to Uint8Array.
    const wrappedKeyBytes = new Uint8Array(wrappedKeyBuffer);

    return wrappedKeyBytes;
  }
}
