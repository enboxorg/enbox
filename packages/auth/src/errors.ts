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

/**
 * Signals that a password provider cannot run in the current environment.
 *
 * {@link PasswordProvider.chain} only advances to the next provider for this
 * error. Cancellation, credential failures, and unexpected errors stop the
 * chain so they cannot be hidden by a different authorization method.
 */
export class PasswordProviderUnavailableError extends Error {
  public readonly code = 'PASSWORD_PROVIDER_UNAVAILABLE';

  constructor(message = '[@enbox/auth] Password provider is unavailable.') {
    super(message);
    this.name = 'PasswordProviderUnavailableError';
  }
}
