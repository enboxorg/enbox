import type { SyncConnectivityState } from './types/sync.js';

/** Fold per-link connectivity with online precedence and a zero-link fallback. */
export function resolveSyncConnectivityState(
  linkStates: Iterable<SyncConnectivityState>,
  fallback: SyncConnectivityState = 'unknown',
): SyncConnectivityState {
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
    return fallback;
  }
  return hasOffline ? 'offline' : 'unknown';
}
