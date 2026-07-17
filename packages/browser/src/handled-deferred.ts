/**
 * Internal deferred-promise helper for the DWeb Connect transports.
 *
 * @module
 */

/** A promise paired with its `resolve`/`reject` settlers. */
export type HandledDeferred<T> = {
  /** The deferred promise. Rejections are pre-marked as handled. */
  promise: Promise<T>;

  /** Resolves {@link HandledDeferred.promise}. */
  resolve: (value: T) => void;

  /** Rejects {@link HandledDeferred.promise}. */
  reject: (error: Error) => void;
};

/**
 * Creates a promise alongside its `resolve`/`reject` settlers, with rejections
 * pre-marked as handled — so a rejection that settles the promise before any
 * consumer attaches handlers (e.g. a timeout firing first) never surfaces as
 * an unhandled rejection.
 */
export function createHandledDeferred<T>(): HandledDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  // The executor runs synchronously, so `resolve`/`reject` are assigned
  // before the function returns.
  const promise = new Promise<T>((res, rej): void => {
    resolve = res;
    reject = rej;
  });
  promise.catch((): undefined => undefined);

  return { promise, resolve, reject };
}
