/**
 * Backend-neutral persistence contract for the supplemental sync endpoint.
 *
 * Backing-store lifecycle is owned by the enclosing sync storage backend.
 */
export interface SyncEndpointStore {
  /** Remove the persisted supplemental endpoint. */
  clear(): Promise<void>;

  /** Get the supplemental endpoint, or `undefined` when it does not exist. */
  get(): Promise<string | undefined>;

  /** Create or replace the supplemental endpoint. */
  set(endpoint: string): Promise<void>;
}
