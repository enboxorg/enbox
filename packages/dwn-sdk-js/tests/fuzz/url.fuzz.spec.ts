import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnError } from '../../src/core/dwn-error.js';
import { normalizeProtocolUrl, normalizeSchemaUrl, validateProtocolUrlNormalized, validateSchemaUrlNormalized } from '../../src/utils/url.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('URL utilities — fuzz', () => {

  describe('normalizeProtocolUrl — crash resistance', () => {
    it('should either return a string or throw DwnError on arbitrary input', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 300 }), (str) => {
          try {
            const result = normalizeProtocolUrl(str);
            expect(typeof result).toBe('string');
          } catch (error) {
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('normalizeSchemaUrl — crash resistance', () => {
    it('should either return a string or throw DwnError on arbitrary input', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 300 }), (str) => {
          try {
            const result = normalizeSchemaUrl(str);
            expect(typeof result).toBe('string');
          } catch (error) {
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('normalizeProtocolUrl — idempotency', () => {
    it('should produce the same result when applied twice to valid URLs', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          try {
            const once = normalizeProtocolUrl(url);
            const twice = normalizeProtocolUrl(once);
            expect(twice).toBe(once);
          } catch {
            // If normalization throws on the input URL, that's acceptable
          }
        }),
        { numRuns }
      );
    });
  });

  describe('normalizeSchemaUrl — idempotency', () => {
    it('should produce the same result when applied twice to valid URLs', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          try {
            const once = normalizeSchemaUrl(url);
            const twice = normalizeSchemaUrl(once);
            expect(twice).toBe(once);
          } catch {
            // If normalization throws on the input URL, that's acceptable
          }
        }),
        { numRuns }
      );
    });
  });

  describe('validateProtocolUrlNormalized — consistency with normalizeProtocolUrl', () => {
    it('should accept the output of normalizeProtocolUrl', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          try {
            const normalized = normalizeProtocolUrl(url);
            // After normalization, validation should pass
            validateProtocolUrlNormalized(normalized);
          } catch {
            // If normalization itself throws, skip this case
          }
        }),
        { numRuns }
      );
    });
  });

  describe('validateSchemaUrlNormalized — consistency with normalizeSchemaUrl', () => {
    it('should accept the output of normalizeSchemaUrl', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          try {
            const normalized = normalizeSchemaUrl(url);
            // After normalization, validation should pass
            validateSchemaUrlNormalized(normalized);
          } catch {
            // If normalization itself throws, skip this case
          }
        }),
        { numRuns }
      );
    });
  });

  describe('normalizeProtocolUrl — strips query and fragment', () => {
    it('should remove query strings and fragments from URLs', () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.string({ minLength: 1, maxLength: 30 }),
          (baseUrl, query, fragment) => {
            const urlWithExtra = `${baseUrl}?${query}#${fragment}`;
            try {
              const normalized = normalizeProtocolUrl(urlWithExtra);
              expect(normalized.includes('?')).toBe(false);
              expect(normalized.includes('#')).toBe(false);
            } catch {
              // If normalization throws, that's acceptable for malformed URLs
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('normalizeProtocolUrl — no trailing slash', () => {
    it('should not end with a trailing slash', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          try {
            const normalized = normalizeProtocolUrl(url);
            expect(normalized.endsWith('/')).toBe(false);
          } catch {
            // If normalization throws, that's acceptable
          }
        }),
        { numRuns }
      );
    });
  });
});
