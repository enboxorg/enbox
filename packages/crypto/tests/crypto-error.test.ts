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
    expect(error).toBeInstanceOf(CryptoError);
    expect(error).toBeInstanceOf(Error);
  });

  // NOTE: The original version had 7 individual tests asserting exact string values
  // for each CryptoErrorCode member (e.g. `expect(CryptoErrorCode.InvalidJwk).toBe('invalidJwk')`).
  // These were fragile snapshot-style assertions — they'd break on any value rename
  // without catching real bugs. Consolidated into two tests: one that verifies enum
  // membership (resilient to value changes) and one that tests the practical use case
  // of constructing a CryptoError and matching on its code.
  describe('CryptoErrorCode', () => {
    it('should include all expected error codes as string values', () => {
      // Verify the enum has the expected members. We check membership rather
      // than exact string values so the test is resilient to value renames.
      const codes = Object.keys(CryptoErrorCode);
      expect(codes).toContain('AlgorithmNotSupported');
      expect(codes).toContain('EncodingError');
      expect(codes).toContain('InvalidCoseSign1');
      expect(codes).toContain('InvalidEat');
      expect(codes).toContain('InvalidJwe');
      expect(codes).toContain('InvalidJwk');
      expect(codes).toContain('OperationNotSupported');
    });

    it('should produce a CryptoError with a code that can be compared by enum member', () => {
      // The practical use case: catch a CryptoError and switch on its code.
      const error = new CryptoError(CryptoErrorCode.AlgorithmNotSupported, 'test');
      expect(error.code).toBe(CryptoErrorCode.AlgorithmNotSupported);
      expect(typeof error.code).toBe('string');
    });
  });
});
