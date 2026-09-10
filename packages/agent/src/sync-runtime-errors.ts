import { DwnErrorCode } from '@enbox/dwn-sdk-js';

/**
 * A queued `sync()` follow-up was invalidated by an engine runtime transition
 * (`startSync`/`stopSync`/`clear`/`close`) before it could run. Rejecting —
 * rather than resolving silently — keeps the `sync()` contract honest: a
 * resolved call always means a run covering the request completed. Callers
 * racing runtime disposal by design can catch this error specifically.
 */
export class SyncRunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRunCancelledError';
  }
}

const terminalAuthorizationCodes = [
  DwnErrorCode.GrantAuthorizationGrantExpired,
  DwnErrorCode.GrantAuthorizationGrantRevoked,
  DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
];

/** Exact structured codes used to decide whether to inspect wallet approval status. */
export function isTerminalSyncAuthorizationErrorCode(code: unknown): boolean {
  return terminalAuthorizationCodes.some(candidate => code === candidate);
}

/** Authorization failures whose grants cannot recover through retry. */
export function isTerminalSyncAuthorizationFailure(detail: string | undefined): boolean {
  return detail !== undefined && terminalAuthorizationCodes.some(code => detail.includes(code));
}

/** Stable conversion for event diagnostics. */
export function syncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
