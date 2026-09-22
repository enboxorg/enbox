import { RateLimitError, SocketUnavailableError } from '@enbox/dwn-clients';

import { normalizeDwnEndpoint } from '../sync-target-resolver.js';

const ENDPOINT_BACKOFF_MS = 5_000;

type EndpointState = {
  active: number;
  blockedUntil: number;
  waiters: Array<() => void>;
};

/** Signals that another request already proved the endpoint unavailable. */
export class SyncNextEndpointBackoffError extends Error {
  public constructor(public readonly retryAfterMs: number) {
    super(`SyncNextEndpointGate: endpoint retry deferred for ${retryAfterMs} milliseconds.`);
    this.name = 'SyncNextEndpointBackoffError';
  }
}

/** Bounds transient network work per endpoint without persisting scheduler state. */
export class SyncNextEndpointGate {
  private readonly _states = new Map<string, EndpointState>();

  public constructor(private readonly _concurrency = 2) {
    if (!Number.isSafeInteger(_concurrency) || _concurrency < 1) {
      throw new RangeError('SyncNextEndpointGate: concurrency must be a positive safe integer.');
    }
  }

  public async run<T>(endpoint: string, operation: () => Promise<T>): Promise<T> {
    const key = normalizeDwnEndpoint(endpoint);
    const state = this.state(key);
    SyncNextEndpointGate.assertEligible(state);
    if (state.active >= this._concurrency) {
      await new Promise<void>(resolve => { state.waiters.push(resolve); });
    } else {
      state.active++;
    }
    try {
      SyncNextEndpointGate.assertEligible(state);
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
    } finally {
      const next = state.waiters.shift();
      if (next === undefined) {
        state.active--;
      } else {
        next();
      }
      if (state.active === 0 && state.waiters.length === 0 && state.blockedUntil <= Date.now()) {
        this._states.delete(key);
      }
    }
  }

  public block(endpoint: string, delayMs = ENDPOINT_BACKOFF_MS): void {
    const state = this.state(normalizeDwnEndpoint(endpoint));
    state.blockedUntil = Math.max(state.blockedUntil, Date.now() + Math.max(0, delayMs));
  }

  public clear(endpoint: string): void {
    const key = normalizeDwnEndpoint(endpoint);
    const state = this._states.get(key);
    if (state === undefined) {
      return;
    }
    state.blockedUntil = 0;
    if (state.active === 0 && state.waiters.length === 0) {
      this._states.delete(key);
    }
  }

  public reset(): void {
    this._states.clear();
  }

  private state(endpoint: string): EndpointState {
    let state = this._states.get(endpoint);
    if (state === undefined) {
      state = { active: 0, blockedUntil: 0, waiters: [] };
      this._states.set(endpoint, state);
    }
    return state;
  }

  private static assertEligible(state: EndpointState): void {
    const retryAfterMs = state.blockedUntil - Date.now();
    if (retryAfterMs > 0) {
      throw new SyncNextEndpointBackoffError(retryAfterMs);
    }
  }

  private static isEndpointUnavailable(error: unknown): boolean {
    if (error instanceof RateLimitError || error instanceof SocketUnavailableError) {
      return true;
    }
    if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
      return true;
    }
    if (error instanceof DOMException && (error.name === 'NetworkError' || error.name === 'TimeoutError')) {
      return true;
    }
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const record = error as { cause?: { code?: unknown }; code?: unknown };
    const code = record.code ?? record.cause?.code;
    return typeof code === 'string' && [
      'ConnectionRefused',
      'ECONNREFUSED',
      'ECONNRESET',
      'ENETUNREACH',
      'ETIMEDOUT',
    ].includes(code);
  }
}
