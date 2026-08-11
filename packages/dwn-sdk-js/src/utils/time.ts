import { sleep } from '@enbox/common';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

type ParsedTimestamp = {
  epochMilliseconds: number;
  microsecond: number;
};

type TimestampOptions = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
  microsecond?: number;
};

const timestampRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * Time related utilities.
 */
export class Time {
  /**
   * We must sleep for at least 2ms to avoid timestamp collisions during testing.
   * https://github.com/enboxorg/enbox/issues/481
   *
   * For arbitrary-duration sleeps, use `sleep` from `@enbox/common`
   * directly — this class only retains the DWN-specific minimum.
   */
  public static async minimalSleep(): Promise<void> {
    await sleep(2);
  }

  /**
   * Returns an UTC ISO-8601 timestamp with microsecond precision accepted by DWN.
   */
  public static getCurrentTimestamp(): string {
    return Time.formatUtcTimestamp(Date.now(), 0);
  }

  /**
   * Creates a UTC ISO-8601 timestamp in microsecond precision accepted by DWN.
   * @param options - Options for creating the timestamp.
   * @returns string
   */
  public static createTimestamp(options: TimestampOptions): string {
    const year = Time.constrainInteger(Time.requireTimestampField(options.year, 'year'), 0, 9999);
    const month = Time.constrainInteger(Time.requireTimestampField(options.month, 'month'), 1, 12);
    const day = Time.constrainInteger(Time.requireTimestampField(options.day, 'day'), 1, Time.daysInUtcMonth(year, month));
    const hour = Time.constrainInteger(options.hour ?? 0, 0, 23);
    const minute = Time.constrainInteger(options.minute ?? 0, 0, 59);
    const second = Time.constrainInteger(options.second ?? 0, 0, 59);
    const millisecond = Time.constrainInteger(options.millisecond ?? 0, 0, 999);
    const microsecond = Time.constrainInteger(options.microsecond ?? 0, 0, 999);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millisecond);

    return Time.formatUtcTimestamp(date.getTime(), microsecond);
  }

  /**
   * Creates a UTC ISO-8601 timestamp offset from now or given timestamp accepted by DWN.
   * @param offset Negative number means offset into the past.
   */
  public static createOffsetTimestamp(offset: { seconds: number }, timestamp?: string): string {
    const parsedTimestamp = timestamp === undefined ? { epochMilliseconds: Date.now(), microsecond: 0 } : Time.parseTimestamp(timestamp);
    if (parsedTimestamp === undefined) {
      throw new DwnError(DwnErrorCode.TimestampInvalid, `Invalid timestamp: ${timestamp}`);
    }

    const offsetSeconds = Time.requireWholeNumber(offset.seconds, 'seconds');
    return Time.formatUtcTimestamp(parsedTimestamp.epochMilliseconds + (offsetSeconds * 1000), parsedTimestamp.microsecond);
  }

  /**
   * Creates the later of wall-clock now and the first DWN timestamp after the supplied floor.
   * @param floorTimestamp The exclusive timestamp floor.
   * @param nowMillis An epoch-millisecond wall-clock value. Defaults to `Date.now()`.
   */
  public static createTimestampAfter(floorTimestamp: string, nowMillis: number = Date.now()): string {
    const floor = Time.parseTimestamp(floorTimestamp);
    if (floor === undefined) {
      throw new DwnError(DwnErrorCode.TimestampInvalid, `Invalid timestamp: ${floorTimestamp}`);
    }

    const fraction = Number(floorTimestamp.slice(20, 26));
    const nextFloorTimestamp = fraction === 999_999
      ? Time.formatUtcTimestamp(floor.epochMilliseconds + 1, 0)
      : `${floorTimestamp.slice(0, 20)}${Time.pad(fraction + 1, 6)}Z`;
    const nowTimestamp = Time.formatUtcTimestamp(nowMillis, 0);

    return nextFloorTimestamp > nowTimestamp ? nextFloorTimestamp : nowTimestamp;
  }

  /**
   * Validates that the provided timestamp is a DWN-compatible UTC timestamp.
   * @param timestamp the timestamp to validate
   * @throws DwnError if timestamp is invalid
   */
  public static validateTimestamp(timestamp: string): void {
    if (Time.parseTimestamp(timestamp) === undefined) {
      throw new DwnError(DwnErrorCode.TimestampInvalid, `Invalid timestamp: ${timestamp}`);
    }
  }

  private static constrainInteger(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      throw new RangeError('timestamp field must be finite');
    }

    const integer = Math.trunc(value);
    return Math.min(Math.max(integer, min), max);
  }

  private static daysInUtcMonth(year: number, month: number): number {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month, 0);

    return date.getUTCDate();
  }

  private static formatUtcTimestamp(epochMilliseconds: number, microsecond: number): string {
    if (!Number.isSafeInteger(epochMilliseconds)) {
      throw new RangeError('timestamp epoch milliseconds must be a finite safe integer');
    }

    const date = new Date(epochMilliseconds);
    if (Number.isNaN(date.getTime())) {
      throw new RangeError('timestamp is outside the supported Date range');
    }

    const year = date.getUTCFullYear();
    if (year < 0 || year > 9999) {
      throw new RangeError('timestamp year must be between 0000 and 9999');
    }

    const fraction = String((date.getUTCMilliseconds() * 1000) + microsecond).padStart(6, '0');
    return `${Time.pad(year, 4)}-${Time.pad(date.getUTCMonth() + 1, 2)}-${Time.pad(date.getUTCDate(), 2)}` +
      `T${Time.pad(date.getUTCHours(), 2)}:${Time.pad(date.getUTCMinutes(), 2)}:${Time.pad(date.getUTCSeconds(), 2)}.${fraction}Z`;
  }

  private static pad(value: number, length: number): string {
    return String(value).padStart(length, '0');
  }

  private static parseTimestamp(timestamp: string): ParsedTimestamp | undefined {
    const match = timestampRegex.exec(timestamp);
    if (match === null) {
      return undefined;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const fraction = match[7];
    const millisecond = Number(fraction.slice(0, 3));
    const microsecond = Number(fraction.slice(3));
    const isLeapSecond = hour === 23 && minute === 59 && second === 60;

    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > Time.daysInUtcMonth(year, month) ||
      hour > 23 ||
      minute > 59 ||
      (second > 59 && !isLeapSecond)
    ) {
      return undefined;
    }

    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, isLeapSecond ? 59 : second, millisecond);

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute ||
      date.getUTCSeconds() !== (isLeapSecond ? 59 : second)
    ) {
      return undefined;
    }

    return { epochMilliseconds: date.getTime(), microsecond };
  }

  private static requireTimestampField(value: number | undefined, fieldName: string): number {
    if (value === undefined) {
      throw new TypeError(`required property '${fieldName}' missing or undefined`);
    }

    return value;
  }

  private static requireWholeNumber(value: number, fieldName: string): number {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new RangeError(`${fieldName} must be a finite integer`);
    }

    return value;
  }
}
