/** Consumes a stream to completion without retaining its chunks. */
export async function drainReadableStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();

  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
