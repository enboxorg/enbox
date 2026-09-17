/**
 * Wraps the given `Promise` such that it will reject if the `AbortSignal` is
 * triggered first. This stops only the caller's wait; it does not cancel the
 * underlying operation.
 */
export async function executeUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }

  signal.throwIfAborted();

  let onAbort!: () => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
