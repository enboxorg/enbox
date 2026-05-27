/**
 * Detect whether an error is a unique constraint violation from any
 * supported database dialect.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, unknown>;
  const code = err.code;
  const errno = err.errno;
  const message = typeof err.message === 'string' ? err.message : '';

  if (code === '23505') {
    return true;
  }

  if (errno === 1062) {
    return true;
  }

  if (
    typeof code === 'string' &&
    code.startsWith('SQLITE_CONSTRAINT') &&
    message.includes('UNIQUE')
  ) {
    return true;
  }

  if (
    (message.includes('duplicate key') || message.includes('Duplicate entry')) &&
    (message.includes('messageCid') ||
      message.includes('dataRefs') ||
      message.includes('dataBlocks') ||
      message.includes('unique constraint'))
  ) {
    return true;
  }

  return false;
}
