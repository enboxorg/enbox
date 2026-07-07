import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';

const wrappedGrantKeyEnvelope = {
  format        : 'enbox/wrapped-grant-key@1',
  keyEncryption : {
    algorithm          : 'X25519-HKDF-SHA256+A256KW',
    encryptedKey       : 'encrypted-key',
    ephemeralPublicKey : {
      crv : 'X25519',
      kty : 'OKP',
      x   : 'ephemeral-public-key',
    },
    keyId: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  },
  contentEncryption: {
    algorithm            : 'A256CTR',
    initializationVector : 'initialization-vector',
  },
  ciphertext: 'ciphertext',
};

describe('WrappedGrantKeyEnvelope Schema', () => {
  it('should accept a wrapped grantKey envelope', () => {
    expect(
      () => validateJsonSchema('WrappedGrantKeyEnvelope', wrappedGrantKeyEnvelope)
    ).not.toThrow();
  });

  it('should reject unknown formats', () => {
    const invalidEnvelope = structuredClone(wrappedGrantKeyEnvelope);
    invalidEnvelope.format = 'enbox/wrapped-grant-key@2';

    expect(
      () => validateJsonSchema('WrappedGrantKeyEnvelope', invalidEnvelope)
    ).toThrow();
  });

  it('should reject malformed ephemeral public keys', () => {
    const invalidEnvelope = structuredClone(wrappedGrantKeyEnvelope);
    invalidEnvelope.keyEncryption.ephemeralPublicKey.x = '';

    expect(
      () => validateJsonSchema('WrappedGrantKeyEnvelope', invalidEnvelope)
    ).toThrow();
  });

  it('should reject additional properties', () => {
    const invalidEnvelope = {
      ...wrappedGrantKeyEnvelope,
      extra: true,
    };

    expect(
      () => validateJsonSchema('WrappedGrantKeyEnvelope', invalidEnvelope)
    ).toThrow();
  });
});
