type ReadableStreamReader = {
  cancel?: (reason?: unknown) => Promise<void>;
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?: () => void;
};

/**
 * Wraps runtime-provided streams in a standard `ReadableStream` so downstream
 * consumers see consistent reader behavior across Bun and browsers.
 */
export function normalizeReadableStream(readableStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = readableStream.getReader() as ReadableStreamReader;
  let readerReleased = false;

  const releaseReader = (): void => {
    if (readerReleased) {
      return;
    }

    reader.releaseLock?.();
    readerReleased = true;
  };

  const cancelReader = async (reason?: unknown): Promise<void> => {
    try {
      await reader.cancel?.(reason);
    } finally {
      releaseReader();
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseReader();
          controller.close();
          return;
        }

        controller.enqueue(value!);
      } catch (error: unknown) {
        try {
          await reader.cancel?.(error);
        } catch {
          // Preserve the original read error.
        } finally {
          releaseReader();
        }
        throw error;
      }
    },

    async cancel(reason): Promise<void> {
      await cancelReader(reason);
    },
  });
}
