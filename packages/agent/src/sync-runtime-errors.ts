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
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const { code, detail } = error as { code?: unknown; detail?: unknown };
    if (typeof detail === 'string') {
      return typeof code === 'string' ? `${code}: ${detail}` : detail;
    }
  }
  return String(error);
}
