import { describe, expect, it } from 'bun:test';

import { resolveSyncConnectivityState } from '../src/sync-connectivity-manager.js';

describe('resolveSyncConnectivityState', () => {
  it('folds link connectivity with online precedence and an empty fallback', () => {
    expect(resolveSyncConnectivityState([])).toBe('unknown');
    expect(resolveSyncConnectivityState([], 'offline')).toBe('offline');
    expect(resolveSyncConnectivityState(['unknown'])).toBe('unknown');
    expect(resolveSyncConnectivityState(['unknown', 'offline'])).toBe('offline');
    expect(resolveSyncConnectivityState(['offline', 'online'], 'offline')).toBe('online');
  });
});
