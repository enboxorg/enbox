import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnError } from '../../src/core/dwn-error.js';
import { Time } from '../../src/utils/time.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('Time — fuzz', () => {

  describe('validateTimestamp — crash resistance', () => {
    it('should throw DwnError (not a raw Error) on arbitrary invalid strings', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 200 }), (str) => {
          try {
            Time.validateTimestamp(str);
            // If it doesn't throw, the string was a valid timestamp — that's fine
          } catch (error) {
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('createTimestamp — roundtrip with validateTimestamp', () => {
    it('should produce timestamps that always pass validation', () => {
      fc.assert(
        fc.property(
          fc.record({
            year        : fc.integer({ min: 1, max: 9999 }),
            month       : fc.integer({ min: 1, max: 12 }),
            day         : fc.integer({ min: 1, max: 28 }), // 28 is always valid
            hour        : fc.integer({ min: 0, max: 23 }),
            minute      : fc.integer({ min: 0, max: 59 }),
            second      : fc.integer({ min: 0, max: 59 }),
            millisecond : fc.integer({ min: 0, max: 999 }),
            microsecond : fc.integer({ min: 0, max: 999 }),
          }),
          (opts) => {
            const timestamp = Time.createTimestamp(opts);
            // Should not throw
            Time.validateTimestamp(timestamp);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('createTimestamp — format consistency', () => {
    it('should always produce ISO-8601 timestamps ending with Z (UTC) and microsecond precision', () => {
      // Pattern: YYYY-MM-DDTHH:MM:SS.xxxxxxZ
      const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
      fc.assert(
        fc.property(
          fc.record({
            year        : fc.integer({ min: 1, max: 9999 }),
            month       : fc.integer({ min: 1, max: 12 }),
            day         : fc.integer({ min: 1, max: 28 }),
            hour        : fc.integer({ min: 0, max: 23 }),
            minute      : fc.integer({ min: 0, max: 59 }),
            second      : fc.integer({ min: 0, max: 59 }),
            millisecond : fc.integer({ min: 0, max: 999 }),
            microsecond : fc.integer({ min: 0, max: 999 }),
          }),
          (opts) => {
            const timestamp = Time.createTimestamp(opts);
            expect(isoPattern.test(timestamp)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('createOffsetTimestamp — monotonicity', () => {
    it('should produce a later timestamp for positive offsets and earlier for negative offsets', () => {
      fc.assert(
        fc.property(
          fc.record({
            year        : fc.integer({ min: 100, max: 9000 }),
            month       : fc.integer({ min: 1, max: 12 }),
            day         : fc.integer({ min: 1, max: 28 }),
            hour        : fc.integer({ min: 0, max: 23 }),
            minute      : fc.integer({ min: 0, max: 59 }),
            second      : fc.integer({ min: 0, max: 59 }),
            millisecond : fc.integer({ min: 0, max: 999 }),
            microsecond : fc.integer({ min: 0, max: 999 }),
          }),
          fc.integer({ min: 1, max: 86400 }),
          (opts, offsetSeconds) => {
            const base = Time.createTimestamp(opts);

            const later = Time.createOffsetTimestamp({ seconds: offsetSeconds }, base);
            const earlier = Time.createOffsetTimestamp({ seconds: -offsetSeconds }, base);

            // Lexicographic comparison works for ISO-8601 UTC timestamps
            expect(later > base).toBe(true);
            expect(earlier < base).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getCurrentTimestamp — always valid', () => {
    it('should produce a timestamp that passes validation', () => {
      // Run a few times to check consistency
      for (let i = 0; i < 10; i++) {
        const timestamp = Time.getCurrentTimestamp();
        Time.validateTimestamp(timestamp);
      }
    });
  });
});
