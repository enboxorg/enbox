/**
 * A promise paired with the resolve function a test uses to release it.
 * Argumentless {@link Deferred.resolve} calls are legal only for void values;
 * every other value type must be supplied explicitly.
 */
export type Deferred<Value = void> = {
  promise: Promise<Value>;
  resolve: [Value] extends [void]
    ? (value?: Value | PromiseLike<Value>) => void
    : (value: Value | PromiseLike<Value>) => void;
};

/** Create a {@link Deferred} whose resolution the test controls. */
export function deferred<Value = void>(): Deferred<Value> {
  let resolve!: (value?: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve as (value?: Value | PromiseLike<Value>) => void;
  });
  return { promise, resolve: resolve as Deferred<Value>['resolve'] };
}
