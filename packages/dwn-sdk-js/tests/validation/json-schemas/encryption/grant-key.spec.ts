import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';

const grantKey = {
  derivationPath : ['protocolPath', 'https://example.com/protocol', 'message'],
  grantId        : 'grant-id',
  keyId          : 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  privateKeyJwk  : {
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
    invalidGrantKey.derivationPath[0] = 'roleAudience';

    expect(
      () => validateJsonSchema('GrantKey', invalidGrantKey)
    ).toThrow();
  });

  it('should reject empty derivation path segments', () => {
    const invalidGrantKey = structuredClone(grantKey);
    invalidGrantKey.derivationPath[2] = '';

    expect(
      () => validateJsonSchema('GrantKey', invalidGrantKey)
    ).toThrow();
  });
});
