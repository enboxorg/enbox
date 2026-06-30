import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';

const audienceKey = {
  contextId   : 'thread-1',
  epoch       : 1,
  keyMaterial : {
    algorithm        : 'X25519-HKDF-SHA256+A256KW',
    derivationScheme : 'roleAudience',
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
  protocol : 'https://example.com/protocol',
  role     : 'thread/participant',
};

describe('AudienceKey Schema', () => {
  it('should accept roleAudience X25519 key material', () => {
    expect(
      () => validateJsonSchema('AudienceKey', audienceKey)
    ).not.toThrow();
  });

  it('should reject unsupported key material algorithms', () => {
    const invalidAudienceKey = structuredClone(audienceKey);
    invalidAudienceKey.keyMaterial.algorithm = 'unsupported';

    expect(
      () => validateJsonSchema('AudienceKey', invalidAudienceKey)
    ).toThrow();
  });

  it('should reject non-roleAudience key material', () => {
    const invalidAudienceKey = structuredClone(audienceKey);
    invalidAudienceKey.keyMaterial.derivationScheme = 'protocolPath';

    expect(
      () => validateJsonSchema('AudienceKey', invalidAudienceKey)
    ).toThrow();
  });
});
