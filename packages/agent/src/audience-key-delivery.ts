import type { Status } from '@enbox/dwn-sdk-js';

import { DwnErrorCode } from '@enbox/dwn-sdk-js';

import type { AudienceKeyDeliveryFailure, AudienceKeyDeliveryOutcome } from './types/dwn.js';

import { PermissionGrantNotFoundError } from './permissions-api.js';
import { RemoteProtocolDefinitionError } from './dwn-protocol-cache.js';

const projectedFailureStates = {
  'awaiting-recipient-install' : 'awaiting-recipient-install',
  retryable                    : 'pending',
  terminal                     : 'failed',
} as const;

/** A source-side configuration or key-custody failure that requires an external change. */
export class AudienceKeyDeliveryConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudienceKeyDeliveryConfigurationError';
  }
}

/** Preserves a rejected encryption-control write's machine-readable status. */
export class AudienceControlWriteError extends Error {
  public readonly status: Status;

  public constructor(operation: string, status: Status) {
    super(`AgentDwnApi: Failed to ${operation}: ${status.detail}`);
    this.name = 'AudienceControlWriteError';
    this.status = status;
  }
}

/** Identity of one accepted role record's audience-key delivery intent. */
export type AudienceKeyDeliveryIntent = Readonly<{
  sourceDid: string;
  roleRecordId: string;
  protocol: string;
  rolePath: string;
  contextId: string;
  recipientDid: string;
}>;

/** Internal, reconstructable projection of one role record's delivery lifecycle. */
export type AudienceKeyDeliveryState = AudienceKeyDeliveryIntent & (
  | { readonly state: 'delivered' }
  | { readonly state: 'pending'; readonly reason?: string }
  | { readonly state: 'awaiting-recipient-install' | 'failed'; readonly reason: string }
);

/** Projects one typed delivery attempt. */
export function projectAudienceKeyDeliveryOutcome(
  intent: AudienceKeyDeliveryIntent,
  outcome: AudienceKeyDeliveryOutcome,
): AudienceKeyDeliveryState {
  if (outcome.delivered) {
    return { ...intent, state: 'delivered' };
  }

  return { ...intent, reason: outcome.reason, state: projectedFailureStates[outcome.failure] };
}

/** Maps typed delivery failures to the retry policy persisted by reconciliation. */
export function classifyAudienceKeyDeliveryFailure(error: unknown): AudienceKeyDeliveryFailure {
  if (error instanceof RemoteProtocolDefinitionError) {
    if (error.failure === 'not-found') {
      return 'awaiting-recipient-install';
    }
    if (error.failure === 'no-endpoint') {
      return 'terminal';
    }
    return isRetryableStatus(error.statusCode) ? 'retryable' : 'terminal';
  }

  if (error instanceof AudienceControlWriteError) {
    if (error.status.errorCode === DwnErrorCode.GrantAuthorizationGrantNotYetActive) {
      return 'retryable';
    }
    return isRetryableStatus(error.status.code) ? 'retryable' : 'terminal';
  }

  if (error instanceof AudienceKeyDeliveryConfigurationError || error instanceof PermissionGrantNotFoundError) {
    return 'terminal';
  }

  return 'retryable';
}

function isRetryableStatus(statusCode?: number): boolean {
  return statusCode === 408 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500);
}
