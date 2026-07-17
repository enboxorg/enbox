import type { AsymmetricKeyConverter, Jwk, KeyCompressor } from '@enbox/crypto';
import type { MulticodecCode, MulticodecDefinition } from '@enbox/common';

import { Multicodec } from '@enbox/common';
import { Ed25519, Secp256k1, Secp256r1 } from '@enbox/crypto';

import { keyBytesToMultibaseId } from '../utils.js';
import { DidError, DidErrorCode } from '../did-error.js';

/**
 * Private helper that maps algorithm identifiers to their corresponding DID Key
 * {@link DidKeyRegisteredKeyType | registered key type}.
 *
 * Note: This is also used by `DidKeyUtils.publicKeyToMultibaseId()` to validate key types.
 */
export const AlgorithmToKeyTypeMap = {
  Ed25519   : 'Ed25519',
  ES256K    : 'secp256k1',
  ES256     : 'secp256r1',
  'P-256'   : 'secp256r1',
  secp256k1 : 'secp256k1',
  secp256r1 : 'secp256r1',
} as const;

/**
 * The `DidKeyUtils` class provides utility functions to support operations in the DID Key method.
 */
export class DidKeyUtils {
  /**
   * A mapping from JSON Web Key (JWK) property descriptors to multicodec names.
   *
   * This mapping is used to convert keys in JWK (JSON Web Key) format to multicodec format.
   *
   * @remarks
   * The keys of this object are strings that describe the JOSE key type and usage,
   * such as 'Ed25519:public', 'Ed25519:private', etc. The values are the corresponding multicodec
   * names used to represent these key types.
   *
   * @example
   * ```ts
   * const multicodecName = JWK_TO_MULTICODEC['Ed25519:public'];
   * // Returns 'ed25519-pub', the multicodec name for an Ed25519 public key
   * ```
   */
  private static readonly JWK_TO_MULTICODEC: { [key: string]: string } = {
    'Ed25519:public'    : 'ed25519-pub',
    'Ed25519:private'   : 'ed25519-priv',
    'secp256k1:public'  : 'secp256k1-pub',
    'secp256k1:private' : 'secp256k1-priv',
  };

  /**
   * Defines the expected byte lengths for public keys associated with different cryptographic
   * algorithms, indexed by their multicodec code values.
   */
  public static MULTICODEC_PUBLIC_KEY_LENGTH: Record<number, number> = {
    // secp256k1-pub - Secp256k1 public key (compressed) - 33 bytes
    0xe7: 33,

    // ed25519-pub - Ed25519 public key - 32 bytes
    0xed: 32
  };

  /**
   * A mapping from multicodec names to their corresponding JOSE (JSON Object Signing and Encryption)
   * representations. This mapping facilitates the conversion of multicodec key formats to
   * JWK (JSON Web Key) formats.
   *
   * @remarks
   * The keys of this object are multicodec names, such as 'ed25519-pub', 'ed25519-priv', etc.
   * The values are objects representing the corresponding JWK properties for that key type.
   *
   * @example
   * ```ts
   * const joseKey = MULTICODEC_TO_JWK['ed25519-pub'];
   * // Returns a partial JWK for an Ed25519 public key
   * ```
   */
  private static readonly MULTICODEC_TO_JWK: { [key: string]: Jwk } = {
    'ed25519-pub'    : { crv: 'Ed25519', kty: 'OKP', x: '' },
    'ed25519-priv'   : { crv: 'Ed25519', kty: 'OKP', x: '', d: '' },
    'secp256k1-pub'  : { crv: 'secp256k1', kty: 'EC', x: '', y: '' },
    'secp256k1-priv' : { crv: 'secp256k1', kty: 'EC', x: '', y: '', d: '' },
  };

  /**
   * Converts a JWK (JSON Web Key) to a Multicodec code and name.
   *
   * @example
   * ```ts
   * const jwk: Jwk = { crv: 'Ed25519', kty: 'OKP', x: '...' };
   * const { code, name } = await DidKeyUtils.jwkToMulticodec({ jwk });
   * ```
   *
   * @param params - The parameters for the conversion.
   * @param params.jwk - The JSON Web Key to be converted.
   * @returns A promise that resolves to a Multicodec definition.
   */
  public static async jwkToMulticodec({ jwk }: {
    jwk: Jwk
  }): Promise<MulticodecDefinition<MulticodecCode>> {
    const params: string[] = [];

    if (jwk.crv) {
      params.push(jwk.crv);
      if (jwk.d) {
        params.push('private');
      } else {
        params.push('public');
      }
    }

    const lookupKey = params.join(':');
    const name = DidKeyUtils.JWK_TO_MULTICODEC[lookupKey];

    if (name === undefined) {
      throw new Error(`Unsupported JWK to Multicodec conversion: '${lookupKey}'`);
    }

    const code = Multicodec.getCodeFromName({ name });

    return { code, name };
  }

  /**
   * Returns the appropriate public key compressor for the specified cryptographic curve.
   *
   * @param curve - The cryptographic curve to use for the key conversion.
   * @returns A public key compressor for the specified curve.
   */
  public static keyCompressor(
    curve: string
  ): KeyCompressor['compressPublicKey'] {
  // ): ({ publicKeyBytes }: { publicKeyBytes: Uint8Array }) => Promise<Uint8Array> {
    const compressors = {
      'P-256'     : Secp256r1.compressPublicKey,
      'secp256k1' : Secp256k1.compressPublicKey
    } as Record<string, KeyCompressor['compressPublicKey']>;

    const compressor = compressors[curve];

    if (!compressor) {throw new DidError(DidErrorCode.InvalidPublicKeyType, `Unsupported curve: ${curve}`);}

    return compressor;
  }

  /**
   * Returns the appropriate key converter for the specified cryptographic curve.
   *
   * @param curve - The cryptographic curve to use for the key conversion.
   * @returns An `AsymmetricKeyConverter` for the specified curve.
   */
  public static keyConverter(curve: string): AsymmetricKeyConverter {
    const converters: Record<string, AsymmetricKeyConverter> = {
      'Ed25519'   : Ed25519,
      'P-256'     : Secp256r1,
      'secp256k1' : Secp256k1,
    };

    const converter = converters[curve];

    if (!converter) {throw new DidError(DidErrorCode.InvalidPublicKeyType, `Unsupported curve: ${curve}`);}

    return converter;
  }

  /**
   * Converts a Multicodec code or name to parial JWK (JSON Web Key).
   *
   * @example
   * ```ts
   * const partialJwk = await DidKeyUtils.multicodecToJwk({ name: 'ed25519-pub' });
   * ```
   *
   * @param params - The parameters for the conversion.
   * @param params.code - Optional Multicodec code to convert.
   * @param params.name - Optional Multicodec name to convert.
   * @returns A promise that resolves to a JOSE format key.
   */
  public static async multicodecToJwk({ code, name }: {
    code?: MulticodecCode,
    name?: string
  }): Promise<Jwk> {
    // Either code or name must be specified, but not both.
    if (!(name ? !code : code)) {
      throw new Error(`Either 'name' or 'code' must be defined, but not both.`);
    }

    // If name is undefined, lookup by code.
    name = name ?? Multicodec.getNameFromCode({ code: code! });

    const lookupKey = name;
    const jose = DidKeyUtils.MULTICODEC_TO_JWK[lookupKey];

    if (jose === undefined) {
      throw new Error(`Unsupported Multicodec to JWK conversion`);
    }

    return { ...jose };
  }

  /**
   * Converts a public key in JWK (JSON Web Key) format to a multibase identifier.
   *
   * @remarks
   * Note: All secp public keys are converted to compressed point encoding
   *       before the multibase identifier is computed.
   *
   * Per {@link https://github.com/multiformats/multicodec/blob/master/table.csv | Multicodec table}:
   *    Public keys for Elliptic Curve cryptography algorithms (e.g., secp256k1,
   *    secp256k1r1, secp384r1, etc.) are always represented with compressed point
   *    encoding (e.g., secp256k1-pub, p256-pub, p384-pub, etc.).
   *
   * Per {@link https://datatracker.ietf.org/doc/html/rfc8812#name-jose-and-cose-secp256k1-cur | RFC 8812}:
   *    "As a compressed point encoding representation is not defined for JWK
   *    elliptic curve points, the uncompressed point encoding defined there
   *    MUST be used. The x and y values represented MUST both be exactly
   *    256 bits, with any leading zeros preserved."
   *
   * @example
   * ```ts
   * const publicKey = { crv: 'Ed25519', kty: 'OKP', x: '...' };
   * const multibaseId = await DidKeyUtils.publicKeyToMultibaseId({ publicKey });
   * ```
   *
   * @param params - The parameters for the conversion.
   * @param params.publicKey - The public key in JWK format.
   * @returns A promise that resolves to the multibase identifier.
   */
  public static async publicKeyToMultibaseId({ publicKey }: {
    publicKey: Jwk
  }): Promise<string> {
    if (!(publicKey?.crv && publicKey.crv in AlgorithmToKeyTypeMap)) {
      throw new DidError(DidErrorCode.InvalidPublicKeyType, `Public key contains an unsupported key type: ${publicKey?.crv ?? 'undefined'}`);
    }

    // Convert the public key from JWK format to a byte array.
    let publicKeyBytes = await DidKeyUtils.keyConverter(publicKey.crv).publicKeyToBytes({ publicKey });

    // Compress the public key if it is an elliptic curve key.
    if (/^(secp256k1|P-256|P-384|P-521)$/.test(publicKey.crv)) {
      publicKeyBytes = await DidKeyUtils.keyCompressor(publicKey.crv)({ publicKeyBytes });
    }

    // Convert the JSON Web Key (JWK) parameters to a Multicodec name.
    const { name: multicodecName } = await DidKeyUtils.jwkToMulticodec({ jwk: publicKey });

    // Compute the multibase identifier based on the provided key.
    const multibaseId = keyBytesToMultibaseId({
      keyBytes: publicKeyBytes,
      multicodecName
    });

    return multibaseId;
  }
}


