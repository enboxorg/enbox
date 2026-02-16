import type {
  Jwk,
  JwkParamsEcPrivate,
  JwkParamsEcPublic,
  JwkParamsOkpPrivate,
  JwkParamsOkpPublic,
} from '@enbox/crypto';

export type { Jwk };

/**
 * Public key types supported by DWN: EC (secp256k1, P-256) and OKP (Ed25519).
 * Re-exported from `@enbox/crypto` for convenience.
 */
export type PublicKeyJwk = JwkParamsEcPublic | JwkParamsOkpPublic;

/**
 * Private key types supported by DWN: EC (secp256k1, P-256) and OKP (Ed25519).
 * Re-exported from `@enbox/crypto` for convenience.
 */
export type PrivateKeyJwk = JwkParamsEcPrivate | JwkParamsOkpPrivate;

/**
 * Contains a public-private key pair and the associated key ID.
 */
export type KeyMaterial = {
  keyId: string,
  keyPair: { publicJwk: PublicKeyJwk, privateJwk: PrivateKeyJwk }
};

export interface SignatureAlgorithm {
  /**
   * signs the provided payload using the provided JWK
   * @param content - the content to sign
   * @param privateJwk - the key to sign with
   * @returns the signed content (aka signature)
   */
  sign(content: Uint8Array, privateJwk: PrivateKeyJwk): Promise<Uint8Array>;

  /**
   * Verifies a signature against the provided payload hash and public key.
   * @param content - the content to verify with
   * @param signature - the signature to verify against
   * @param publicJwk - the key to verify with
   * @returns a boolean indicating whether the signature matches
   */
  verify(content: Uint8Array, signature: Uint8Array, publicJwk: PublicKeyJwk): Promise<boolean>;

  /**
   * generates a random key pair
   * @returns the public and private keys as JWKs
   */
  generateKeyPair(): Promise<{ publicJwk: PublicKeyJwk, privateJwk: PrivateKeyJwk }>


  /**
   * converts public key in bytes into a JWK
   * @param publicKeyBytes - the public key to convert into JWK
   * @returns the public key in JWK format
   */
  publicKeyToJwk(publicKeyBytes: Uint8Array): Promise<PublicKeyJwk>
}
