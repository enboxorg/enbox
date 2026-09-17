/**
 * Wraps the given `Promise` such that it will reject if the `AbortSignal` is
 * triggered first. This stops only the caller's wait; it does not cancel the
 * underlying operation.
 */
export async function executeUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }

  let onAbort!: () => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    // Keep the abort promise first so a pre-aborted signal wins even when the
    // operation promise is already settled. Both promises remain observed.
    return await Promise.race([abortPromise, promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
