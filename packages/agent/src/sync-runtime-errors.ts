import { DwnErrorCode } from '@enbox/dwn-sdk-js';

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
