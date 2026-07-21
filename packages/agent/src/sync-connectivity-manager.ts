import type { SyncConnectivityState } from './types/sync.js';

/**
 * Folds transport-reported per-link connectivity with one-shot sync outcomes.
 *
 * Browser wake recovery belongs to the WebSocket transport, which owns socket
 * health checks, reconnect backoff, and durable-cursor resubscription. Keeping
 * this class state-only prevents a wake signal from independently launching a
 * second data-plane reconciliation wave.
 */
export class SyncConnectivityManager {
  private _state: SyncConnectivityState = 'unknown';

  /** Fold active-link connectivity, falling back to the global one-shot sync state. */
  public getState(linkStates: Iterable<SyncConnectivityState>): SyncConnectivityState {
    let hasLinks = false;
    let hasOffline = false;

    for (const state of linkStates) {
      hasLinks = true;
      if (state === 'online') {
        return 'online';
      }
      if (state === 'offline') {
        hasOffline = true;
      }
    }

    if (!hasLinks) {
      return this._state;
    }
    return hasOffline ? 'offline' : 'unknown';
  }

  /** Record a successful one-shot sync. */
  public recordSuccess(): void {
    this._state = 'online';
  }

  /** Record a failed one-shot sync, preserving unknown until reachability was established. */
  public recordFailure(): void {
    if (this._state === 'online') {
      this._state = 'offline';
    }
  }

  /** Replace the global state, primarily when a link initialization is rate-limited. */
  public setState(state: SyncConnectivityState): void {
    this._state = state;
  }
}
