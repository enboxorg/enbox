import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { describe, expect, it } from 'bun:test';


describe('time', () => {
  describe('validateTimestamp', () => {
    describe('invalid timestamps', () => {
      const invalidTimestamps = [
        '2022-02-31T10:20:30.405060Z', // invalid day
        '2022-01-36T90:20:30.405060Z', // invalid hour
        '2022-01-36T25:99:30.405060Z', // invalid minute
        '2022-14-18T10:30:00.123456Z', // invalid month
        '2022-04-29T10:30:00.123Z', // must use microsecond precision
        '2022-04-29T10:30:00.123456789Z', // must use microsecond precision
        '2022-04-29T10:30:00.123456+00:00', // must use UTC Z suffix
      ];
      invalidTimestamps.forEach((timestamp) => {
        it(`should throw an exception if an invalid timestamp is passed: ${timestamp}`, () => {
          expect(() => Time.validateTimestamp(timestamp)).toThrow(DwnErrorCode.TimestampInvalid);
        });
      });
    });

    describe('valid timestamps', () => {
      it('should pass if a valid timestamp is passed', () => {
        expect(() => Time.validateTimestamp('2022-04-29T10:30:00.123456Z')).not.toThrow();
        expect(() => Time.validateTimestamp('2022-04-29T23:59:60.123456Z')).not.toThrow();
        expect(() => Time.validateTimestamp(TestDataGenerator.randomTimestamp())).not.toThrow();
      });
    });
  });

  describe('createTimestamp', () => {
    it('should create a valid timestamp', () => {
      const timestamp = Time.createTimestamp({
        year        : 2022,
        month       : 4,
        day         : 29,
        hour        : 10,
        minute      : 30,
        second      : 0,
        millisecond : 123,
        microsecond : 456
      });
      expect(timestamp).toBe('2022-04-29T10:30:00.123456Z');
    });

    it('should constrain out-of-range fields without rolling into the next unit', () => {
      const timestamp = Time.createTimestamp({
        year        : 2023,
        month       : 2,
        day         : 29,
        hour        : 24,
        minute      : 60,
        second      : 60,
        millisecond : 1000,
        microsecond : 1000,
      });

      expect(timestamp).toBe('2023-02-28T23:59:59.999999Z');
    });

    for (let i = 0; i < 5; i++) {
      const year = TestDataGenerator.randomInt(1900, 2500);
      const month = TestDataGenerator.randomInt(1, 12);
      const day = TestDataGenerator.randomInt(1, 28);
      const hour = TestDataGenerator.randomInt(0, 23);
      const minute = TestDataGenerator.randomInt(0, 59);
      const second = TestDataGenerator.randomInt(0, 59);
      const millisecond = TestDataGenerator.randomInt(0, 999);
      const microsecond = TestDataGenerator.randomInt(0, 999);

      it(`should create a valid timestamp for random values ${i}`, () => {
        const timestamp = Time.createTimestamp({ year, month, day, hour, minute, second, millisecond, microsecond });
        expect(()=> Time.validateTimestamp(timestamp)).not.toThrow();
      });
    }
  });

  describe('createOffsetTimestamp', () => {
    it('should use the given timestamp as the base timestamp to compute the offset timestamp', () => {
      const baseTimestamp = '2000-04-29T10:30:00.123456Z';
      const offsetTimestamp = Time.createOffsetTimestamp({ seconds: 60 * 60 * 24 * 365 }, baseTimestamp);

      expect(offsetTimestamp).toBe('2001-04-29T10:30:00.123456Z');
    });

    it('should preserve microseconds across day and year boundaries', () => {
      const baseTimestamp = '2023-12-31T23:59:59.123456Z';

      expect(Time.createOffsetTimestamp({ seconds: 2 }, baseTimestamp)).toBe('2024-01-01T00:00:01.123456Z');
      expect(Time.createOffsetTimestamp({ seconds: -86_400 }, baseTimestamp)).toBe('2023-12-30T23:59:59.123456Z');
    });

    it('should preserve leap second offset behavior', () => {
      const baseTimestamp = '2022-04-29T23:59:60.123456Z';

      expect(Time.createOffsetTimestamp({ seconds: 1 }, baseTimestamp)).toBe('2022-04-30T00:00:00.123456Z');
    });
  });

  describe('createTimestampAfter', () => {
    it('should return wall-clock now when it is later than the floor', () => {
      expect(Time.createTimestampAfter('2025-12-31T23:59:59.999999Z', Date.UTC(2026, 0, 2, 3, 4, 5, 678)))
        .toBe('2026-01-02T03:04:05.678000Z');
    });

    it('should advance the floor by one microsecond with canonical carries', () => {
      const nowMillis = Date.UTC(2025, 0, 1);
      const cases = [
        ['2026-04-29T10:30:00.123456Z', '2026-04-29T10:30:00.123457Z'],
        ['2026-04-29T10:30:00.123999Z', '2026-04-29T10:30:00.124000Z'],
        ['2026-12-31T23:59:59.999999Z', '2027-01-01T00:00:00.000000Z'],
        ['2026-12-31T23:59:60.123999Z', '2026-12-31T23:59:60.124000Z'],
        ['2026-12-31T23:59:60.999999Z', '2027-01-01T00:00:00.000000Z'],
      ] as const;

      for (const [floor, expected] of cases) {
        expect(Time.createTimestampAfter(floor, nowMillis)).toBe(expected);
      }
    });

    it('should compare accepted leap seconds with wall-clock now chronologically', () => {
      const floor = '2026-12-31T23:59:60.123456Z';

      expect(Time.createTimestampAfter(floor, Date.UTC(2026, 11, 31, 23, 59, 59, 999)))
        .toBe('2026-12-31T23:59:60.123457Z');
      expect(Time.createTimestampAfter(floor, Date.UTC(2027, 0, 1, 0, 0, 0, 1)))
        .toBe('2027-01-01T00:00:00.001000Z');
    });

    it('should reject invalid floors and wall-clock values', () => {
      expect(() => Time.createTimestampAfter('2026-04-29T10:30:00.123Z'))
        .toThrow(DwnErrorCode.TimestampInvalid);
      expect(() => Time.createTimestampAfter('2026-04-29T10:30:00.123456Z', 0.5))
        .toThrow('finite safe integer');
      expect(() => Time.createTimestampAfter('2026-04-29T10:30:00.123456Z', Number.MAX_SAFE_INTEGER))
        .toThrow('outside the supported Date range');
      expect(() => Time.createTimestampAfter('9999-12-31T23:59:59.999999Z', Date.UTC(2025, 0, 1)))
        .toThrow('timestamp year must be between 0000 and 9999');
    });
  });
});
