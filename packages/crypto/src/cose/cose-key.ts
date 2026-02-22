import type { Jwk } from '../jose/jwk.js';

import { Convert } from '@enbox/common';

import { CryptoError, CryptoErrorCode } from '../crypto-error.js';

/**
 * COSE Key Type values (RFC 9052, Section 7).
 *
 * @see {@link https://www.iana.org/assignments/cose/cose.xhtml#key-type | IANA COSE Key Types}
 */
export enum CoseKeyType {
  /** Octet Key Pair (e.g., Ed25519, X25519) */
  OKP = 1,
  /** Elliptic Curve (e.g., P-256, P-384, P-521) */
  EC2 = 2,
  /** Symmetric key */
  Symmetric = 4,
}

/**
 * COSE Elliptic Curve identifiers (RFC 9053, Section 7.1).
 *
 * @see {@link https://www.iana.org/assignments/cose/cose.xhtml#elliptic-curves | IANA COSE Elliptic Curves}
 */
export enum CoseEllipticCurve {
  /** NIST P-256 (secp256r1) */
  P256 = 1,
  /** NIST P-384 (secp384r1) */
  P384 = 2,
  /** NIST P-521 (secp521r1) */
  P521 = 3,
  /** X25519 for ECDH */
  X25519 = 4,
  /** X448 for ECDH */
  X448 = 5,
  /** Ed25519 for EdDSA */
  Ed25519 = 6,
  /** Ed448 for EdDSA */
  Ed448 = 7,
  /** secp256k1 */
  Secp256k1 = 8,
}

/**
 * COSE Algorithm identifiers (RFC 9053).
 *
 * Only includes algorithms relevant to Enbox confidential compute.
 *
 * @see {@link https://www.iana.org/assignments/cose/cose.xhtml#algorithms | IANA COSE Algorithms}
 */
export enum CoseAlgorithm {
  /** EdDSA (Ed25519 or Ed448) */
  EdDSA = -8,
  /** ECDSA with SHA-256 (P-256) */
  ES256 = -7,
  /** ECDSA with SHA-384 (P-384) */
  ES384 = -35,
  /** ECDSA with SHA-512 (P-521) */
  ES512 = -36,
  /** ECDSA with SHA-256 (secp256k1) */
  ES256K = -47,
}

/**
 * COSE Key common parameter labels (RFC 9052, Section 7.1).
 */
enum CoseKeyLabel {
  /** Key Type (kty) */
  Kty = 1,
  /** Key ID (kid) */
  Kid = 2,
  /** Algorithm */
  Alg = 3,
  /** Key Operations */
  KeyOps = 4,
  /** Base IV */
  BaseIv = 5,
}

/**
 * COSE Key type-specific parameter labels.
 *
 * For OKP and EC2 keys, the curve and coordinate labels share the same
 * negative-integer label space (RFC 9053, Section 7.1-7.2).
 */
enum CoseKeyParamLabel {
  /** Curve identifier (OKP and EC2) */
  Crv = -1,
  /** X coordinate (OKP public key or EC2 x-coordinate) */
  X = -2,
  /** Y coordinate (EC2 only) */
  Y = -3,
  /** Private key (OKP d value or EC2 d value) */
  D = -4,
}

/**
 * Maps JWK curve names to COSE elliptic curve identifiers.
 */
const jwkCrvToCose: Record<string, CoseEllipticCurve> = {
  'P-256'     : CoseEllipticCurve.P256,
  'P-384'     : CoseEllipticCurve.P384,
  'P-521'     : CoseEllipticCurve.P521,
  'X25519'    : CoseEllipticCurve.X25519,
  'Ed25519'   : CoseEllipticCurve.Ed25519,
  'Ed448'     : CoseEllipticCurve.Ed448,
  'secp256k1' : CoseEllipticCurve.Secp256k1,
};

/**
 * Maps COSE elliptic curve identifiers to JWK curve names.
 */
const coseCrvToJwk: Record<number, string> = {
  [CoseEllipticCurve.P256]      : 'P-256',
  [CoseEllipticCurve.P384]      : 'P-384',
  [CoseEllipticCurve.P521]      : 'P-521',
  [CoseEllipticCurve.X25519]    : 'X25519',
  [CoseEllipticCurve.Ed25519]   : 'Ed25519',
  [CoseEllipticCurve.Ed448]     : 'Ed448',
  [CoseEllipticCurve.Secp256k1] : 'secp256k1',
};

/**
 * Maps JWK algorithm names to COSE algorithm identifiers.
 */
const jwkAlgToCose: Record<string, CoseAlgorithm> = {
  'EdDSA'  : CoseAlgorithm.EdDSA,
  'ES256'  : CoseAlgorithm.ES256,
  'ES384'  : CoseAlgorithm.ES384,
  'ES512'  : CoseAlgorithm.ES512,
  'ES256K' : CoseAlgorithm.ES256K,
};

/**
 * Maps COSE algorithm identifiers to JWK algorithm names.
 */
const coseAlgToJwk: Record<number, string> = {
  [CoseAlgorithm.EdDSA]  : 'EdDSA',
  [CoseAlgorithm.ES256]  : 'ES256',
  [CoseAlgorithm.ES384]  : 'ES384',
  [CoseAlgorithm.ES512]  : 'ES512',
  [CoseAlgorithm.ES256K] : 'ES256K',
};

/**
 * Utilities for converting between JWK and COSE key representations.
 *
 * COSE keys use integer labels and CBOR encoding, while JWK uses string
 * property names and JSON. This class provides bidirectional conversion.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-7 | RFC 9052, Section 7}
 */
export class CoseKey {
  /**
   * Converts a JWK to a COSE key represented as a Map.
   *
   * @param jwk - The JWK to convert.
   * @returns A Map with integer labels as keys, suitable for CBOR encoding.
   * @throws {CryptoError} If the JWK key type or curve is not supported.
   */
  public static fromJwk(jwk: Jwk): Map<number, unknown> {
    const coseKey = new Map<number, unknown>();

    if (jwk.kty === 'OKP') {
      coseKey.set(CoseKeyLabel.Kty, CoseKeyType.OKP);

      const crv = jwk.crv;
      if (crv === undefined || !(crv in jwkCrvToCose)) {
        throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `CoseKey: unsupported OKP curve '${crv}'`);
      }
      coseKey.set(CoseKeyParamLabel.Crv, jwkCrvToCose[crv]);

      if (jwk.x !== undefined) {
        coseKey.set(CoseKeyParamLabel.X, Convert.base64Url(jwk.x as string).toUint8Array());
      }
      if (jwk.d !== undefined) {
        coseKey.set(CoseKeyParamLabel.D, Convert.base64Url(jwk.d as string).toUint8Array());
      }
    } else if (jwk.kty === 'EC') {
      coseKey.set(CoseKeyLabel.Kty, CoseKeyType.EC2);

      const crv = jwk.crv;
      if (crv === undefined || !(crv in jwkCrvToCose)) {
        throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `CoseKey: unsupported EC curve '${crv}'`);
      }
      coseKey.set(CoseKeyParamLabel.Crv, jwkCrvToCose[crv]);

      if (jwk.x !== undefined) {
        coseKey.set(CoseKeyParamLabel.X, Convert.base64Url(jwk.x as string).toUint8Array());
      }
      if (jwk.y !== undefined) {
        coseKey.set(CoseKeyParamLabel.Y, Convert.base64Url(jwk.y as string).toUint8Array());
      }
      if (jwk.d !== undefined) {
        coseKey.set(CoseKeyParamLabel.D, Convert.base64Url(jwk.d as string).toUint8Array());
      }
    } else {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `CoseKey: unsupported key type '${jwk.kty}'`);
    }

    if (jwk.kid !== undefined) {
      coseKey.set(CoseKeyLabel.Kid, Convert.string(jwk.kid).toUint8Array());
    }

    if (jwk.alg !== undefined && jwk.alg in jwkAlgToCose) {
      coseKey.set(CoseKeyLabel.Alg, jwkAlgToCose[jwk.alg]);
    }

    return coseKey;
  }

  /**
   * Converts a COSE key Map to a JWK.
   *
   * @param coseKey - A Map with integer labels as keys (from CBOR decoding).
   * @returns The equivalent JWK.
   * @throws {CryptoError} If the COSE key type or curve is not supported.
   */
  public static toJwk(coseKey: Map<number, unknown>): Jwk {
    const kty = coseKey.get(CoseKeyLabel.Kty) as number;

    if (kty === CoseKeyType.OKP) {
      const crv = coseKey.get(CoseKeyParamLabel.Crv) as number;
      if (!(crv in coseCrvToJwk)) {
        throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `CoseKey: unsupported COSE OKP curve ${crv}`);
      }

      const jwk: Jwk = {
        kty : 'OKP',
        crv : coseCrvToJwk[crv],
      };

      const x = coseKey.get(CoseKeyParamLabel.X) as Uint8Array | undefined;
      if (x !== undefined) {
        jwk.x = Convert.uint8Array(x).toBase64Url();
      }

      const d = coseKey.get(CoseKeyParamLabel.D) as Uint8Array | undefined;
      if (d !== undefined) {
        jwk.d = Convert.uint8Array(d).toBase64Url();
      }

      CoseKey.applyCommonFields(coseKey, jwk);
      return jwk;

    } else if (kty === CoseKeyType.EC2) {
      const crv = coseKey.get(CoseKeyParamLabel.Crv) as number;
      if (!(crv in coseCrvToJwk)) {
        throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `CoseKey: unsupported COSE EC2 curve ${crv}`);
      }

      const jwk: Jwk = {
        kty : 'EC',
        crv : coseCrvToJwk[crv],
      };

      const x = coseKey.get(CoseKeyParamLabel.X) as Uint8Array | undefined;
      if (x !== undefined) {
        jwk.x = Convert.uint8Array(x).toBase64Url();
      }

      const y = coseKey.get(CoseKeyParamLabel.Y) as Uint8Array | undefined;
      if (y !== undefined) {
        jwk.y = Convert.uint8Array(y).toBase64Url();
      }

      const d = coseKey.get(CoseKeyParamLabel.D) as Uint8Array | undefined;
      if (d !== undefined) {
        jwk.d = Convert.uint8Array(d).toBase64Url();
      }

      CoseKey.applyCommonFields(coseKey, jwk);
      return jwk;

    } else {
      throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `CoseKey: unsupported COSE key type ${kty}`);
    }
  }

  /**
   * Infers the COSE algorithm identifier from a JWK.
   *
   * If the JWK has an `alg` field, it is used directly. Otherwise, the algorithm
   * is inferred from the key type and curve.
   *
   * @param jwk - The JWK to infer the algorithm from.
   * @returns The COSE algorithm identifier.
   * @throws {CryptoError} If the algorithm cannot be determined.
   */
  public static algorithmFromJwk(jwk: Jwk): CoseAlgorithm {
    if (jwk.alg !== undefined && jwk.alg in jwkAlgToCose) {
      return jwkAlgToCose[jwk.alg];
    }

    // Infer from key type and curve.
    if (jwk.kty === 'OKP') {
      if (jwk.crv === 'Ed25519' || jwk.crv === 'Ed448') {
        return CoseAlgorithm.EdDSA;
      }
    } else if (jwk.kty === 'EC') {
      switch (jwk.crv) {
        case 'P-256': return CoseAlgorithm.ES256;
        case 'P-384': return CoseAlgorithm.ES384;
        case 'P-521': return CoseAlgorithm.ES512;
        case 'secp256k1': return CoseAlgorithm.ES256K;
      }
    }

    throw new CryptoError(
      CryptoErrorCode.AlgorithmNotSupported,
      `CoseKey: cannot determine COSE algorithm for key type '${jwk.kty}' curve '${jwk.crv}'`
    );
  }

  /**
   * Maps a COSE algorithm identifier to a JWK algorithm name.
   *
   * @param alg - The COSE algorithm identifier.
   * @returns The JWK algorithm name.
   * @throws {CryptoError} If the algorithm is not supported.
   */
  public static algorithmToJwk(alg: CoseAlgorithm): string {
    if (alg in coseAlgToJwk) {
      return coseAlgToJwk[alg];
    }
    throw new CryptoError(CryptoErrorCode.AlgorithmNotSupported, `CoseKey: unsupported COSE algorithm ${alg}`);
  }

  /**
   * Applies common COSE key fields (kid, alg) to a JWK.
   */
  private static applyCommonFields(coseKey: Map<number, unknown>, jwk: Jwk): void {
    const kid = coseKey.get(CoseKeyLabel.Kid) as Uint8Array | undefined;
    if (kid !== undefined) {
      jwk.kid = Convert.uint8Array(kid).toString();
    }

    const alg = coseKey.get(CoseKeyLabel.Alg) as number | undefined;
    if (alg !== undefined && alg in coseAlgToJwk) {
      jwk.alg = coseAlgToJwk[alg];
    }
  }
}
