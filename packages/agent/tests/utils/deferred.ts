/** A promise paired with the resolve function a test uses to release it. */
export type Deferred<Value = void> = {
  promise: Promise<Value>;
  resolve: (value?: Value | PromiseLike<Value>) => void;
};

/** Create a {@link Deferred} whose resolution the test controls. */
export function deferred<Value = void>(): Deferred<Value> {
  let resolve!: (value?: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve as (value?: Value | PromiseLike<Value>) => void;
  });
  return { promise, resolve };
}
