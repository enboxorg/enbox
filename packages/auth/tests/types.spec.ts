import { describe, expect, test } from 'bun:test';

import { INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../src/types.js';
import { isRecoveryPhraseMismatchError, RecoveryPhraseMismatchError } from '../src/errors.js';

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
