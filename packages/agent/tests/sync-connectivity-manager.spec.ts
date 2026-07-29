import { describe, expect, it } from 'bun:test';

import { resolveSyncConnectivityState, SyncConnectivityManager } from '../src/sync-connectivity-manager.js';

describe('SyncConnectivityManager', () => {
  it('folds active-link connectivity with online precedence and engine-state fallback', () => {
    const manager = new SyncConnectivityManager();

    expect(manager.getState([])).toBe('unknown');

    manager.setState('offline');
    expect(manager.getState([])).toBe('offline');
    expect(manager.getState(['unknown'])).toBe('unknown');
    expect(manager.getState(['unknown', 'offline'])).toBe('offline');
    expect(manager.getState(['offline', 'online'])).toBe('online');
    expect(resolveSyncConnectivityState(['offline', 'online'], 'offline')).toBe('online');
  });

  it('tracks sync outcomes while preserving unknown until reachability was established', () => {
    const manager = new SyncConnectivityManager();

    manager.recordFailure();
    expect(manager.getState([])).toBe('unknown');

    manager.recordSuccess();
    expect(manager.getState([])).toBe('online');

    manager.recordFailure();
    expect(manager.getState([])).toBe('offline');
  });
});
