import { createHash } from 'crypto';
import { describe, expect, it } from 'bun:test';

import { ProofOfWork } from '../../src/registration/proof-of-work.js';

describe('ProofOfWork', () => {
  describe('computeHash()', () => {
    it('should compute a deterministic SHA-256 hash for known input', () => {
      const input = {
        challengeNonce : 'challenge-abc',
        responseNonce  : 'response-xyz',
        requestData    : 'did:example:123',
      };

      const result = ProofOfWork.computeHash(input);

      // Independently compute expected hash.
      const hash = createHash('sha256');
      hash.update('challenge-abc');
      hash.update('response-xyz');
      hash.update('did:example:123');
      const expected = hash.digest('hex');

      expect(result).toBe(expected);
    });

    it('should return a 64-character hex string', () => {
      const result = ProofOfWork.computeHash({
        challengeNonce : 'a',
        responseNonce  : 'b',
        requestData    : 'c',
      });

      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = ProofOfWork.computeHash({
        challengeNonce : 'nonce-1',
        responseNonce  : 'resp-1',
        requestData    : 'data-1',
      });

      const hash2 = ProofOfWork.computeHash({
        challengeNonce : 'nonce-2',
        responseNonce  : 'resp-2',
        requestData    : 'data-2',
      });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hashAsHexString()', () => {
    it('should return a valid hex string for empty input array', () => {
      const result = ProofOfWork.hashAsHexString([]);

      // SHA-256 of empty input.
      const expected = createHash('sha256').digest('hex');
      expect(result).toBe(expected);
    });

    it('should return correct hash for known single-element input', () => {
      const result = ProofOfWork.hashAsHexString(['hello']);

      const expected = createHash('sha256').update('hello').digest('hex');
      expect(result).toBe(expected);
    });

    it('should return correct hash for multi-element input', () => {
      const result = ProofOfWork.hashAsHexString(['foo', 'bar', 'baz']);

      const hash = createHash('sha256');
      hash.update('foo');
      hash.update('bar');
      hash.update('baz');
      const expected = hash.digest('hex');

      expect(result).toBe(expected);
    });
  });

  describe('findQualifiedResponseNonce()', () => {
    it('should find a nonce that satisfies an easy difficulty requirement', () => {
      // Use a very permissive max hash (first byte must be < 0x80 — ~50% chance per attempt).
      const easyMaxHash = '7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

      const nonce = ProofOfWork.findQualifiedResponseNonce({
        maximumAllowedHashValue : easyMaxHash,
        challengeNonce          : 'test-challenge',
        requestData             : 'did:test:find-nonce',
      });

      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(0);

      // Verify the nonce actually qualifies.
      const computedHash = ProofOfWork.computeHash({
        challengeNonce : 'test-challenge',
        responseNonce  : nonce,
        requestData    : 'did:test:find-nonce',
      });

      const hashBigInt = BigInt(`0x${computedHash}`);
      const maxBigInt = BigInt(`0x${easyMaxHash}`);
      expect(hashBigInt <= maxBigInt).toBe(true);
    });
  });

  describe('verifyResponseNonce()', () => {
    it('should not throw when the nonce meets the difficulty requirement', () => {
      const easyMaxHash = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
      const maximumAllowedHashValue = BigInt(`0x${easyMaxHash}`);

      expect((): void => {
        ProofOfWork.verifyResponseNonce({
          maximumAllowedHashValue,
          challengeNonce : 'challenge',
          responseNonce  : 'response',
          requestData    : 'data',
        });
      }).not.toThrow();
    });

    it('should throw when the nonce does not meet the difficulty requirement', () => {
      // Impossibly strict: max hash is 0.
      const maximumAllowedHashValue = BigInt(0);

      expect((): void => {
        ProofOfWork.verifyResponseNonce({
          maximumAllowedHashValue,
          challengeNonce : 'challenge',
          responseNonce  : 'response',
          requestData    : 'data',
        });
      }).toThrow('Insufficient computed hash');
    });
  });

  describe('generateNonce()', () => {
    it('should return a 64-character uppercase hex string', () => {
      const nonce = ProofOfWork.generateNonce();
      expect(nonce).toHaveLength(64);
      expect(nonce).toMatch(/^[0-9A-F]{64}$/);
    });

    it('should generate unique nonces on successive calls', () => {
      const nonce1 = ProofOfWork.generateNonce();
      const nonce2 = ProofOfWork.generateNonce();
      expect(nonce1).not.toBe(nonce2);
    });
  });
});
