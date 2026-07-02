/**
 * Time-related helpers shared across packages.
 *
 * @module
 */

import { logger } from './logger.js';

export type TimedOptions = {
  /** Receives the success/failure timing line. Defaults to the shared Enbox logger. */
  log?: (message: string) => void;
};

const durationUnitMultipliers = new Map<string, number>([
  ['ms', 1],
  ['msec', 1],
  ['msecs', 1],
  ['millisecond', 1],
  ['milliseconds', 1],
  ['s', 1000],
  ['sec', 1000],
  ['secs', 1000],
  ['second', 1000],
  ['seconds', 1000],
  ['m', 60 * 1000],
  ['min', 60 * 1000],
  ['mins', 60 * 1000],
  ['minute', 60 * 1000],
  ['minutes', 60 * 1000],
  ['h', 60 * 60 * 1000],
  ['hr', 60 * 60 * 1000],
  ['hrs', 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['hours', 60 * 60 * 1000],
  ['d', 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['days', 24 * 60 * 60 * 1000],
  ['w', 7 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['weeks', 7 * 24 * 60 * 60 * 1000],
  ['y', 365.25 * 24 * 60 * 60 * 1000],
  ['yr', 365.25 * 24 * 60 * 60 * 1000],
  ['yrs', 365.25 * 24 * 60 * 60 * 1000],
  ['year', 365.25 * 24 * 60 * 60 * 1000],
  ['years', 365.25 * 24 * 60 * 60 * 1000],
]);

/**
 * Returns a high-resolution monotonic timestamp in milliseconds.
 *
 * Uses `performance.now()` when available so elapsed durations are not
 * affected by wall-clock changes. Falls back to `Date.now()` in runtimes
 * that do not expose `performance`.
 */
export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

/**
 * Parses a human-readable duration string into milliseconds.
 *
 * Accepted units: milliseconds (`ms`), seconds (`s`), minutes (`m`), hours (`h`),
 * days (`d`), weeks (`w`), and years (`y`), including their common long-form
 * aliases such as `minutes` and `hours`. A bare numeric string is treated as
 * milliseconds.
 *
 * @throws Error if the input is empty, negative, non-finite, or uses an unknown unit.
 */
export function parseDurationInMilliseconds(duration: string): number {
  const match = /^((?:\d+|\d*\.\d+))\s*([a-zA-Z]+)?$/.exec(duration.trim());
  if (match === null) {
    throw new Error(`Invalid duration: '${duration}'`);
  }

  const durationUnit = match[2]?.toLowerCase() ?? 'ms';
  const multiplier = durationUnitMultipliers.get(durationUnit);
  if (multiplier === undefined) {
    throw new Error(`Invalid duration unit: '${durationUnit}'`);
  }

  const durationInMilliseconds = Number(match[1]) * multiplier;
  if (!Number.isFinite(durationInMilliseconds)) {
    throw new Error(`Invalid duration: '${duration}'`);
  }

  return durationInMilliseconds;
}

/**
 * Times an async operation and logs a single success/failure duration line.
 *
 * The label is intentionally caller-defined so packages can include their own
 * log namespace, e.g. `[connect.perf] response.sign`.
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  { log = logger.log.bind(logger) }: TimedOptions = {}
): Promise<T> {
  const start = nowMs();
  try {
    const result = await fn();
    const elapsed = nowMs() - start;
    log(`${label} ok in ${elapsed.toFixed(1)}ms`);
    return result;
  } catch (err) {
    const elapsed = nowMs() - start;
    log(`${label} fail in ${elapsed.toFixed(1)}ms`);
    throw err;
  }
}

/**
 * Returns a promise that resolves after the given duration.
 *
 * Use this anywhere you would otherwise inline
 * `new Promise(resolve => setTimeout(resolve, ms))` — retry backoff,
 * polling intervals, throttled tests, etc. Centralizing the idiom keeps
 * call sites readable and ensures every retry/poll path has one obvious
 * primitive to reach for.
 *
 * Negative or zero durations resolve on the next macrotask via
 * `setTimeout(_, 0)`; they do not throw.
 *
 * @param durationInMilliseconds - How long to wait, in milliseconds.
 * @returns A promise that resolves after the duration elapses.
 *
 * @example
 * ```ts
 * import { sleep } from '@enbox/common';
 *
 * await sleep(250); // pause for 250ms
 * ```
 */
export function sleep(durationInMilliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, durationInMilliseconds)));
}
