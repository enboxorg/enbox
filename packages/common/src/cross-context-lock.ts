const pendingFallbackOperations = new Map<string, Promise<void>>();

/**
 * Run one operation exclusively across every browser context on the origin.
 * Non-browser runtimes use a module-wide queue, which coordinates every
 * caller in the process.
 */
export async function runWithCrossContextLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager !== undefined) {
    return lockManager.request(name, operation);
  }

  // `isSecureContext` exists on browser Window and Worker globals. Never
  // degrade to a realm-local queue there: doing so would reintroduce races
  // between tabs, workers, and service workers that share persistent state.
  if (globalThis.isSecureContext !== undefined) {
    throw new Error('Cross-context locking requires the Web Locks API.');
  }

  return runSerializedByKey(pendingFallbackOperations, name, operation);
}

/**
 * Serialize operations sharing one key through a pending-completion map: each
 * operation chains behind the key's tail, failures never poison the queue,
 * and the tail entry removes itself once no successor has replaced it.
 */
export async function runSerializedByKey<T>(
  pending: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pending.get(key);
  const operationPromise = (async (): Promise<T> => {
    if (previous !== undefined) {
      await previous;
    }
    return operation();
  })();
  const completion = operationPromise.then(
    (): void => undefined,
    (): void => undefined,
  );
  pending.set(key, completion);

  try {
    return await operationPromise;
  } finally {
    if (pending.get(key) === completion) {
      pending.delete(key);
    }
  }
}
