import type { PushFailure } from '../types/sync.js';
import type { SyncNextDeliveryOutcome } from './types.js';

/** Classify one push failure by the work it prevents, shared by page intake and retry. */
export function syncNextDeliveryOutcome(failure: PushFailure): SyncNextDeliveryOutcome {
  if (failure.quotaBlocked === true) {
    return { blockScope: 'link', reason: 'quota' };
  }
  if (failure.tenantInactive === true) {
    return { blockScope: 'link', reason: 'authorization-unresolved' };
  }
  if (failure.kind === 'Invalid' || failure.terminal === true) {
    return { reason: 'remote-rejected' };
  }
  if (failure.localStatusCode === 401 || failure.localStatusCode === 403) {
    return { blockScope: 'link', reason: 'authorization-unresolved' };
  }
  const localStatusCode = failure.localStatusCode;
  if (localStatusCode !== undefined && (localStatusCode === 408 || localStatusCode === 429 || localStatusCode >= 500)) {
    return { blockScope: 'link', reason: 'transport' };
  }
  if (failure.localDataUnavailable === true) {
    return { reason: 'dependency' };
  }
  if (failure.localMissing === true || failure.localStatusCode !== undefined || failure.kind === 'Incomplete') {
    return { reason: 'dependency' };
  }
  if (failure.reason === 'record-data-unavailable') {
    return { reason: 'remote-incomplete' };
  }
  if (failure.kind === 'Deferred') {
    return { blockScope: 'link', reason: 'remote-incomplete' };
  }
  return { blockScope: 'endpoint', reason: 'transport' };
}
