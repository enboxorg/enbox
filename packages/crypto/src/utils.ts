import type { Cipher } from './types/cipher.js';
import type { Jwk } from './jose/jwk.js';
import type { KeyWrapper } from './types/key-wrapper.js';
import type { KeyExporter, KeyImporter } from './types/key-io.js';

import { crypto } from '@noble/hashes/crypto';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';

/**
 * A collection of cryptographic utility methods.
 */
export class CryptoUtils {

  /**
   * Determines the JOSE algorithm identifier of the digital signature algorithm based on the `alg` or
   * `crv` property of a {@link Jwk | JWK}.
   *
   * If the `alg` property is present, its value takes precedence and is returned. Otherwise, the
   * `crv` property is used to determine the algorithm.
   *
   * @memberof CryptoUtils
   * @see {@link https://www.iana.org/assignments/jose/jose.xhtml#web-signature-encryption-algorithms | JOSE Algorithms}
   * @see {@link https://datatracker.ietf.org/doc/draft-ietf-jose-fully-specified-algorithms/ | Fully-Specified Algorithms for JOSE and COSE}
   *
   * @example
   * ```ts
   * const publicKey: Jwk = {
   *   "kty": "OKP",
   *   "crv": "Ed25519",
   *   "x": "FEJG7OakZi500EydXxuE8uMc8uaAzEJkmQeG8khXANw"
   * }
   * const algorithm = getJoseSignatureAlgorithmFromPublicKey(publicKey);
   * console.log(algorithm); // Output: "EdDSA"
   * ```
   * @param publicKey - A JWK containing the `alg` and/or `crv` properties.
   * @returns The name of the algorithm associated with the key.
   * @throws Error if the algorithm cannot be determined from the provided input.
   */
  static getJoseSignatureAlgorithmFromPublicKey(publicKey: Jwk): string {
    const curveToJoseAlgorithm: Record<string, string> = {
      'Ed25519'   : 'EdDSA',
      'P-256'     : 'ES256',
      'P-384'     : 'ES384',
      'P-521'     : 'ES512',
      'secp256k1' : 'ES256K',
    };

    // If the key contains an `alg` property that matches a JOSE registered algorithm identifier,
    // return its value.
    if (publicKey.alg && Object.values(curveToJoseAlgorithm).includes(publicKey.alg)) {
      return publicKey.alg;
    }

    // If the key contains a `crv` property, return the corresponding algorithm.
    if (publicKey.crv && Object.keys(curveToJoseAlgorithm).includes(publicKey.crv)) {
      return curveToJoseAlgorithm[publicKey.crv];
    }

    throw new Error(
      `Unable to determine algorithm based on provided input: alg=${publicKey.alg}, crv=${publicKey.crv}. ` +
      `Supported 'alg' values: ${Object.values(curveToJoseAlgorithm).join(', ')}. ` +
      `Supported 'crv' values: ${Object.keys(curveToJoseAlgorithm).join(', ')}.`
    );
  }

  /**
   * Generates secure pseudorandom values of the specified length using
   * `crypto.getRandomValues`, which defers to the operating system.
   *
   * @memberof CryptoUtils
   * @remarks
   * This function is a wrapper around `randomBytes` from the '@noble/hashes'
   * package. It's designed to be cryptographically strong, suitable for
   * generating initialization vectors, nonces, and other random values.
   *
   * @see {@link https://www.npmjs.com/package/@noble/hashes | @noble/hashes on NPM} for more
   * information about the underlying implementation.
   *
   * @example
   * ```ts
   * const bytes = randomBytes(32); // Generates 32 random bytes
   * ```
   *
   * @param bytesLength - The number of bytes to generate.
   * @returns A Uint8Array containing the generated random bytes.
   */
  static randomBytes(bytesLength: number): Uint8Array {
    return nobleRandomBytes(bytesLength);
  }

  /**
   * Generates a UUID (Universally Unique Identifier) using a
   * cryptographically strong random number generator following
   * the version 4 format, as specified in RFC 4122.
   *
   * A version 4 UUID is a randomly generated UUID. The 13th character
   * is set to '4' to denote version 4, and the 17th character is one
   * of '8', '9', 'A', or 'B' to comply with the variant 1 format of
   * UUIDs (the high bits are set to '10').
   *
   * The UUID is a 36 character string, including hyphens, and looks like this:
   * xxxxxxxx-xxxx-4xxx-axxx-xxxxxxxxxxxx
   *
   * Note that while UUIDs are not guaranteed to be unique, they are
   * practically unique" given the large number of possible UUIDs and
   * the randomness of generation.
   * @memberof CryptoUtils
   * @example
   * ```ts
   * const uuid = randomUuid();
   * console.log(uuid); // Outputs a version 4 UUID, e.g., '123e4567-e89b-12d3-a456-426655440000'
   * ```
   *
   * @returns A string containing a randomly generated, 36 character long v4 UUID.
   */
  static randomUuid(): string {
    const uuid = crypto.randomUUID();

    return uuid;
  }


  /**
   * Generates a secure random PIN (Personal Identification Number) of a
   * specified length.
   *
   * This function ensures that the generated PIN is cryptographically secure and
   * uniformly distributed by using rejection sampling. It repeatedly generates
   * random numbers until it gets one in the desired range [0, max]. This avoids
   * bias introduced by simply taking the modulus or truncating the number.
   *
   * Note: The function can generate PINs of 3 to 10 digits in length.
   * Any request for a PIN outside this range will result in an error.
   *
   * Example usage:
   *
   * ```ts
   * const pin = randomPin({ length: 4 });
   * console.log(pin); // Outputs a 4-digit PIN, e.g., "0231"
   * ```
   * @memberof CryptoUtils
   * @param options - The options object containing the desired length of the generated PIN.
   * @param options.length - The desired length of the generated PIN. The value should be
   *                         an integer between 3 and 8 inclusive.
   *
   * @returns A string representing the generated PIN. The PIN will be zero-padded
   *          to match the specified length, if necessary.
   *
   * @throws Will throw an error if the requested PIN length is less than 3 or greater than 8.
   */
  static randomPin({ length }: { length: number }): string {
    if (3 > length || length > 10) {
      throw new Error('randomPin() can securely generate a PIN between 3 to 10 digits.');
    }

    const pinRange = 10 ** length;
    const byteLength = Math.ceil(Math.log2(pinRange) / 8);
    const randomSpace = 2 ** (byteLength * 8);
    const unbiasedLimit = randomSpace - (randomSpace % pinRange);

    let randomValue: number;
    do {
      randomValue = 0;
      const randomBuffer = CryptoUtils.randomBytes(byteLength);
      for (const byte of randomBuffer) {
        randomValue = (randomValue * 256) + byte;
      }
    } while (randomValue >= unbiasedLimit);

    const pin = randomValue % pinRange;

    // Pad the PIN with leading zeros to the desired length.
    return pin.toString().padStart(length, '0');
  }
}

/**
 * Type guard that checks whether the given object implements the {@link Cipher} interface.
 */
export function isCipher<EncryptInput, DecryptInput>(
  obj: unknown
): obj is Cipher<EncryptInput, DecryptInput> {
  return (
    obj !== null && typeof obj === 'object'
    && 'encrypt' in obj && typeof obj.encrypt === 'function'
    && 'decrypt' in obj && typeof obj.decrypt === 'function'
  );
}

/**
 * Type guard that checks whether the given object implements the {@link KeyExporter} interface.
 */
export function isKeyExporter<ExportKeyInput, ExportKeyOutput>(
  obj: unknown
): obj is KeyExporter<ExportKeyInput, ExportKeyOutput> {
  return (
    obj !== null && typeof obj === 'object'
    && 'exportKey' in obj && typeof obj.exportKey === 'function'
  );
}

/**
 * Type guard that checks whether the given object implements the {@link KeyImporter} interface.
 */
export function isKeyImporter<ImportKeyInput, ImportKeyOutput>(
  obj: unknown
): obj is KeyImporter<ImportKeyInput, ImportKeyOutput> {
  return (
    obj !== null && typeof obj === 'object'
    && 'importKey' in obj && typeof obj.importKey === 'function'
  );
}

/**
 * Type guard that checks whether the given object implements the {@link KeyWrapper} interface.
 */
export function isKeyWrapper<WrapKeyInput, UnwrapKeyInput>(
  obj: unknown
): obj is KeyWrapper<WrapKeyInput, UnwrapKeyInput> {
  return (
    obj !== null && typeof obj === 'object'
    && 'wrapKey' in obj && typeof obj.wrapKey === 'function'
    && 'unwrapKey' in obj && typeof obj.unwrapKey === 'function'
  );
}
