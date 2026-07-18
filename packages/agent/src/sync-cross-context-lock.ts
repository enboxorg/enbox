const pendingFallbackOperations = new Map<string, Promise<void>>();

/**
 * Run one operation exclusively across every browser context on the origin.
 * Non-browser runtimes use a module-wide queue, which coordinates every
 * engine instance in the process.
 */
export async function runWithCrossContextLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager !== undefined) {
    return lockManager.request(name, operation);
  }

  // `isSecureContext` exists on browser Window and Worker globals. Never
  // degrade to a realm-local queue there: doing so would reintroduce races
  // between tabs, workers, and service workers on the same IndexedDB store.
  if (globalThis.isSecureContext !== undefined) {
    throw new Error('Cross-context sync locking requires the Web Locks API.');
  }

  const previous = pendingFallbackOperations.get(name);
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
  pendingFallbackOperations.set(name, completion);

  try {
    return await operationPromise;
  } finally {
    if (pendingFallbackOperations.get(name) === completion) {
      pendingFallbackOperations.delete(name);
    }
  }
}
