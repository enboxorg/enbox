import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';

const audience = {
  contextId    : 'thread-1',
  keyId        : 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  protocol     : 'https://example.com/protocol',
  publicKeyJwk : {
    crv : 'X25519',
    kty : 'OKP',
    x   : 'public-key',
  },
  rolePath         : 'thread/participant',
  sealedPrivateKey : {
    algorithm          : 'X25519-HKDF-SHA256+A256KW',
    derivationScheme   : 'seal',
    encryptedKey       : 'encrypted-key',
    ephemeralPublicKey : {
      crv : 'X25519',
      kty : 'OKP',
      x   : 'ephemeral-public-key',
    },
    keyId: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  },
};

describe('Audience Schema', () => {
  it('should accept a sealed audience key payload', () => {
    expect(
      () => validateJsonSchema('Audience', audience)
    ).not.toThrow();
  });

  it('should reject unsupported seal algorithms', () => {
    const invalidAudience = structuredClone(audience);
    invalidAudience.sealedPrivateKey.algorithm = 'unsupported';

    expect(
      () => validateJsonSchema('Audience', invalidAudience)
    ).toThrow();
  });

  it('should reject non-seal key wraps', () => {
    const invalidAudience = structuredClone(audience);
    invalidAudience.sealedPrivateKey.derivationScheme = 'roleAudience';

    expect(
      () => validateJsonSchema('Audience', invalidAudience)
    ).toThrow();
  });

  it('should reject key IDs that are not base64url thumbprints', () => {
    const invalidAudience = structuredClone(audience);
    invalidAudience.keyId = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF!';

    expect(
      () => validateJsonSchema('Audience', invalidAudience)
    ).toThrow();
  });
});
