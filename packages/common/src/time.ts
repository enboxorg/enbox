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
