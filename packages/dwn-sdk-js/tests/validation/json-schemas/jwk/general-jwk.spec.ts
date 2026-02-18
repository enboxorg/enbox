import { DwnErrorCode } from '../../../../src/core/dwn-error.js';
import { signatureAlgorithms } from '../../../../src/jose/algorithms/signing/signature-algorithms.js';
import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';

const { Ed25519, secp256k1 } = signatureAlgorithms;

describe('GeneralJwk Schema', async () => {
  const jwkSecp256k1 = await secp256k1.generateKeyPair();
  const jwkEd25519 = await Ed25519.generateKeyPair();

  const jwkRsa = {
    publicJwk: {
      'kty' : 'RSA',
      'e'   : 'AQAB',
      'use' : 'sig',
      'alg' : 'RS256',
      'n'   : 'abcd1234'
    },
    privateJwk: {
      'p'   : 'pProp',
      'kty' : 'RSA',
      'q'   : 'qProp',
      'd'   : 'dProp',
      'e'   : 'eProp',
      'use' : 'sig',
      'qi'  : 'qiProp',
      'dp'  : 'dpProp',
      'alg' : 'RS256',
      'dq'  : 'dqProp',
      'n'   : 'nProp'
    }
  };

  [
    jwkEd25519,
    jwkSecp256k1,
    jwkRsa
  ].forEach((jwk): void => {
    it('should not throw an exception if properly formatted jwk', () => {
      expect(
        () => validateJsonSchema('GeneralJwk', jwk.publicJwk)
      ).not.toThrow();
      expect(
        () => validateJsonSchema('GeneralJwk', jwk.privateJwk)
      ).not.toThrow();
    });
  });
});

describe('validateJsonSchema', () => {
  it('should throw SchemaValidatorSchemaNotFound for non-existent schema', () => {
    try {
      validateJsonSchema('NonExistentSchema', {});
      throw new Error('Expected an error');
    } catch (e: any) {
      expect(e.code).toBe(DwnErrorCode.SchemaValidatorSchemaNotFound);
    }
  });
});
