import type { DwnResponseStatus } from '@enbox/agent';

import { DwnErrorCode } from '@enbox/dwn-sdk-js';

/** A DWN operation completed with a non-success response. */
export class DwnResponseError extends Error {
  /** The original DWN status. */
  public readonly status: Readonly<DwnResponseStatus['status']>;

  public constructor(operation: string, status: DwnResponseStatus['status']) {
    super(`${operation} failed (${status.code}): ${status.detail}`);
    this.name = 'DwnResponseError';
    this.status = { ...status };
  }
}

/** A record squash rejected because its timestamps do not exceed the authoritative floor. */
export class RecordSquashBackstopError extends DwnResponseError {
  /** The authoritative squash floor supplied by the DWN, when available. */
  public readonly squashFloorTimestamp: string | undefined;

  public constructor(operation: string, status: DwnResponseStatus['status']) {
    super(operation, status);
    this.name = 'RecordSquashBackstopError';
    const floor = status.info?.squashFloorTimestamp;
    this.squashFloorTimestamp = typeof floor === 'string' ? floor : undefined;
  }
}

/** A record write rejected because its same-protocol parent does not exist. */
export class RecordParentNotFoundError extends DwnResponseError {
  public constructor(operation: string, status: DwnResponseStatus['status']) {
    super(operation, status);
    this.name = 'RecordParentNotFoundError';
  }
}

/** @internal Whether another canonical record mutation already won DWN ordering. */
export function isCanonicalConflictStatus(status: DwnResponseStatus['status']): boolean {
  return status.code === 409 && status.detail === 'Conflict' && status.errorCode === undefined;
}

/** @internal Throw when a raw DWN response is not successful. */
export function requireDwnSuccess(operation: string, response: DwnResponseStatus): void {
  const { code, errorCode } = response.status;
  if (code < 200 || code > 299) {
    if (code === 409 && errorCode === DwnErrorCode.ProtocolAuthorizationSquashBackstop) {
      throw new RecordSquashBackstopError(operation, response.status);
    }
    if (code === 400 && errorCode === DwnErrorCode.ProtocolAuthorizationParentRecordNotFound) {
      throw new RecordParentNotFoundError(operation, response.status);
    }
    throw new DwnResponseError(operation, response.status);
  }
}
