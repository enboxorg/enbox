import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';

const delivery = {
  contextId   : 'thread-1',
  keyId       : 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
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
  rolePath : 'thread/participant',
};

describe('Delivery Schema', () => {
  it('should accept a roleAudience key delivery payload', () => {
    expect(
      () => validateJsonSchema('Delivery', delivery)
    ).not.toThrow();
  });

  it('should reject legacy epoch fields', () => {
    const invalidDelivery = {
      ...structuredClone(delivery),
      epoch: 1,
    };

    expect(
      () => validateJsonSchema('Delivery', invalidDelivery)
    ).toThrow();
  });

  it('should reject non-roleAudience key material', () => {
    const invalidDelivery = structuredClone(delivery);
    invalidDelivery.keyMaterial.derivationScheme = 'protocolPath';

    expect(
      () => validateJsonSchema('Delivery', invalidDelivery)
    ).toThrow();
  });

  it('should reject key IDs that are not base64url thumbprints', () => {
    const invalidDelivery = structuredClone(delivery);
    invalidDelivery.keyMaterial.keyId = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF!';

    expect(
      () => validateJsonSchema('Delivery', invalidDelivery)
    ).toThrow();
  });
});
