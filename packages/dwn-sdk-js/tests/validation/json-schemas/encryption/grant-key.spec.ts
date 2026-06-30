import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';

const grantKey = {
  grantId     : 'grant-id',
  keyMaterial : {
    algorithm        : 'X25519-HKDF-SHA256+A256KW',
    derivationPath   : ['protocolPath', 'https://example.com/protocol', 'message'],
    derivationScheme : 'protocolPath',
    keyId            : 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    privateKeyJwk    : {
      crv : 'X25519',
      d   : 'private-key',
      kty : 'OKP',
      x   : 'public-key',
    },
    publicKeyJwk: {
      crv : 'X25519',
      kty : 'OKP',
      x   : 'public-key',
    },
  },
  scope: {
    protocol     : 'https://example.com/protocol',
    protocolPath : 'message',
    scheme       : 'protocolPath',
  },
};

describe('GrantKey Schema', () => {
  it('should accept protocolPath derivation paths', () => {
    expect(
      () => validateJsonSchema('GrantKey', grantKey)
    ).not.toThrow();
  });

  it('should reject derivation paths that do not start with protocolPath', () => {
    const invalidGrantKey = structuredClone(grantKey);
    invalidGrantKey.keyMaterial.derivationPath[0] = 'unsupported';

    expect(
      () => validateJsonSchema('GrantKey', invalidGrantKey)
    ).toThrow();
  });

  it('should reject empty derivation path segments', () => {
    const invalidGrantKey = structuredClone(grantKey);
    invalidGrantKey.keyMaterial.derivationPath[2] = '';

    expect(
      () => validateJsonSchema('GrantKey', invalidGrantKey)
    ).toThrow();
  });

  it('should reject derivation paths with too many segments', () => {
    const invalidGrantKey = structuredClone(grantKey);
    invalidGrantKey.keyMaterial.derivationPath = [
      'protocolPath',
      'https://example.com/protocol',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
    ];

    expect(
      () => validateJsonSchema('GrantKey', invalidGrantKey)
    ).toThrow();
  });

  it('should reject key IDs that are not base64url thumbprints', () => {
    const invalidGrantKey = structuredClone(grantKey);
    invalidGrantKey.keyMaterial.keyId = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF!';

    expect(
      () => validateJsonSchema('GrantKey', invalidGrantKey)
    ).toThrow();
  });

  it('should reject unsupported key material algorithms', () => {
    const invalidGrantKey = structuredClone(grantKey);
    invalidGrantKey.keyMaterial.algorithm = 'unsupported';

    expect(
      () => validateJsonSchema('GrantKey', invalidGrantKey)
    ).toThrow();
  });
});
