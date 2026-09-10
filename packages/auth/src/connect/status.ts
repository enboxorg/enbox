import { DwnErrorCode } from '@enbox/dwn-sdk-js';

export { computeConnectionStatus, fetchConnectionStatus, reconcileConnectionStatusGrants } from '@enbox/agent';

/** DWN error code emitted when an invoked permission grant has expired. */
export const SESSION_EXPIRED_ERROR_CODE = DwnErrorCode.GrantAuthorizationGrantExpired;

/** DWN error code emitted when an invoked permission grant has been revoked. */
export const SESSION_REVOKED_ERROR_CODE = DwnErrorCode.GrantAuthorizationGrantRevoked;

type NormalizedDwnError = {
  code?: number;
  detail: string;
};

/** Returns whether a DWN result or error reports an expired session grant. */
export function isSessionExpiredError(input: unknown): boolean {
  return matchesSessionError(input, SESSION_EXPIRED_ERROR_CODE);
}

/** Returns whether a DWN result or error reports an expired or revoked session grant. */
export function isSessionInvalidError(input: unknown): boolean {
  return isSessionExpiredError(input) || matchesSessionError(input, SESSION_REVOKED_ERROR_CODE);
}

function matchesSessionError(input: unknown, errorCode: string): boolean {
  const normalized = normalizeDwnError(input);
  if (normalized === undefined || (normalized.code !== undefined && normalized.code !== 401)) {
    return false;
  }

  return normalized.detail.startsWith(errorCode);
}

function normalizeDwnError(input: unknown): NormalizedDwnError | undefined {
  if (input instanceof Error) {
    return normalizeErrorText(input.message);
  }
  if (typeof input === 'string') {
    return normalizeErrorText(input);
  }
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.code === 'number' && typeof record.detail === 'string') {
    return { code: record.code, detail: record.detail };
  }
  if (record.status !== undefined) {
    return normalizeDwnError(record.status);
  }
  if (record.reply !== undefined) {
    return normalizeDwnError(record.reply);
  }

  return undefined;
}

function isSeparatorChar(char: string | undefined): boolean {
  return char === ':' || char === '-';
}

function isWhitespaceChar(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/**
 * Parses a leading `<3-digit code><separator><detail>` prefix, where separator
 * is a single `:`/`-` and/or a run of whitespace. Matched by hand — rather than
 * a regex with a quantified group nested inside an optional alternative — so the
 * scan is provably linear in the input length (Sonar S8786).
 */
function normalizeErrorText(text: string): NormalizedDwnError {
  const leadingWhitespace = text.length - text.trimStart().length;
  const digitsMatch = /^\d{3}/.exec(text.slice(leadingWhitespace));
  if (digitsMatch === null) {
    return { detail: text.trim() };
  }

  let index = leadingWhitespace + digitsMatch[0].length;
  let sawSeparator = false;

  if (isSeparatorChar(text[index])) {
    index += 1;
    sawSeparator = true;
    while (isWhitespaceChar(text[index])) { index += 1; }
  } else if (isWhitespaceChar(text[index])) {
    sawSeparator = true;
    while (isWhitespaceChar(text[index])) { index += 1; }
    if (isSeparatorChar(text[index])) {
      index += 1;
      while (isWhitespaceChar(text[index])) { index += 1; }
    }
  }

  if (!sawSeparator) {
    return { detail: text.trim() };
  }

  return {
    code   : Number(digitsMatch[0]),
    detail : text.slice(index).trim(),
  };
}
