import type { JwkParamsEcPublic } from '@enbox/crypto';
import type { PublicKeyJwk } from '../../src/types/jose-types.js';

import { base64url } from 'multiformats/bases/base64';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { p256 } from '@noble/curves/nist.js';
import { Secp256r1 } from '../../src/utils/secp256r1.js';
import { TestDataGenerator } from './test-data-generator.js';
import { describe, expect, it } from 'bun:test';

describe('Secp256r1', () => {
  describe('validateKey()', () => {
    it('should throw if key is not a valid SECP256R1 key', async () => {
      const validKey = (await Secp256r1.generateKeyPair()).publicJwk;

      expect(() =>
        Secp256r1.validateKey({ ...validKey, kty: 'invalidKty' as any })
      ).toThrow(DwnErrorCode.Secp256r1KeyNotValid);
      expect(() =>
        Secp256r1.validateKey({ ...validKey, crv: 'invalidCrv' } as unknown as PublicKeyJwk)
      ).toThrow(DwnErrorCode.Secp256r1KeyNotValid);
    });
  });

  describe('publicKeyToJwk()', () => {
    it('should generate the same JWK regardless of compressed or uncompressed public key bytes given', async () => {
      const compressedPublicKeyBase64UrlString =
        'Aom0shYia6t0cNMRQDRzPgCxdMWQamrfX3UJfOroLHo_';
      const uncompressedPublicKeyBase64UrlString =
        'BIm0shYia6t0cNMRQDRzPgCxdMWQamrfX3UJfOroLHo_cSITyng0NN1lt2BtZVXH4PE9Gerxq_mw2_CpbBHsWUI';

      const compressedPublicKey = base64url.baseDecode(
        compressedPublicKeyBase64UrlString
      );

      const uncompressedPublicKey = base64url.baseDecode(
        uncompressedPublicKeyBase64UrlString
      );

      const publicJwk1 = await Secp256r1.publicKeyToJwk(compressedPublicKey);
      const publicJwk2 = await Secp256r1.publicKeyToJwk(uncompressedPublicKey);

      expect((publicJwk1 as JwkParamsEcPublic).x).toBe((publicJwk2 as JwkParamsEcPublic).x);
      expect((publicJwk1 as JwkParamsEcPublic).y).toBe((publicJwk2 as JwkParamsEcPublic).y);
    });
  });

  describe('verify()', () => {
    it('should correctly handle DER formatted signatures', async () => {
      const { privateJwk, publicJwk } = await Secp256r1.generateKeyPair();

      const content = TestDataGenerator.randomBytes(16);

      const signature = await Secp256r1.sign(content, privateJwk);

      // Convert the signature to DER format
      const derSignature = p256.Signature.fromBytes(signature, 'compact').toBytes('der');

      const result = await Secp256r1.verify(content, derSignature, publicJwk);

      expect(result).toBe(true);
    });
  });

  describe('sign()', () => {
    it('should generate the signature in compact format', async () => {
      const { privateJwk } = await Secp256r1.generateKeyPair();

      const contentBytes = TestDataGenerator.randomBytes(16);
      const signatureBytes = await Secp256r1.sign(contentBytes, privateJwk);

      expect(signatureBytes).toHaveLength(64); // DER format would be 70 bytes
    });
  });
});
