import type { GeneralJws } from '../types/jws-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { SignatureEntry } from '../types/jws-types.js';
import type { KeyMaterial, PublicKeyJwk } from '../types/jose-types.js';

import { Encoder } from './encoder.js';
import { PrivateKeySigner } from './private-key-signer.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { signatureAlgorithms, type SupportedCurve } from '../jose/algorithms/signing/signature-algorithms.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Utility class for JWS related operations.
 */
export class Jws {
  /**
   * Gets the `kid` from a general JWS signature entry.
   */
  public static getKid(signatureEntry: SignatureEntry): string {
    const { kid } = Encoder.base64UrlToObject(signatureEntry.protected);
    return kid;
  }

  /**
   * Gets the signer DID from a general JWS signature entry.
   */
  public static getSignerDid(signatureEntry: SignatureEntry): string {
    const kid = Jws.getKid(signatureEntry);
    const did = Jws.extractDid(kid);
    return did;
  }

  /**
   * Verifies the signature against the given payload.
   * @returns `true` if signature is valid; `false` otherwise
   */
  public static async verifySignature(base64UrlPayload: string, signatureEntry: SignatureEntry, jwkPublic: PublicKeyJwk): Promise<boolean> {
    const signatureAlgorithm = signatureAlgorithms[('crv' in jwkPublic ? jwkPublic.crv : undefined) as SupportedCurve];

    if (!signatureAlgorithm) {
      throw new DwnError(DwnErrorCode.JwsVerifySignatureUnsupportedCrv, `unsupported crv. crv must be one of ${Object.keys(signatureAlgorithms)}`);
    }

    const payload = Encoder.stringToBytes(`${signatureEntry.protected}.${base64UrlPayload}`);
    const signatureBytes = Encoder.base64UrlToBytes(signatureEntry.signature);

    return await signatureAlgorithm.verify(payload, signatureBytes, jwkPublic);
  }

  /**
   * Decodes the payload of the given JWS object as a plain object.
   */
  public static decodePlainObjectPayload(jws: GeneralJws): any {
    let payloadJson;
    try {
      payloadJson = Encoder.base64UrlToObject(jws.payload);
    } catch {
      throw new DwnError(DwnErrorCode.JwsDecodePlainObjectPayloadInvalid, 'payload is not a JSON object');
    }

    if (!isPlainObject(payloadJson)) {
      throw new DwnError(DwnErrorCode.JwsDecodePlainObjectPayloadInvalid, 'signed payload must be a plain object');
    }

    return payloadJson;
  }

  /**
   * Extracts the DID from the given `kid` string.
   */
  public static extractDid(kid: string): string {
    const [ did ] = kid.split('#');
    return did;
  }

  /**
   * Creates a MessageSigner[] from the given Personas.
   */
  public static createSigners(keyMaterials: KeyMaterial[]): MessageSigner[] {
    const signers = keyMaterials.map((keyMaterial) => Jws.createSigner(keyMaterial));
    return signers;
  }

  /**
   * Creates a MessageSigner from the given Persona.
   */
  public static createSigner(keyMaterial: KeyMaterial): MessageSigner {
    const privateJwk = keyMaterial.keyPair.privateJwk;
    const keyId = keyMaterial.keyId;
    const signer = new PrivateKeySigner({ privateJwk, keyId });
    return signer;
  }
}
