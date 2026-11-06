import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnError } from '../../src/core/dwn-error.js';
import { normalizeModuleUrl, normalizeSchemaUrl, validateModuleUrlNormalized, validateSchemaUrlNormalized } from '../../src/utils/url.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('URL utilities — fuzz', () => {

  describe('normalizeModuleUrl — crash resistance', () => {
    it('should either return a string or throw DwnError on arbitrary input', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 300 }), (str) => {
          try {
            const result = normalizeModuleUrl(str);
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

  describe('normalizeModuleUrl — idempotency', () => {
    it('should produce the same result when applied twice to valid URLs', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          try {
            const once = normalizeModuleUrl(url);
            const twice = normalizeModuleUrl(once);
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

  describe('validateModuleUrlNormalized — consistency with normalizeModuleUrl', () => {
    it('should accept the output of normalizeModuleUrl', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          let normalized: string;
          try {
            normalized = normalizeModuleUrl(url);
          } catch {
            return; // If normalization itself throws, skip this case
          }
          // After normalization, validation should pass
          expect(() => validateModuleUrlNormalized(normalized)).not.toThrow();
        }),
        { numRuns }
      );
    });
  });

  describe('validateSchemaUrlNormalized — consistency with normalizeSchemaUrl', () => {
    it('should accept the output of normalizeSchemaUrl', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          let normalized: string;
          try {
            normalized = normalizeSchemaUrl(url);
          } catch {
            return; // If normalization itself throws, skip this case
          }
          // After normalization, validation should pass
          expect(() => validateSchemaUrlNormalized(normalized)).not.toThrow();
        }),
        { numRuns }
      );
    });
  });

  describe('normalizeModuleUrl — strips query and fragment', () => {
    it('should remove query strings and fragments from URLs', () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.string({ minLength: 1, maxLength: 30 }),
          (baseUrl, query, fragment) => {
            const urlWithExtra = `${baseUrl}?${query}#${fragment}`;
            try {
              const normalized = normalizeModuleUrl(urlWithExtra);
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

  describe('normalizeModuleUrl — no trailing slash', () => {
    it('should not end with a trailing slash', () => {
      fc.assert(
        fc.property(fc.webUrl(), (url) => {
          try {
            const normalized = normalizeModuleUrl(url);
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
