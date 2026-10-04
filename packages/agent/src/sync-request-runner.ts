/** Runs one logical remote sync request under caller-owned gating and cancellation. */
export type SyncRemoteRequestRunner = <T>(
  request: (signal?: AbortSignal) => Promise<T>,
) => Promise<T>;

/** Use caller-owned request coordination when present, otherwise run directly. */
export function runSyncRemoteRequest<T>(
  runner: SyncRemoteRequestRunner | undefined,
  request: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  return runner === undefined ? request() : runner(request);
}
