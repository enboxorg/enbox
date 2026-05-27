export class RecoveryPhraseMismatchError extends Error {
  public readonly code = 'RECOVERY_PHRASE_MISMATCH';

  constructor(message = 'Recovery phrase does not match the initialized vault.') {
    super(message);
    this.name = 'RecoveryPhraseMismatchError';
  }
}

export function isRecoveryPhraseMismatchError(error: unknown): error is RecoveryPhraseMismatchError {
  return error instanceof RecoveryPhraseMismatchError;
}
