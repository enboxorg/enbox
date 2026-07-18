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

/**
 * Thrown when a connect, refresh, or wallet-approval flow ends because the
 * user (or their wallet) denied or cancelled the request.
 *
 * Denial is a normal user decision rather than a system failure, so apps
 * should branch on {@link isConnectDeniedError} instead of string-matching
 * error messages, and typically return to their signed-out state without
 * surfacing an error dialog.
 */
export class ConnectDeniedError extends Error {
  public readonly code = 'CONNECT_DENIED';

  constructor(message = '[@enbox/auth] Connect was denied or cancelled by the user.') {
    super(message);
    this.name = 'ConnectDeniedError';
  }
}

/** Returns whether an error reports a user- or wallet-denied connect, refresh, or approval flow. */
export function isConnectDeniedError(error: unknown): error is ConnectDeniedError {
  return error instanceof ConnectDeniedError;
}
