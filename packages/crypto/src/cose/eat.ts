import type { CoseSign1ProtectedHeader } from './cose-sign1.js';
import type { Jwk } from '../jose/jwk.js';

import { Cbor } from './cbor.js';
import { CoseSign1 } from './cose-sign1.js';
import { CryptoError, CryptoErrorCode } from '../crypto-error.js';

/**
 * EAT (Entity Attestation Token) claim key constants.
 *
 * EAT reuses CWT registered claim keys and adds attestation-specific claims.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9711 | RFC 9711 — Entity Attestation Token (EAT)}
 * @see {@link https://www.rfc-editor.org/rfc/rfc8392 | RFC 8392 — CWT (CBOR Web Token)}
 */
export enum EatClaimKey {
  /** Issuer (iss) — RFC 8392 */
  Iss = 1,
  /** Subject (sub) — RFC 8392 */
  Sub = 2,
  /** Audience (aud) — RFC 8392 */
  Aud = 3,
  /** Expiration Time (exp) — RFC 8392 */
  Exp = 4,
  /** Not Before (nbf) — RFC 8392 */
  Nbf = 5,
  /** Issued At (iat) — RFC 8392 */
  Iat = 6,
  /** CWT ID (cti) — RFC 8392 */
  Cti = 7,
  /** Nonce (eat_nonce) — RFC 9711, Section 4.1 */
  Nonce = 10,
  /** UEID (Universal Entity ID) — RFC 9711, Section 4.2.1 */
  Ueid = 256,
  /** SUEIDs (Semi-permanent UEIDs) — RFC 9711, Section 4.2.2 */
  Sueids = 257,
  /** OEM ID (Hardware OEM Identification) — RFC 9711, Section 4.2.3 */
  Oemid = 258,
  /** Hardware Model — RFC 9711, Section 4.2.4 */
  Hwmodel = 259,
  /** Hardware Version — RFC 9711, Section 4.2.5 */
  Hwversion = 260,
  /** Secure Boot — RFC 9711, Section 4.2.7 */
  Secboot = 262,
  /** Debug Status — RFC 9711, Section 4.2.8 */
  Dbgstat = 263,
  /** Location — RFC 9711, Section 4.2.9 */
  Location = 264,
  /** Profile — RFC 9711, Section 4.2.10 */
  Profile = 265,
  /** Submods (Submodules) — RFC 9711, Section 4.2.18 */
  Submods = 266,
  /** Measurement Results — RFC 9711, Section 4.2.15 */
  Measres = 272,
  /** Intended Use — RFC 9711, Section 4.2.14 */
  Intuse = 268,
}

/**
 * Debug status values for the `dbgstat` claim.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9711#section-4.2.8 | RFC 9711, Section 4.2.8}
 */
export enum EatDebugStatus {
  /** Debug is enabled */
  Enabled = 0,
  /** Debug is disabled */
  Disabled = 1,
  /** Debug is disabled since manufacture */
  DisabledSinceBoot = 2,
  /** Debug is disabled permanently */
  DisabledPermanently = 3,
  /** Debug is disabled fully and permanently */
  DisabledFullyAndPermanently = 4,
}

/**
 * Security level for the `seclevel` claim.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9711#section-4.2.6 | RFC 9711, Section 4.2.6}
 */
export enum EatSecurityLevel {
  /** Unrestricted — no security guarantees */
  Unrestricted = 1,
  /** Restricted — some restrictions on environment */
  Restricted = 2,
  /** Secure Restricted — hardware-enforced restrictions */
  SecureRestricted = 3,
  /** Hardware — hardware-isolated execution environment */
  Hardware = 4,
}

/**
 * Parsed EAT claims, providing typed access to standard and attestation-specific claims.
 *
 * All fields are optional because EAT does not mandate any specific claims; the
 * required set depends on the attestation profile.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9711 | RFC 9711}
 */
export interface EatClaims {
  /** Issuer — identifies the entity that issued the token. */
  iss?: string;

  /** Subject — identifies the entity that is the subject of the token. */
  sub?: string;

  /** Audience — identifies the intended recipient(s). */
  aud?: string;

  /** Expiration time (seconds since epoch). */
  exp?: number;

  /** Not Before (seconds since epoch). */
  nbf?: number;

  /** Issued At (seconds since epoch). */
  iat?: number;

  /** CWT ID — unique token identifier (byte string). */
  cti?: Uint8Array;

  /** Nonce — challenge value binding the token to a request. */
  nonce?: Uint8Array | Uint8Array[];

  /** Universal Entity ID. */
  ueid?: Uint8Array;

  /** Hardware model identifier. */
  hwmodel?: Uint8Array;

  /** Hardware version. */
  hwversion?: unknown;

  /** Debug status. */
  dbgstat?: EatDebugStatus;

  /** Measurement results — software component measurements. */
  measres?: unknown;

  /** Submodules — nested EAT tokens or claims from sub-components. */
  submods?: Map<string, unknown>;

  /**
   * All raw claims as a Map for access to non-standard or profile-specific claims.
   * Integer keys correspond to {@link EatClaimKey} values.
   */
  rawClaims: Map<number | string, unknown>;
}

/**
 * Parameters for decoding an EAT token.
 */
export interface EatDecodeParams {
  /** The CBOR-encoded EAT token (COSE_Sign1 envelope). */
  token: Uint8Array;
}

/**
 * Parameters for verifying and decoding an EAT token.
 */
export interface EatVerifyParams {
  /** The CBOR-encoded EAT token (COSE_Sign1 envelope). */
  token: Uint8Array;

  /** The public key for signature verification, in JWK format. */
  key: Jwk;

  /** External additional authenticated data. Defaults to empty bytes. */
  externalAad?: Uint8Array;
}

/**
 * Result of decoding an EAT token.
 */
export interface EatDecodeResult {
  /** The parsed protected header from the COSE_Sign1 envelope. */
  protectedHeader: CoseSign1ProtectedHeader;

  /** The parsed EAT claims from the payload. */
  claims: EatClaims;
}

/**
 * Entity Attestation Token (EAT) implementation per RFC 9711.
 *
 * EATs are CBOR-based attestation tokens carried in COSE_Sign1 envelopes.
 * They are used by TEE platforms (ARM CCA, Intel TDX, AMD SEV-SNP, Nitro Enclaves)
 * to provide hardware-rooted attestation evidence.
 *
 * This implementation focuses on decoding and verification of EAT tokens — the
 * primary use case for a DWN node that needs to verify TEE attestation from
 * compute modules.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9711 | RFC 9711 — Entity Attestation Token (EAT)}
 */
export class Eat {
  /**
   * Decodes an EAT token without verifying its signature.
   *
   * Use this method only when signature verification is performed separately
   * (e.g., by a TEE attestation service) or for debugging/inspection.
   *
   * @param params - The parameters for decoding.
   * @returns The decoded protected header and claims.
   * @throws {CryptoError} If the token is not valid COSE_Sign1 or the payload is not valid CBOR.
   */
  public static decode({ token }: EatDecodeParams): EatDecodeResult {
    // Decode the COSE_Sign1 envelope.
    const coseSign1 = CoseSign1.decode(token);

    if (coseSign1.payload === null) {
      throw new CryptoError(
        CryptoErrorCode.InvalidEat,
        'Eat: token has detached payload; use verifyAndDecode with the payload provided separately'
      );
    }

    // Decode the CBOR payload into claims.
    const claims = Eat.parseClaims(coseSign1.payload);

    return {
      protectedHeader: coseSign1.protectedHeader,
      claims,
    };
  }

  /**
   * Verifies the signature of an EAT token and decodes its claims.
   *
   * This is the primary method for processing EAT tokens from TEE attestation.
   * It verifies the COSE_Sign1 signature using the provided public key, then
   * parses the EAT claims from the payload.
   *
   * @param params - The parameters for verification and decoding.
   * @returns The decoded protected header and claims if verification succeeds.
   * @throws {CryptoError} If verification fails or the token is malformed.
   */
  public static async verifyAndDecode(params: EatVerifyParams): Promise<EatDecodeResult> {
    const { token, key, externalAad } = params;

    // Verify the COSE_Sign1 signature.
    const isValid = await CoseSign1.verify({
      coseSign1: token,
      key,
      externalAad,
    });

    if (!isValid) {
      throw new CryptoError(
        CryptoErrorCode.InvalidEat,
        'Eat: signature verification failed'
      );
    }

    // Decode and return claims (signature is already verified).
    return Eat.decode({ token });
  }

  /**
   * Parses CBOR-encoded EAT claims into a typed {@link EatClaims} object.
   *
   * Handles both integer-keyed (CBOR standard) and string-keyed claims.
   *
   * @param payload - The CBOR-encoded claims byte string.
   * @returns The parsed EAT claims.
   * @throws {CryptoError} If the payload is not valid CBOR or not a map.
   */
  private static parseClaims(payload: Uint8Array): EatClaims {
    const rawClaims = Eat.decodeRawClaims(payload);

    const claims: EatClaims = { rawClaims };

    // Extract standard CWT claims.
    Eat.applyCwtClaims(rawClaims, claims);

    // Extract EAT-specific claims.
    Eat.applyEatSpecificClaims(rawClaims, claims);

    return claims;
  }

  /**
   * Decodes the CBOR-encoded EAT payload into a label-keyed claims Map.
   *
   * Handles both integer-keyed (CBOR standard) and string-keyed claims: the `cborg` library
   * decodes CBOR maps as JavaScript `Map` instances, but some encoders produce plain objects
   * instead of Maps for maps with string keys.
   *
   * @param payload - The CBOR-encoded claims byte string.
   * @returns The raw claims Map.
   * @throws {CryptoError} If the payload is not valid CBOR or not a map.
   */
  private static decodeRawClaims(payload: Uint8Array): Map<number | string, unknown> {
    try {
      const decoded = Cbor.decode<unknown>(payload);
      if (decoded instanceof Map) {
        return decoded as Map<number | string, unknown>;
      } else if (typeof decoded === 'object' && decoded !== null) {
        // Some encoders produce plain objects instead of Maps for maps with string keys.
        return new Map(Object.entries(decoded));
      } else {
        throw new Error('not a map');
      }
    } catch (error) {
      if (error instanceof CryptoError) {
        throw error;
      }
      throw new CryptoError(
        CryptoErrorCode.InvalidEat,
        'Eat: payload is not a valid CBOR map'
      );
    }
  }

  /**
   * Extracts the standard CWT registered claims (iss, sub, aud, exp, nbf, iat, cti) from the raw
   * claims Map onto the given {@link EatClaims} object.
   */
  private static applyCwtClaims(rawClaims: Map<number | string, unknown>, claims: EatClaims): void {
    const iss = rawClaims.get(EatClaimKey.Iss);
    if (iss !== undefined) {
      claims.iss = iss as string;
    }

    const sub = rawClaims.get(EatClaimKey.Sub);
    if (sub !== undefined) {
      claims.sub = sub as string;
    }

    const aud = rawClaims.get(EatClaimKey.Aud);
    if (aud !== undefined) {
      claims.aud = aud as string;
    }

    const exp = rawClaims.get(EatClaimKey.Exp);
    if (exp !== undefined) {
      claims.exp = exp as number;
    }

    const nbf = rawClaims.get(EatClaimKey.Nbf);
    if (nbf !== undefined) {
      claims.nbf = nbf as number;
    }

    const iat = rawClaims.get(EatClaimKey.Iat);
    if (iat !== undefined) {
      claims.iat = iat as number;
    }

    const cti = rawClaims.get(EatClaimKey.Cti);
    if (cti !== undefined) {
      claims.cti = cti as Uint8Array;
    }
  }

  /**
   * Extracts the EAT-specific claims (nonce, ueid, hwmodel, hwversion, dbgstat, measres,
   * submods) from the raw claims Map onto the given {@link EatClaims} object.
   */
  private static applyEatSpecificClaims(rawClaims: Map<number | string, unknown>, claims: EatClaims): void {
    const nonce = rawClaims.get(EatClaimKey.Nonce);
    if (nonce !== undefined) {
      claims.nonce = nonce as Uint8Array | Uint8Array[];
    }

    const ueid = rawClaims.get(EatClaimKey.Ueid);
    if (ueid !== undefined) {
      claims.ueid = ueid as Uint8Array;
    }

    const hwmodel = rawClaims.get(EatClaimKey.Hwmodel);
    if (hwmodel !== undefined) {
      claims.hwmodel = hwmodel as Uint8Array;
    }

    const hwversion = rawClaims.get(EatClaimKey.Hwversion);
    if (hwversion !== undefined) {
      claims.hwversion = hwversion;
    }

    const dbgstat = rawClaims.get(EatClaimKey.Dbgstat);
    if (dbgstat !== undefined) {
      claims.dbgstat = dbgstat as EatDebugStatus;
    }

    const measres = rawClaims.get(EatClaimKey.Measres);
    if (measres !== undefined) {
      claims.measres = measres;
    }

    const submods = rawClaims.get(EatClaimKey.Submods);
    if (submods !== undefined) {
      claims.submods = submods as Map<string, unknown>;
    }
  }
}
