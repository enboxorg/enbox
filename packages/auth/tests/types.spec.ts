import { describe, expect, test } from 'bun:test';

import { ConnectDeniedError, isConnectDeniedError, isRecoveryPhraseMismatchError, RecoveryPhraseMismatchError } from '../src/errors.js';
import { INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../src/types.js';

describe('types constants', () => {
  test('INSECURE_DEFAULT_PASSWORD is a known string', () => {
    expect(INSECURE_DEFAULT_PASSWORD).toBe('insecure-static-phrase');
  });

  test('STORAGE_KEYS has all expected keys', () => {
    expect(STORAGE_KEYS.PREVIOUSLY_CONNECTED).toBe('enbox:auth:previouslyConnected');
    expect(STORAGE_KEYS.ACTIVE_IDENTITY).toBe('enbox:auth:activeIdentity');
    expect(STORAGE_KEYS.DELEGATE_DID).toBe('enbox:auth:delegateDid');
    expect(STORAGE_KEYS.CONNECTED_DID).toBe('enbox:auth:connectedDid');
  });
});

describe('RecoveryPhraseMismatchError', () => {
  test('isRecoveryPhraseMismatchError narrows only recovery mismatch errors', () => {
    expect(isRecoveryPhraseMismatchError(new RecoveryPhraseMismatchError())).toBe(true);
    expect(isRecoveryPhraseMismatchError(new Error('other'))).toBe(false);
  });
});

describe('ConnectDeniedError', () => {
  test('should carry the default connect-denied message, name, and code', () => {
    const error = new ConnectDeniedError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ConnectDeniedError');
    expect(error.code).toBe('CONNECT_DENIED');
    expect(error.message).toBe('[@enbox/auth] Connect was denied or cancelled by the user.');
  });

  test('should preserve a caller-supplied message', () => {
    const error = new ConnectDeniedError('[@enbox/auth] Connection was denied by the wallet.');

    expect(error.message).toBe('[@enbox/auth] Connection was denied by the wallet.');
  });

  test('isConnectDeniedError narrows only connect-denied errors', () => {
    expect(isConnectDeniedError(new ConnectDeniedError())).toBe(true);
    expect(isConnectDeniedError(new Error('[@enbox/auth] Connect was denied or cancelled by the user.'))).toBe(false);
    expect(isConnectDeniedError(new RecoveryPhraseMismatchError())).toBe(false);
    expect(isConnectDeniedError(undefined)).toBe(false);
    expect(isConnectDeniedError('denied')).toBe(false);
  });
});
