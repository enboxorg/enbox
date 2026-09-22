import { DwnErrorCode } from '@enbox/dwn-sdk-js';

const terminalAuthorizationCodes: readonly string[] = [
  DwnErrorCode.GrantAuthorizationGrantExpired,
  DwnErrorCode.GrantAuthorizationGrantRevoked,
  DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
];

/** Authorization failures whose grants cannot recover through retry. */
function isTerminalSyncAuthorizationFailure(detail: string | undefined): boolean {
  return detail !== undefined && terminalAuthorizationCodes.some(code => detail.includes(code));
}

/** Whether a role-authorized operation no longer has its matching role record. */
function isMissingRoleAuthorizationFailure(detail: string | undefined): boolean {
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
