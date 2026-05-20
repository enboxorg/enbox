/**
 * Time-related helpers shared across packages.
 *
 * @module
 */

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
  return new Promise(resolve => setTimeout(resolve, durationInMilliseconds));
}
