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

const terminalAuthorizationCodes: readonly string[] = [
  DwnErrorCode.GrantAuthorizationGrantExpired,
  DwnErrorCode.GrantAuthorizationGrantRevoked,
  DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
];

/** Exact structured codes used to decide whether to inspect wallet approval status. */
export function isTerminalSyncAuthorizationErrorCode(code: unknown): code is string {
  return typeof code === 'string' && terminalAuthorizationCodes.includes(code);
}

/** Authorization failures whose grants cannot recover through retry. */
export function isTerminalSyncAuthorizationFailure(detail: string | undefined): boolean {
  return detail !== undefined && terminalAuthorizationCodes.some(code => detail.includes(code));
}

/** Whether a role-authorized operation no longer has its matching role record. */
export function isMissingRoleAuthorizationFailure(detail: string | undefined): boolean {
  return detail?.includes(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound) === true;
}

/** Authorization failures that must reach engine lifecycle handling instead of entering retry queues. */
export function isNonRetryableSyncAuthorizationFailure(detail: string | undefined): boolean {
  return isTerminalSyncAuthorizationFailure(detail) ||
    isMissingRoleAuthorizationFailure(detail);
}

/** Stable conversion for event diagnostics. */
export function syncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
