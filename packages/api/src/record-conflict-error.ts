/** A record still conflicted after the bounded patch retry. */
export class RecordConflictError extends Error {
  public constructor(modulePath: string, recordId: string, cause: unknown) {
    super(`Record '${recordId}' at '${modulePath}' changed while applying the patch.`, { cause });
    this.name = 'RecordConflictError';
  }
}
