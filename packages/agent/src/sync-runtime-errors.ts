import { DwnErrorCode } from '@enbox/dwn-sdk-js';

import type { PushFailure, SyncAuthorization, SyncLinkRecoveryState } from './types/sync.js';

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

/** Aggregate run failure whose endpoint diagnostics may already have been reported. */
export class SyncRunFailedError extends Error {
  public readonly detailsReported: boolean;

  public constructor(message: string, params: { cause?: unknown; detailsReported: boolean }) {
    super(message, { cause: params.cause });
    this.name = 'SyncRunFailedError';
    this.detailsReported = params.detailsReported;
  }
}

/** Structured reconciliation failure retained until the workflow's single logging boundary. */
export class SyncPushFailuresError extends Error {
  public readonly authorization: SyncAuthorization;
  public readonly failures: readonly PushFailure[];
  public readonly remoteEndpoint: string;
  public readonly tenantDid: string;

  public constructor(params: {
    authorization: SyncAuthorization;
    failures: readonly PushFailure[];
    remoteEndpoint: string;
    tenantDid: string;
  }) {
    const { authorization, failures, remoteEndpoint, tenantDid } = params;
    super(
      `Sync reconciliation push failed for ${failures.length} message(s) ` +
      `for ${tenantDid} -> ${remoteEndpoint}.`,
    );
    this.name = 'SyncPushFailuresError';
    this.authorization = authorization;
    this.failures = [...failures];
    this.remoteEndpoint = remoteEndpoint;
    this.tenantDid = tenantDid;
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

/** Whether a durable recovery diagnostic represents work that may be retried. */
export function isRetryableSyncRecovery(recovery: SyncLinkRecoveryState | undefined): recovery is SyncLinkRecoveryState {
  return recovery !== undefined && !isNonRetryableSyncAuthorizationFailure(recovery.error);
}

/** Stable conversion for event diagnostics. */
export function syncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
