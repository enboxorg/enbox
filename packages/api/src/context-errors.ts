/** Retryable failure while a shared context cannot yet be established or replicated. */
export class ContextNotReadyError extends Error {
  public constructor(cause?: unknown) {
    super('The requested context is not ready. Retry after membership, encryption, and replication are ready.', { cause });
    this.name = 'ContextNotReadyError';
  }
}

/** A previously accepted member context that this handle can no longer access. */
export class ContextRetiredError extends Error {
  public constructor(contextId: string, cause?: unknown) {
    super(`Member context '${contextId}' is no longer active.`, { cause });
    this.name = 'ContextRetiredError';
  }
}
