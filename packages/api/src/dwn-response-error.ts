import type { DwnResponseStatus } from '@enbox/agent';

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

/** @internal Whether another canonical record mutation already won DWN ordering. */
export function isCanonicalConflictStatus(status: DwnResponseStatus['status']): boolean {
  return status.code === 409 && status.detail === 'Conflict' && status.errorCode === undefined;
}

/** @internal Throw when a raw DWN response is not successful. */
export function requireDwnSuccess(operation: string, response: DwnResponseStatus): void {
  const { code } = response.status;
  if (code < 200 || code > 299) {
    throw new DwnResponseError(operation, response.status);
  }
}
