import { DwnErrorCode } from '@enbox/dwn-sdk-js';

/**
 * A queued `sync()` follow-up was invalidated by an engine runtime transition
 * (`startSync`/`stopSync`/`clear`/`close`) before it could run. Rejecting —
 * rather than resolving silently — keeps the `sync()` contract honest: a
 * resolved call always means a run covering the request completed. Callers
 * racing teardown by design can catch this error specifically.
 */
export class SyncRunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRunCancelledError';
  }
}

/** Authorization failures whose grants cannot recover through retry. */
export function isTerminalSyncAuthorizationFailure(detail: string | undefined): boolean {
  if (!detail) {
    return false;
  }

  return detail.includes(DwnErrorCode.GrantAuthorizationGrantRevoked) ||
    detail.includes(DwnErrorCode.GrantAuthorizationGrantExpired) ||
    detail.includes(DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed);
}

/** Duck-typed transport marker used for expired subscription progress. */
export function isSyncProgressGapError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { isProgressGap?: unknown }).isProgressGap === true;
}

/** Stable conversion for event diagnostics. */
export function syncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
