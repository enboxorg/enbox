import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { PrivateKeySigner } from '../../src/index.js';
import { Secp256k1 } from '../../src/utils/secp256k1.js';
import { describe, expect, it } from 'bun:test';

describe('PrivateKeySigner', () => {
  describe('constructor', () => {
    it('should use key ID found in the private JWK if no key ID is explicitly given', async () => {
      const { privateJwk } = await Secp256k1.generateKeyPair();
      privateJwk.kid = 'awesome-key-id';

      const signer = new PrivateKeySigner({ privateJwk });
      expect(signer.keyId).toBe(privateJwk.kid);
    });

    it('should override signature algorithm found in the private JWK if a value is explicitly given', async () => {
      const { privateJwk } = await Secp256k1.generateKeyPair();

      const explicitlySpecifiedAlgorithm = 'awesome-algorithm';
      const signer = new PrivateKeySigner({ privateJwk, keyId: 'anyValue', algorithm: explicitlySpecifiedAlgorithm });
      expect(signer.algorithm).toBe(explicitlySpecifiedAlgorithm);
    });

    it('should throw if key ID is not explicitly specified and not given in private JWK', async () => {
      const { privateJwk } = await Secp256k1.generateKeyPair();

      expect(() => new PrivateKeySigner({ privateJwk })).toThrow(DwnErrorCode.PrivateKeySignerUnableToDeduceKeyId);
    });

    it('should throw if signature algorithm is not explicitly specified and not given in private JWK', async () => {
      const { privateJwk } = await Secp256k1.generateKeyPair();
      delete privateJwk.alg; // remove `alg` for this test

      expect(() => new PrivateKeySigner({ privateJwk, keyId: 'anyValue' })).toThrow(DwnErrorCode.PrivateKeySignerUnableToDeduceAlgorithm);
    });

    it('should throw if crypto curve of the given private JWK is not supported', async () => {
      const { privateJwk } = await Secp256k1.generateKeyPair();
      (privateJwk as any).crv = 'unknown'; // change `crv` to an unsupported value for this test

      expect(() => new PrivateKeySigner({ privateJwk, keyId: 'anyValue' })).toThrow(DwnErrorCode.PrivateKeySignerUnsupportedCurve);
    });
  });
});
