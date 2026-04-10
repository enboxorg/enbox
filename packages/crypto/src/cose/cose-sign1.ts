import type { Jwk } from '../jose/jwk.js';

import { Cbor } from './cbor.js';
import { Ed25519 } from '../primitives/ed25519.js';
import { Secp256r1 } from '../primitives/secp256r1.js';
import { CoseAlgorithm, CoseKey } from './cose-key.js';
import { CryptoError, CryptoErrorCode } from '../crypto-error.js';

/**
 * COSE_Sign1 protected header parameters.
 *
 * The protected header is integrity-protected by inclusion in the Sig_structure.
 * At minimum, it MUST contain the algorithm identifier.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-4 | RFC 9052, Section 4}
 */
export interface CoseSign1ProtectedHeader {
  /** Algorithm identifier (label 1). Required. */
  alg: CoseAlgorithm;

  /** Content type (label 3). */
  contentType?: string | number;

  /** Key ID (label 4). */
  kid?: Uint8Array;

  /** Additional header parameters. */
  [key: string]: unknown;
}

/**
 * COSE_Sign1 unprotected header parameters.
 *
 * These parameters are NOT integrity-protected.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-4 | RFC 9052, Section 4}
 */
export interface CoseSign1UnprotectedHeader {
  /** Key ID (label 4). */
  kid?: Uint8Array;

  /** Additional header parameters. */
  [key: string]: unknown;
}

/**
 * Parameters for creating a COSE_Sign1 structure.
 */
export interface CoseSign1CreateParams {
  /** The signing key in JWK format. Must contain the private key (`d`). */
  key: Jwk;

  /** The payload to sign. */
  payload: Uint8Array;

  /**
   * Protected header parameters. If omitted, the algorithm is inferred from the key
   * and a minimal protected header `{ alg }` is used.
   */
  protectedHeader?: CoseSign1ProtectedHeader;

  /** Unprotected header parameters. */
  unprotectedHeader?: CoseSign1UnprotectedHeader;

  /**
   * External additional authenticated data (external_aad).
   * Included in the Sig_structure but not in the COSE_Sign1 message itself.
   * Defaults to empty bytes.
   */
  externalAad?: Uint8Array;

  /**
   * If true, the payload is detached (not included in the COSE_Sign1 serialization).
   * The payload field in the CBOR array will be `null`.
   */
  detachedPayload?: boolean;
}

/**
 * Parameters for verifying a COSE_Sign1 structure.
 */
export interface CoseSign1VerifyParams {
  /** The COSE_Sign1 CBOR-encoded message to verify. */
  coseSign1: Uint8Array;

  /** The public key in JWK format for verification. */
  key: Jwk;

  /**
   * External additional authenticated data (external_aad).
   * Must match the value used during signing.
   * Defaults to empty bytes.
   */
  externalAad?: Uint8Array;

  /**
   * Detached payload. Required if the COSE_Sign1 was created with `detachedPayload: true`.
   */
  payload?: Uint8Array;
}

/**
 * Decoded COSE_Sign1 structure.
 */
export interface CoseSign1Decoded {
  /** The protected header parameters (decoded from CBOR). */
  protectedHeader: CoseSign1ProtectedHeader;

  /** The raw protected header bytes (needed for signature verification). */
  protectedHeaderBytes: Uint8Array;

  /** The unprotected header parameters. */
  unprotectedHeader: Map<number, unknown>;

  /** The payload (null if detached). */
  payload: Uint8Array | null;

  /** The signature. */
  signature: Uint8Array;
}

/**
 * COSE header label constants (RFC 9052, Section 3.1).
 */
enum CoseHeaderLabel {
  /** Algorithm identifier */
  Alg = 1,
  /** Critical headers */
  Crit = 2,
  /** Content type */
  ContentType = 3,
  /** Key ID */
  Kid = 4,
}

/**
 * CBOR tag for COSE_Sign1 (RFC 9052, Section 4.2).
 */
// const COSE_SIGN1_TAG = 18;

/**
 * COSE_Sign1 implementation per RFC 9052.
 *
 * Provides creation, verification, and decoding of COSE_Sign1 (single-signer)
 * signed messages. This is the CBOR-based counterpart to JOSE/JWS and is used
 * in TEE attestation (EAT tokens), CWT, and other COSE-based protocols.
 *
 * Supported algorithms:
 * - EdDSA (Ed25519) — CoseAlgorithm.EdDSA (-8)
 * - ES256 (P-256 / secp256r1 with SHA-256) — CoseAlgorithm.ES256 (-7)
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-4.3 | RFC 9052, Section 4.3}
 */
export class CoseSign1 {
  /**
   * Creates a COSE_Sign1 message.
   *
   * Constructs the `Sig_structure1` to-be-signed bytes per RFC 9052 Section 4.4,
   * signs them with the provided key, and returns the CBOR-encoded COSE_Sign1 array:
   *
   * ```
   * COSE_Sign1 = [
   *   protected : bstr,       ; CBOR-encoded protected header
   *   unprotected : map,      ; unprotected header parameters
   *   payload : bstr / nil,   ; payload (nil if detached)
   *   signature : bstr        ; signature
   * ]
   * ```
   *
   * @param params - The parameters for creating the COSE_Sign1 message.
   * @returns The CBOR-encoded COSE_Sign1 message.
   * @throws {CryptoError} If the algorithm is not supported or signing fails.
   *
   * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-4.3 | RFC 9052, Section 4.3}
   * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-4.4 | RFC 9052, Section 4.4}
   */
  public static async create(params: CoseSign1CreateParams): Promise<Uint8Array> {
    const {
      key,
      payload,
      externalAad = new Uint8Array(0),
      detachedPayload = false,
    } = params;

    // Build the protected header.
    const alg = params.protectedHeader?.alg ?? CoseKey.algorithmFromJwk(key);
    const protectedHeaderMap = CoseSign1.buildProtectedHeaderMap(
      params.protectedHeader ?? { alg }
    );
    const protectedHeaderBytes = Cbor.encode(protectedHeaderMap);

    // Build the unprotected header.
    const unprotectedHeaderMap = params.unprotectedHeader === undefined
      ? new Map<number, unknown>()
      : CoseSign1.buildUnprotectedHeaderMap(params.unprotectedHeader);

    // Construct the Sig_structure1 (to-be-signed bytes).
    const sigStructure = CoseSign1.buildSigStructure1(
      protectedHeaderBytes, externalAad, payload
    );
    const toBeSigned = Cbor.encode(sigStructure);

    // Sign the Sig_structure1 bytes.
    const signature = await CoseSign1.signBytes(alg, key, toBeSigned);

    // Assemble the COSE_Sign1 array.
    const coseSign1Array = [
      protectedHeaderBytes,
      unprotectedHeaderMap,
      detachedPayload ? null : payload,
      signature,
    ];

    return Cbor.encode(coseSign1Array);
  }

  /**
   * Verifies a COSE_Sign1 message.
   *
   * Decodes the CBOR-encoded message, reconstructs the `Sig_structure1`, and verifies
   * the signature using the provided public key.
   *
   * @param params - The parameters for verifying the COSE_Sign1 message.
   * @returns `true` if the signature is valid, `false` otherwise.
   * @throws {CryptoError} If the message is malformed or the algorithm is not supported.
   *
   * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-4.4 | RFC 9052, Section 4.4}
   */
  public static async verify(params: CoseSign1VerifyParams): Promise<boolean> {
    const {
      coseSign1,
      key,
      externalAad = new Uint8Array(0),
    } = params;

    // Decode the COSE_Sign1 message.
    const decoded = CoseSign1.decode(coseSign1);

    // Resolve the payload (from message or detached parameter).
    const payload = decoded.payload ?? params.payload ?? null;
    if (payload === null) {
      throw new CryptoError(
        CryptoErrorCode.InvalidCoseSign1,
        'CoseSign1: payload is detached but no payload was provided for verification'
      );
    }

    // Reconstruct the Sig_structure1.
    const sigStructure = CoseSign1.buildSigStructure1(
      decoded.protectedHeaderBytes, externalAad, payload
    );
    const toBeSigned = Cbor.encode(sigStructure);

    // Extract the algorithm from the protected header.
    const alg = decoded.protectedHeader.alg;

    // Verify the signature.
    return CoseSign1.verifyBytes(alg, key, toBeSigned, decoded.signature);
  }

  /**
   * Decodes a CBOR-encoded COSE_Sign1 message into its constituent parts.
   *
   * The COSE_Sign1 structure is a CBOR array of four elements:
   * ```
   * [protected, unprotected, payload, signature]
   * ```
   *
   * The message may optionally be wrapped in CBOR tag 18.
   *
   * @param coseSign1 - The CBOR-encoded COSE_Sign1 message.
   * @returns The decoded COSE_Sign1 components.
   * @throws {CryptoError} If the message does not conform to COSE_Sign1 structure.
   */
  public static decode(coseSign1: Uint8Array): CoseSign1Decoded {
    let decoded: unknown;
    try {
      decoded = Cbor.decode(coseSign1);
    } catch {
      throw new CryptoError(
        CryptoErrorCode.InvalidCoseSign1,
        'CoseSign1: failed to decode CBOR'
      );
    }

    // Handle CBOR Tagged value (tag 18 for COSE_Sign1).
    // The `cborg` library decodes tagged values as `Tagged` objects with `tag` and `value` properties.
    if (decoded !== null && typeof decoded === 'object' && 'tag' in (decoded as Record<string, unknown>)) {
      const tagged = decoded as { tag: number; value: unknown };
      if (tagged.tag === 18) {
        decoded = tagged.value;
      }
    }

    // Validate the COSE_Sign1 array structure.
    if (!Array.isArray(decoded) || decoded.length !== 4) {
      throw new CryptoError(
        CryptoErrorCode.InvalidCoseSign1,
        'CoseSign1: expected a CBOR array of 4 elements [protected, unprotected, payload, signature]'
      );
    }

    const [protectedHeaderBytes, unprotectedHeaderMap, payload, signature] = decoded as [
      Uint8Array, Map<number, unknown>, Uint8Array | null, Uint8Array
    ];

    // Validate element types.
    if (!(protectedHeaderBytes instanceof Uint8Array)) {
      throw new CryptoError(
        CryptoErrorCode.InvalidCoseSign1,
        'CoseSign1: protected header must be a byte string'
      );
    }

    if (!(signature instanceof Uint8Array)) {
      throw new CryptoError(
        CryptoErrorCode.InvalidCoseSign1,
        'CoseSign1: signature must be a byte string'
      );
    }

    // Decode the protected header.
    let protectedHeaderMap: Map<number, unknown>;
    if (protectedHeaderBytes.length === 0) {
      protectedHeaderMap = new Map();
    } else {
      try {
        protectedHeaderMap = Cbor.decode<Map<number, unknown>>(protectedHeaderBytes);
      } catch {
        throw new CryptoError(
          CryptoErrorCode.InvalidCoseSign1,
          'CoseSign1: failed to decode protected header CBOR'
        );
      }
    }

    // Extract the algorithm from the protected header.
    const alg = protectedHeaderMap.get(CoseHeaderLabel.Alg);
    if (alg === undefined || typeof alg !== 'number') {
      throw new CryptoError(
        CryptoErrorCode.InvalidCoseSign1,
        'CoseSign1: protected header must contain an algorithm identifier (label 1)'
      );
    }

    // Build the typed protected header.
    const protectedHeader: CoseSign1ProtectedHeader = { alg: alg as CoseAlgorithm };

    const contentType = protectedHeaderMap.get(CoseHeaderLabel.ContentType);
    if (contentType !== undefined) {
      protectedHeader.contentType = contentType as string | number;
    }

    const kid = protectedHeaderMap.get(CoseHeaderLabel.Kid);
    if (kid !== undefined) {
      protectedHeader.kid = kid as Uint8Array;
    }

    return {
      protectedHeader,
      protectedHeaderBytes,
      unprotectedHeader : unprotectedHeaderMap instanceof Map ? unprotectedHeaderMap : new Map(),
      payload           : payload instanceof Uint8Array ? payload : null,
      signature,
    };
  }

  /**
   * Builds the Sig_structure1 array for COSE_Sign1 signing and verification.
   *
   * ```
   * Sig_structure1 = [
   *   context : "Signature1",
   *   body_protected : bstr,
   *   external_aad : bstr,
   *   payload : bstr
   * ]
   * ```
   *
   * @see {@link https://www.rfc-editor.org/rfc/rfc9052#section-4.4 | RFC 9052, Section 4.4}
   */
  private static buildSigStructure1(
    protectedHeaderBytes: Uint8Array,
    externalAad: Uint8Array,
    payload: Uint8Array,
  ): unknown[] {
    return [
      'Signature1', // context string
      protectedHeaderBytes, // body_protected
      externalAad, // external_aad
      payload, // payload
    ];
  }

  /**
   * Converts a {@link CoseSign1ProtectedHeader} to a CBOR Map with integer labels.
   */
  private static buildProtectedHeaderMap(header: CoseSign1ProtectedHeader): Map<number, unknown> {
    const map = new Map<number, unknown>();

    map.set(CoseHeaderLabel.Alg, header.alg);

    if (header.contentType !== undefined) {
      map.set(CoseHeaderLabel.ContentType, header.contentType);
    }

    if (header.kid !== undefined) {
      map.set(CoseHeaderLabel.Kid, header.kid);
    }

    return map;
  }

  /**
   * Converts a {@link CoseSign1UnprotectedHeader} to a CBOR Map with integer labels.
   */
  private static buildUnprotectedHeaderMap(header: CoseSign1UnprotectedHeader): Map<number, unknown> {
    const map = new Map<number, unknown>();

    if (header.kid !== undefined) {
      map.set(CoseHeaderLabel.Kid, header.kid);
    }

    return map;
  }

  /**
   * Signs the to-be-signed bytes with the appropriate algorithm.
   */
  private static async signBytes(
    alg: CoseAlgorithm,
    key: Jwk,
    data: Uint8Array,
  ): Promise<Uint8Array> {
    switch (alg) {
      case CoseAlgorithm.EdDSA:
        return Ed25519.sign({ key, data });

      case CoseAlgorithm.ES256:
        return Secp256r1.sign({ key, data });

      default:
        throw new CryptoError(
          CryptoErrorCode.AlgorithmNotSupported,
          `CoseSign1: signing algorithm ${alg} is not supported`
        );
    }
  }

  /**
   * Verifies a signature over the to-be-signed bytes with the appropriate algorithm.
   */
  private static async verifyBytes(
    alg: CoseAlgorithm,
    key: Jwk,
    data: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    switch (alg) {
      case CoseAlgorithm.EdDSA:
        return Ed25519.verify({ key, signature, data });

      case CoseAlgorithm.ES256:
        return Secp256r1.verify({ key, signature, data });

      default:
        throw new CryptoError(
          CryptoErrorCode.AlgorithmNotSupported,
          `CoseSign1: verification algorithm ${alg} is not supported`
        );
    }
  }
}
