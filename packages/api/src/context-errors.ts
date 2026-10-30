/** Retryable failure while a shared context cannot yet be established or replicated. */
export class ContextNotReadyError extends Error {
  public constructor(cause?: unknown) {
    super('The requested context is not ready. Retry after membership, encryption, and replication are ready.', { cause });
    this.name = 'ContextNotReadyError';
  }
}

/** A context handle or in-flight follow superseded by current access or the saved follow choice. */
export class ContextRetiredError extends Error {
  public constructor(contextId: string, cause?: unknown) {
    super(`Member context '${contextId}' is no longer active.`, { cause });
    this.name = 'ContextRetiredError';
  }
}
