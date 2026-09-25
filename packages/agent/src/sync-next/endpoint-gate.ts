import { runSerializedByKey } from '@enbox/common';
import { RateLimitError, SocketUnavailableError } from '@enbox/dwn-clients';

import { normalizeDwnEndpoint } from '../sync-target-resolver.js';

const ENDPOINT_BACKOFF_MS = 5_000;

/** Bounds transient network work per endpoint without persisting scheduler state. */
export class SyncNextEndpointGate {
  private readonly _blockedUntil = new Map<string, number>();
  private readonly _pending = new Map<string, Promise<void>>();

  public run<T>(endpoint: string, operation: () => Promise<T>): Promise<T> {
    const key = normalizeDwnEndpoint(endpoint);
    return runSerializedByKey(this._pending, key, async (): Promise<T> => {
      const retryAfterMs = (this._blockedUntil.get(key) ?? 0) - Date.now();
      if (retryAfterMs > 0) {
        throw new RateLimitError(retryAfterMs / 1_000, 'endpoint retry deferred');
      }
      try {
        return await operation();
      } catch (error: unknown) {
        if (SyncNextEndpointGate.isEndpointUnavailable(error)) {
          const delay = error instanceof RateLimitError
            ? error.retryAfterSec * 1_000
            : ENDPOINT_BACKOFF_MS;
          this.block(endpoint, delay);
        }
        throw error;
      }
    });
  }

  public block(endpoint: string, delayMs = ENDPOINT_BACKOFF_MS): void {
    const key = normalizeDwnEndpoint(endpoint);
    this._blockedUntil.set(key, Math.max(this._blockedUntil.get(key) ?? 0, Date.now() + Math.max(0, delayMs)));
  }

  public clear(endpoint: string): void {
    this._blockedUntil.delete(normalizeDwnEndpoint(endpoint));
  }

  public reset(): void {
    this._blockedUntil.clear();
  }

  private static isEndpointUnavailable(error: unknown): boolean {
    return error instanceof RateLimitError || error instanceof SocketUnavailableError ||
      (error instanceof TypeError && /fetch|network|load failed/i.test(error.message));
  }
}
