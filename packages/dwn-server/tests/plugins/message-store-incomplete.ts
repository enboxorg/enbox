/** Simulates a pre-replication MessageStore loaded from an untyped plugin. */
export default class IncompleteMessageStore {
  public open(): Promise<void> {
    return Promise.resolve();
  }
}
