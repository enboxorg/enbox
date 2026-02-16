import type { JwkParamsEcPrivate, JwkParamsEcPublic } from '@enbox/crypto';
import type { PrivateKeyJwk, PublicKeyJwk } from '../types/jose-types.js';

import * as secp256k1 from '@noble/secp256k1';

import { Encoder } from '../utils/encoder.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';


/**
 * Class containing SECP256K1 related utility methods.
 */
export class Secp256k1 {
  /**
   * Validates the given JWK is a SECP256K1 key.
   * @throws {Error} if fails validation.
   */
  public static validateKey(jwk: PrivateKeyJwk | PublicKeyJwk): void {
    if (jwk.kty !== 'EC' || (jwk as JwkParamsEcPublic).crv !== 'secp256k1') {
      throw new DwnError(DwnErrorCode.Secp256k1KeyNotValid, 'Invalid SECP256K1 JWK: `kty` MUST be `EC`. `crv` MUST be `secp256k1`');
    }
  }

  /**
   * Converts a public key in bytes into a JWK.
   */
  public static async publicKeyToJwk(publicKeyBytes: Uint8Array): Promise<PublicKeyJwk> {
  // ensure public key is in uncompressed format so we can convert it into both x and y value
    let uncompressedPublicKeyBytes;
    if (publicKeyBytes.byteLength === 33) {
      // this means given key is compressed
      const curvePoints = secp256k1.ProjectivePoint.fromHex(publicKeyBytes);
      uncompressedPublicKeyBytes = curvePoints.toRawBytes(false); // isCompressed = false
    } else {
      uncompressedPublicKeyBytes = publicKeyBytes;
    }

    // the first byte is a header that indicates whether the key is uncompressed (0x04 if uncompressed), we can safely ignore
    // bytes 1 - 32 represent X
    // bytes 33 - 64 represent Y

    // skip the first byte because it's used as a header to indicate whether the key is uncompressed
    const x = Encoder.bytesToBase64Url(uncompressedPublicKeyBytes.subarray(1, 33));
    const y = Encoder.bytesToBase64Url(uncompressedPublicKeyBytes.subarray(33, 65));

    const publicJwk: PublicKeyJwk = {
      alg : 'ES256K',
      kty : 'EC',
      crv : 'secp256k1',
      x,
      y
    };

    return publicJwk;
  }

  /**
   * Converts a private key in bytes into a JWK.
   */
  public static async privateKeyToJwk(privateKeyBytes: Uint8Array): Promise<PrivateKeyJwk> {
    const publicKeyBytes = await Secp256k1.getPublicKey(privateKeyBytes);

    const jwk = await Secp256k1.publicKeyToJwk(publicKeyBytes);
    (jwk as JwkParamsEcPrivate).d = Encoder.bytesToBase64Url(privateKeyBytes);

    return jwk as PrivateKeyJwk;
  }

  /**
   * Creates a compressed key in raw bytes from the given SECP256K1 JWK.
   */
  public static publicJwkToBytes(publicJwk: PublicKeyJwk): Uint8Array {
    const ecJwk = publicJwk as JwkParamsEcPublic;
    const x = Encoder.base64UrlToBytes(ecJwk.x);
    const y = Encoder.base64UrlToBytes(ecJwk.y!);

    return secp256k1.ProjectivePoint.fromAffine({
      x : secp256k1.etc.bytesToNumberBE(x),
      y : secp256k1.etc.bytesToNumberBE(y)
    }).toRawBytes(true);
  }

  /**
   * Creates a private key in raw bytes from the given SECP256K1 JWK.
   */
  public static privateJwkToBytes(privateJwk: PrivateKeyJwk): Uint8Array {
    const privateKey = Encoder.base64UrlToBytes((privateJwk as JwkParamsEcPrivate).d);
    return privateKey;
  }

  /**
   * Signs the provided content using the provided JWK.
   */
  public static async sign(content: Uint8Array, privateJwk: PrivateKeyJwk): Promise<Uint8Array> {
    Secp256k1.validateKey(privateJwk);

    // the underlying lib expects us to hash the content ourselves:
    // https://github.com/paulmillr/noble-secp256k1/blob/97aa518b9c12563544ea87eba471b32ecf179916/index.ts#L1160
    const hashedContent = await sha256.encode(content);
    const privateKeyBytes = Secp256k1.privateJwkToBytes(privateJwk);

    return (await secp256k1.signAsync(hashedContent, privateKeyBytes)).toCompactRawBytes();
  }

  /**
   * Verifies a signature against the provided payload hash and public key.
   * @returns a boolean indicating whether the signature is valid.
   */
  public static async verify(content: Uint8Array, signature: Uint8Array, publicJwk: PublicKeyJwk): Promise<boolean> {
    Secp256k1.validateKey(publicJwk);

    const publicKeyBytes = Secp256k1.publicJwkToBytes(publicJwk);
    const hashedContent = await sha256.encode(content);
    return secp256k1.verify(signature, hashedContent, publicKeyBytes, { lowS: false });
  }

  /**
   * Generates a random key pair in JWK format.
   */
  public static async generateKeyPair(): Promise<{publicJwk: PublicKeyJwk, privateJwk: PrivateKeyJwk}> {
    const privateKeyBytes = secp256k1.utils.randomPrivateKey();
    const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, false); // `false` = uncompressed

    const d = Encoder.bytesToBase64Url(privateKeyBytes);
    const publicJwk: PublicKeyJwk = await Secp256k1.publicKeyToJwk(publicKeyBytes);
    const privateJwk: PrivateKeyJwk = { ...publicJwk, d };

    return { publicJwk, privateJwk };
  }

  /**
   * Generates key pair in raw bytes, where the `publicKey` is compressed.
   */
  public static async generateKeyPairRaw(): Promise<{publicKey: Uint8Array, privateKey: Uint8Array}> {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const publicKey = secp256k1.getPublicKey(privateKey, true); // `true` = compressed

    return { publicKey, privateKey };
  }

  /**
   * Gets the compressed public key of the given private key.
   */
  public static async getPublicKey(privateKey: Uint8Array): Promise<Uint8Array> {
    const publicKey = secp256k1.getPublicKey(privateKey, true); // `true` = compressed
    return publicKey;
  }

  /**
   * Gets the public JWK of the given private JWK.
   */
  public static async getPublicJwk(privateKeyJwk: PrivateKeyJwk): Promise<PublicKeyJwk> {
    // strip away `d`
    const { d: _d, ...publicKey } = privateKeyJwk as JwkParamsEcPrivate;
    return publicKey as PublicKeyJwk;
  }
}

