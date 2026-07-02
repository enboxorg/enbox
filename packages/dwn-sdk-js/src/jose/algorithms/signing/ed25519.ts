import type { JwkParamsOkpPrivate, JwkParamsOkpPublic } from '@enbox/crypto';
import type { PrivateKeyJwk, PublicKeyJwk, SignatureAlgorithm } from '../../../types/jose-types.js';

import { ed25519 as Ed25519 } from '@noble/curves/ed25519.js';

import { Encoder } from '../../../utils/encoder.js';
import { DwnError, DwnErrorCode } from '../../../core/dwn-error.js';

function validateKey(jwk: PrivateKeyJwk | PublicKeyJwk): void {
  if (jwk.kty !== 'OKP' || (jwk as JwkParamsOkpPublic).crv !== 'Ed25519') {
    throw new DwnError(DwnErrorCode.Ed25519InvalidJwk, 'invalid jwk. kty MUST be OKP. crv MUST be Ed25519');
  }
}

function publicKeyToJwk(publicKeyBytes: Uint8Array): PublicKeyJwk {
  const x = Encoder.bytesToBase64Url(publicKeyBytes);

  const publicJwk: PublicKeyJwk = {
    alg : 'EdDSA',
    kty : 'OKP',
    crv : 'Ed25519',
    x
  };

  return publicJwk;
}

export const ed25519: SignatureAlgorithm = {
  sign: async (content: Uint8Array, privateJwk: PrivateKeyJwk): Promise<Uint8Array> => {
    validateKey(privateJwk);

    const privateKeyBytes = Encoder.base64UrlToBytes((privateJwk as JwkParamsOkpPrivate).d);

    return Ed25519.sign(content, privateKeyBytes);
  },

  verify: async (content: Uint8Array, signature: Uint8Array, publicJwk: PublicKeyJwk): Promise<boolean> => {
    validateKey(publicJwk);

    const publicKeyBytes = Encoder.base64UrlToBytes((publicJwk as JwkParamsOkpPublic).x);

    return Ed25519.verify(signature, content, publicKeyBytes);
  },

  generateKeyPair: async (): Promise<{publicJwk: PublicKeyJwk, privateJwk: PrivateKeyJwk}> => {
    const privateKeyBytes = Ed25519.utils.randomSecretKey();
    const publicKeyBytes = Ed25519.getPublicKey(privateKeyBytes);

    const d = Encoder.bytesToBase64Url(privateKeyBytes);

    const publicJwk = publicKeyToJwk(publicKeyBytes);
    const privateJwk: PrivateKeyJwk = { ...publicJwk, d };

    return { publicJwk, privateJwk };
  },

  publicKeyToJwk: async (publicKeyBytes: Uint8Array): Promise<PublicKeyJwk> => {
    return publicKeyToJwk(publicKeyBytes);
  }
};
