import type { Cache } from '../../../types/cache.js';
import type { GeneralJws } from '../../../types/jws-types.js';
import type { PublicKeyJwk } from '../../../types/jose-types.js';
import type { DidResolutionResult, DidResolver, DidVerificationMethod } from '@enbox/dids';

import { Encoder } from '../../../utils/encoder.js';
import { Jws } from '../../../utils/jws.js';
import { MemoryCache } from '../../../utils/memory-cache.js';
import { validateJsonSchema } from '../../../schema-validator.js';
import { DwnError, DwnErrorCode } from '../../../core/dwn-error.js';

type VerificationResult = {
  /** DIDs of all signers */
  signers: string[];
};

/**
 * Verifies the signature(s) of a General JWS.
 */
export class GeneralJwsVerifier {

  private static _singleton: GeneralJwsVerifier;

  cache: Cache;

  private constructor(cache?: Cache) {
    this.cache = cache ?? new MemoryCache(600);
  }

  private static get singleton(): GeneralJwsVerifier {
    if (GeneralJwsVerifier._singleton === undefined) {
      GeneralJwsVerifier._singleton = new GeneralJwsVerifier();
    }

    return GeneralJwsVerifier._singleton;
  }

  /**
   * Verifies the signatures of the given General JWS.
   * @returns the list of signers that have valid signatures.
   */
  public static async verifySignatures(jws: GeneralJws, didResolver: DidResolver): Promise<VerificationResult> {
    return await GeneralJwsVerifier.singleton.verifySignatures(jws, didResolver);
  }

  /**
   * Verifies the signatures of the given General JWS.
   * @returns the list of signers that have valid signatures.
   */
  public async verifySignatures(jws: GeneralJws, didResolver: DidResolver): Promise<VerificationResult> {
    const signers: string[] = [];

    for (const signatureEntry of jws.signatures) {
      let isVerified: boolean;
      const protectedHeader = Encoder.base64UrlToObject(signatureEntry.protected);
      const { kid, alg } = protectedHeader;

      if (kid === undefined || typeof kid !== 'string') {
        throw new DwnError(DwnErrorCode.GeneralJwsVerifierMissingKid, `JWS protected header is missing required 'kid' property`);
      }

      if (alg === undefined || typeof alg !== 'string') {
        throw new DwnError(DwnErrorCode.GeneralJwsVerifierMissingAlg, `JWS protected header is missing required 'alg' property`);
      }

      const cacheKey = `${signatureEntry.protected}.${jws.payload}.${signatureEntry.signature}`;
      const cachedValue = await this.cache.get<boolean>(cacheKey);

      // explicit `undefined` check to differentiate `false`
      if (cachedValue === undefined) {
        const publicJwk = await GeneralJwsVerifier.getPublicKey(kid, didResolver);
        isVerified = await Jws.verifySignature(jws.payload, signatureEntry, publicJwk);
        await this.cache.set(cacheKey, isVerified);
      } else {
        isVerified = cachedValue;
      }

      const did = Jws.extractDid(kid);

      if (isVerified) {
        signers.push(did);
      } else {
        throw new DwnError(DwnErrorCode.GeneralJwsVerifierInvalidSignature, `Signature verification failed for ${did}`);
      }
    }

    return { signers };
  }

  /**
   * Gets the public key given a fully qualified key ID (`kid`) by resolving the DID to its DID Document.
   *
   * Throws `GeneralJwsVerifierGetPublicKeyNotFound` when the public key cannot be located.
   * The error message distinguishes between two failure modes so callers can tell them apart:
   *   1. DID resolution failed (network error, DID not published, method not supported, etc.).
   *      The resolution metadata error code and message are included.
   *   2. DID resolved successfully but the requested `kid` does not match any verification
   *      method in the DID Document. The list of available verification method IDs is included.
   */
  private static async getPublicKey(kid: string, didResolver: DidResolver): Promise<PublicKeyJwk> {
    // `resolve` throws exception if DID is invalid, DID method is not supported,
    // or resolving DID fails
    const did = Jws.extractDid(kid);
    const { didDocument, didResolutionMetadata } = await didResolver.resolve(did);
    const { verificationMethod: verificationMethods = [] } = didDocument || {};

    let verificationMethod: DidVerificationMethod | undefined;

    for (const method of verificationMethods) {
      // consider optimizing using a set for O(1) lookups if needed
      // key ID in DID Document may or may not be fully qualified. e.g.
      // `did:example:alice#key1` or `#key1`
      if (kid.endsWith(method.id)) {
        verificationMethod = method;
        break;
      }
    }

    if (!verificationMethod) {
      throw new DwnError(
        DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound,
        GeneralJwsVerifier.buildPublicKeyNotFoundMessage(kid, did, didDocument, didResolutionMetadata, verificationMethods),
      );
    }

    validateJsonSchema('JwkVerificationMethod', verificationMethod);

    const { publicKeyJwk: publicJwk } = verificationMethod;

    return publicJwk as PublicKeyJwk;
  }

  /**
   * Builds a diagnostic error message for `GeneralJwsVerifierGetPublicKeyNotFound`.
   * Surfaces resolution metadata or available verification methods so operators can
   * distinguish between an unreachable DID and a `kid` mismatch.
   */
  private static buildPublicKeyNotFoundMessage(
    kid: string,
    did: string,
    didDocument: DidResolutionResult['didDocument'],
    didResolutionMetadata: DidResolutionResult['didResolutionMetadata'] | undefined,
    verificationMethods: DidVerificationMethod[],
  ): string {
    const resolutionError = didResolutionMetadata?.error;
    if (resolutionError !== undefined) {
      const resolutionErrorMessage = didResolutionMetadata?.errorMessage;
      const detail = resolutionErrorMessage ? `${resolutionError} — ${resolutionErrorMessage}` : resolutionError;
      return `unable to resolve DID '${did}' to verify signature with kid '${kid}': ${detail}`;
    }

    if (didDocument === undefined || didDocument === null) {
      return `DID Document not found for '${did}' when verifying signature with kid '${kid}'`;
    }

    if (verificationMethods.length === 0) {
      return `DID Document for '${did}' has no verification methods to verify signature with kid '${kid}'`;
    }

    const availableIds = verificationMethods.map((method) => method.id).join(', ');
    return `public key for kid '${kid}' not found in DID Document for '${did}' (available verification methods: [${availableIds}])`;
  }
}
