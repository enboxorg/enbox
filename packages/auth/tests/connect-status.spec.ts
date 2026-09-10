import { describe, expect, test } from 'bun:test';

import {
  isSessionExpiredError,
  isSessionInvalidError,
  SESSION_EXPIRED_ERROR_CODE,
  SESSION_REVOKED_ERROR_CODE,
} from '../src/connect/status.js';

describe('session error helpers', () => {
  test('recognizes expired session errors in supported DWN result shapes', () => {
    expect(isSessionExpiredError({
      status: { code: 401, detail: `${SESSION_EXPIRED_ERROR_CODE}: expired` },
    })).toBe(true);
    expect(isSessionExpiredError({
      reply: { status: { code: 401, detail: `${SESSION_EXPIRED_ERROR_CODE}: expired` } },
    })).toBe(true);
    expect(isSessionExpiredError(`401: ${SESSION_EXPIRED_ERROR_CODE}: expired`)).toBe(true);
    expect(isSessionExpiredError(new Error(`${SESSION_EXPIRED_ERROR_CODE}: expired`))).toBe(true);
  });

  test('recognizes revoked grants as invalid but not expired', () => {
    const revoked = { code: 401, detail: `${SESSION_REVOKED_ERROR_CODE}: revoked` };

    expect(isSessionExpiredError(revoked)).toBe(false);
    expect(isSessionInvalidError(revoked)).toBe(true);
  });

  test('rejects mismatched details and explicit non-401 statuses', () => {
    expect(isSessionExpiredError({ code: 403, detail: `${SESSION_EXPIRED_ERROR_CODE}: expired` })).toBe(false);
    expect(isSessionExpiredError({ code: 401, detail: 'another error' })).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
  });

  test('parses a status prefix separated by whitespace only, with no colon or dash', () => {
    expect(isSessionExpiredError(`401 ${SESSION_EXPIRED_ERROR_CODE}: expired`)).toBe(true);
  });

  test('parses a status prefix separated by whitespace then a dash', () => {
    expect(isSessionExpiredError(`401 - ${SESSION_EXPIRED_ERROR_CODE}: expired`)).toBe(true);
  });

  test('does not treat a status-like prefix with no separator as a coded error', () => {
    expect(isSessionExpiredError(`401${SESSION_EXPIRED_ERROR_CODE}: expired`)).toBe(false);
  });
});
