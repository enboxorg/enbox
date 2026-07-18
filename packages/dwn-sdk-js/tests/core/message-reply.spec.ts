import type { GenericMessageReply } from '../../src/types/message-types.js';

import { messageReplyFromError } from '../../src/core/message-reply.js';
import { describe, expect, it } from 'bun:test';
import { DwnError, DwnErrorCode } from '../../src/core/dwn-error.js';

describe('Message Reply', () => {
  it('handles non-Errors being thrown', () => {
    let response: GenericMessageReply;
    try {
      throw 'Some error message';
    } catch (e: unknown) {
      response = messageReplyFromError(e, 500);
    }
    expect(response.status.code).toBe(500);
    expect(response.status.detail).toBe('Error');
    expect(response.status.errorCode).toBeUndefined();
    expect(response.status.info).toBeUndefined();
  });

  it('carries the error code and info of a DwnError constructed with an info bag', () => {
    const error = new DwnError(
      DwnErrorCode.ProtocolAuthorizationSquashBackstop,
      'some prose detail',
      { info: { squashFloorTimestamp: '2026-01-01T00:00:00.000000Z', someCount: 2, someFlag: true } }
    );

    const response = messageReplyFromError(error, 409);

    expect(response.status.code).toBe(409);
    expect(response.status.detail).toContain('some prose detail');
    expect(response.status.errorCode).toBe(DwnErrorCode.ProtocolAuthorizationSquashBackstop);
    expect(response.status.info).toEqual({ squashFloorTimestamp: '2026-01-01T00:00:00.000000Z', someCount: 2, someFlag: true });
  });

  it('carries the error code of a DwnError without an info bag and omits `info`', () => {
    const error = new DwnError(DwnErrorCode.ProtocolAuthorizationMissingRuleSet, 'some prose detail');

    const response = messageReplyFromError(error, 400);

    expect(response.status.code).toBe(400);
    expect(response.status.errorCode).toBe(DwnErrorCode.ProtocolAuthorizationMissingRuleSet);
    expect(response.status.info).toBeUndefined();
    expect('info' in response.status).toBe(false);
  });

  it('omits `errorCode` and `info` for plain Errors', () => {
    const response = messageReplyFromError(new Error('some plain error'), 500);

    expect(response.status.code).toBe(500);
    expect(response.status.detail).toBe('some plain error');
    expect(response.status.errorCode).toBeUndefined();
    expect(response.status.info).toBeUndefined();
    expect('errorCode' in response.status).toBe(false);
  });
});
