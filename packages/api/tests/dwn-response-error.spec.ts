import type { DwnResponseStatus } from '@enbox/agent';

import { DwnErrorCode } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import {
  DwnResponseError,
  RecordParentNotFoundError,
  RecordSquashBackstopError,
  requireDwnSuccess,
} from '../src/dwn-response-error.js';

function captureFailure(status: DwnResponseStatus['status']): DwnResponseError {
  try {
    requireDwnSuccess('records.write', { status });
  } catch (error: unknown) {
    if (error instanceof DwnResponseError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected requireDwnSuccess() to throw');
}

describe('requireDwnSuccess', () => {
  it('should classify an exact squash backstop and expose its structured floor', () => {
    const status = {
      code      : 409,
      detail    : 'squash timestamp is not newer than the authoritative floor',
      errorCode : DwnErrorCode.ProtocolAuthorizationSquashBackstop,
      info      : { squashFloorTimestamp: '2026-01-01T00:00:00.000001Z' },
    };

    const error = captureFailure(status);

    expect(error).toBeInstanceOf(RecordSquashBackstopError);
    expect((error as RecordSquashBackstopError).squashFloorTimestamp).toBe(status.info.squashFloorTimestamp);
    expect(error.status).toEqual(status);
  });

  it('should classify an exact same-protocol parent miss', () => {
    const status = {
      code      : 400,
      detail    : 'parent record was not found',
      errorCode : DwnErrorCode.ProtocolAuthorizationParentRecordNotFound,
    };

    const error = captureFailure(status);

    expect(error).toBeInstanceOf(RecordParentNotFoundError);
    expect(error.status).toEqual(status);
  });

  it('should keep crossed, uncoded, and cross-protocol responses generic', () => {
    const responses: DwnResponseStatus['status'][] = [
      {
        code      : 400,
        detail    : 'bad request',
        errorCode : DwnErrorCode.ProtocolAuthorizationSquashBackstop,
      },
      {
        code      : 409,
        detail    : 'conflict',
        errorCode : DwnErrorCode.ProtocolAuthorizationParentRecordNotFound,
      },
      {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentRecordNotFound}: parent record was not found`,
      },
      {
        code      : 400,
        detail    : 'cross-protocol parent record was not found',
        errorCode : DwnErrorCode.ProtocolAuthorizationCrossProtocolParentNotFound,
      },
    ];

    for (const status of responses) {
      const error = captureFailure(status);
      expect(error.constructor).toBe(DwnResponseError);
      expect(error.status).toEqual(status);
    }
  });

  it('should accept successful responses', () => {
    expect(() => requireDwnSuccess('records.write', {
      status: { code: 202, detail: 'Accepted' },
    })).not.toThrow();
  });
});
