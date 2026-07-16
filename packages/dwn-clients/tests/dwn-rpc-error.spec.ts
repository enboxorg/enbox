import { describe, expect, it } from 'bun:test';

import { JsonRpcErrorCodes } from '../src/json-rpc.js';
import { DwnRpcError, isQuotaExceededError } from '../src/dwn-rpc-error.js';

describe('isQuotaExceededError', () => {
  it('matches the typed data.code for storage and message quota', () => {
    expect(isQuotaExceededError('', { code: 'TenantStorageQuotaExceeded' })).toBe(true);
    expect(isQuotaExceededError('', { code: 'TenantMessageQuotaExceeded' })).toBe(true);
  });

  it('matches the message substring as a fallback', () => {
    expect(isQuotaExceededError('TenantStorageQuotaExceeded: tenant would exceed storage limit', undefined)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isQuotaExceededError('some other failure', { code: 'SomethingElse' })).toBe(false);
    expect(isQuotaExceededError('', undefined)).toBe(false);
    expect(isQuotaExceededError('', null)).toBe(false);
  });

  it('keeps a quota rejection non-terminal on DwnRpcError', () => {
    const quota = new DwnRpcError(
      JsonRpcErrorCodes.InvalidRequest,
      'TenantStorageQuotaExceeded: tenant would exceed storage limit of 1 bytes',
      { code: 'TenantStorageQuotaExceeded' },
    );
    expect(quota.terminal).toBe(false);

    // A plain InvalidRequest (no quota marker) stays terminal.
    const invalid = new DwnRpcError(JsonRpcErrorCodes.InvalidRequest, 'bad request');
    expect(invalid.terminal).toBe(true);
  });
});
