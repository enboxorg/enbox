import type { Status } from '@enbox/dwn-sdk-js';

import { DwnErrorCode } from '@enbox/dwn-sdk-js';

import type { AudienceKeyDeliveryFailure } from './types/dwn.js';

import { PermissionGrantNotFoundError } from './permissions-api.js';
import { RemoteProtocolDefinitionError } from './dwn-protocol-cache.js';

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
