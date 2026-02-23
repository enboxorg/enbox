import { describe, expect, it } from 'bun:test';

import { CryptoError, CryptoErrorCode } from '../src/crypto-error.js';

describe('CryptoError', () => {
  it('should be an instance of Error', () => {
    const error = new CryptoError(CryptoErrorCode.AlgorithmNotSupported, 'test message');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CryptoError);
  });

  it('should set the code property from the constructor', () => {
    const error = new CryptoError(CryptoErrorCode.InvalidJwk, 'invalid key');

    expect(error.code).toBe(CryptoErrorCode.InvalidJwk);
  });

  it('should set the message property from the constructor', () => {
    const error = new CryptoError(CryptoErrorCode.EncodingError, 'encoding failed');

    expect(error.message).toBe('encoding failed');
  });

  it('should set the name property to CryptoError', () => {
    const error = new CryptoError(CryptoErrorCode.InvalidCoseSign1, 'bad cose');

    expect(error.name).toBe('CryptoError');
  });

  it('should have a stack trace', () => {
    const error = new CryptoError(CryptoErrorCode.AlgorithmNotSupported, 'stack test');

    expect(error.stack).toBeDefined();
    expect(typeof error.stack).toBe('string');
  });

  it('should preserve instanceof checks through the prototype chain', () => {
    const error = new CryptoError(CryptoErrorCode.InvalidJwe, 'jwe error');

    // Verify that Object.setPrototypeOf in the constructor maintains correct prototype chain.
    expect(error instanceof CryptoError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  describe('CryptoErrorCode', () => {
    it('should contain AlgorithmNotSupported', () => {
      expect(CryptoErrorCode.AlgorithmNotSupported).toBe('algorithmNotSupported');
    });

    it('should contain EncodingError', () => {
      expect(CryptoErrorCode.EncodingError).toBe('encodingError');
    });

    it('should contain InvalidCoseSign1', () => {
      expect(CryptoErrorCode.InvalidCoseSign1).toBe('invalidCoseSign1');
    });

    it('should contain InvalidEat', () => {
      expect(CryptoErrorCode.InvalidEat).toBe('invalidEat');
    });

    it('should contain InvalidJwe', () => {
      expect(CryptoErrorCode.InvalidJwe).toBe('invalidJwe');
    });

    it('should contain InvalidJwk', () => {
      expect(CryptoErrorCode.InvalidJwk).toBe('invalidJwk');
    });

    it('should contain OperationNotSupported', () => {
      expect(CryptoErrorCode.OperationNotSupported).toBe('operationNotSupported');
    });

    it('should have exactly 7 error codes', () => {
      // CryptoErrorCode is a string enum, so we count string-valued keys.
      const codes = Object.values(CryptoErrorCode);
      expect(codes).toHaveLength(7);
    });
  });
});
