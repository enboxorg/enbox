import type { MessageSigner } from '../types/signer.js';
import type { PrivateKeyJwk } from '../types/jose-types.js';

import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { signatureAlgorithms, type SupportedCurve } from '../jose/algorithms/signing/signature-algorithms.js';

/**
 * Input to `PrivateKeySigner` constructor.
 */
export type PrivateKeySignerOptions = {
  /**
   * Private JWK to create the signer from.
   */
  privateJwk: PrivateKeyJwk;

  /**
   * If not specified, the constructor will attempt to default/fall back to the `kid` value in the given `privateJwk`.
   */
  keyId?: string;

  /**
   * If not specified, the constructor will attempt to default/fall back to the `alg` value in the given `privateJwk`.
   */
  algorithm?: string;
};

/**
 * A signer that signs using a private key.
 */
export class PrivateKeySigner implements MessageSigner {
  public keyId;
  public algorithm;
  private privateJwk: PrivateKeyJwk;
  private signatureAlgorithm;

  public constructor(options: PrivateKeySignerOptions) {
    if (options.keyId === undefined && options.privateJwk.kid === undefined) {
      throw new DwnError(
        DwnErrorCode.PrivateKeySignerUnableToDeduceKeyId,
        `Unable to deduce the key ID`
      );
    }

    // NOTE: `alg` is optional for a JWK as specified in https://datatracker.ietf.org/doc/html/rfc7517#section-4.4
    if (options.algorithm === undefined && options.privateJwk.alg === undefined) {
      throw new DwnError(
        DwnErrorCode.PrivateKeySignerUnableToDeduceAlgorithm,
        `Unable to deduce the signature algorithm`
      );
    }

    this.keyId = options.keyId ?? options.privateJwk.kid!;
    this.algorithm = options.algorithm ?? options.privateJwk.alg!;
    this.privateJwk = options.privateJwk;
    const crv = 'crv' in options.privateJwk ? options.privateJwk.crv : undefined;
    this.signatureAlgorithm = signatureAlgorithms[crv as SupportedCurve];

    if (!this.signatureAlgorithm) {
      throw new DwnError(
        DwnErrorCode.PrivateKeySignerUnsupportedCurve,
        `Unsupported crv ${crv}, crv must be one of ${Object.keys(signatureAlgorithms)}`
      );
    }
  }

  /**
   * Signs the given content and returns the signature as bytes.
   */
  public async sign (content: Uint8Array): Promise<Uint8Array> {
    const signatureBytes = await this.signatureAlgorithm.sign(content, this.privateJwk);
    return signatureBytes;
  }
}
