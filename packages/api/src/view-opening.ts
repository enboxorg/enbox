type OpeningView = {
  close(): Promise<void>;
  open(): Promise<void>;
};

/** Open a closeable view while preserving its first caller or session abort. */
export async function openView(
  view: OpeningView,
  signals: readonly (AbortSignal | undefined)[],
): Promise<void> {
  const signal = combineAbortSignals(...signals);
  try {
    await whileSignalsActive(() => view.open(), [signal]);
  } catch (error: unknown) {
    let closing: Promise<void>;
    try {
      closing = view.close();
    } catch {
      signal?.throwIfAborted();
      throw error;
    }

    try {
      await whileSignalsActive(() => closing, [signal]);
    } catch {
      if (signal?.aborted === true) {
        void closing.catch((): void => {});
        signal.throwIfAborted();
      }
      throw error;
    }
    throw error;
  }
}

/** Fence an opening operation with one or more independent lifetimes. */
export async function whileSignalsActive<T>(
  operation: () => Promise<T>,
  signals: readonly (AbortSignal | undefined)[],
): Promise<T> {
  const signal = combineAbortSignals(...signals);
  signal?.throwIfAborted();
  if (signal === undefined) {
    return operation();
  }

  let detachAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject): void => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    detachAbort = (): void => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      onAbort();
    }
  });

  try {
    const result = await Promise.race([operation(), aborted]);
    signal.throwIfAborted();
    return result;
  } catch (error: unknown) {
    signal.throwIfAborted();
    throw error;
  } finally {
    detachAbort();
  }
}

/** @internal Combine optional lifetimes while retaining the first abort reason. */
export function combineAbortSignals(
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return active.length < 2 ? active[0] : AbortSignal.any(active);
}
