/** Minimal framework-agnostic external-store contract. */
export interface ObservableStore<Snapshot> {
  /** Return the current reference-stable snapshot. */
  getSnapshot: () => Snapshot;

  /** Subscribe to later snapshots. */
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
}
