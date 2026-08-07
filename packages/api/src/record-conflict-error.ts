/** A record still conflicted after the bounded patch retry. */
export class RecordConflictError extends Error {
  public constructor(protocolPath: string, recordId: string, cause: unknown) {
    super(`Record '${recordId}' at '${protocolPath}' changed while applying the patch.`, { cause });
    this.name = 'RecordConflictError';
  }
}
