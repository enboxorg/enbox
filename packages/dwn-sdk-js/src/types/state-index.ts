import type { Hash } from './smt-types.js';
import type { KeyValues } from './query-types.js';

/**
 * A Sparse Merkle Tree-backed state index that tracks the set of messageCids
 * for each tenant. Replaces the EventLog as the mechanism for sync state tracking.
 *
 * Key differences from EventLog:
 * - No watermark ordering — the SMT is a set, not a log
 * - Root hash provides O(1) "are we in sync?" comparison
 * - Supports subtree hashing for O(log n) set reconciliation
 * - Per-protocol sub-trees for scoped sync
 */
export interface StateIndex {
  /**
   * Opens a connection to the underlying store.
   */
  open(): Promise<void>;

  /**
   * Closes the connection to the underlying store.
   */
  close(): Promise<void>;

  /**
   * Clears all data. Mainly used for cleaning up in test environments.
   */
  clear(): Promise<void>;

  /**
   * Insert a message into the state index.
   *
   * @param tenant - the tenant's DID
   * @param messageCid - the CID of the message
   * @param indexes - key-value pairs from the message (used to extract `protocol` for
   *   per-protocol sub-tree maintenance, and stored for reverse lookup during deletion)
   */
  insert(tenant: string, messageCid: string, indexes: KeyValues): Promise<void>;

  /**
   * Delete messages from the state index.
   *
   * @param tenant - the tenant's DID
   * @param messageCids - the CIDs of the messages to remove
   */
  delete(tenant: string, messageCids: string[]): Promise<void>;

  /**
   * Get the SMT root hash for a tenant's global state (all protocols).
   *
   * @param tenant - the tenant's DID
   * @returns the root hash. Returns the default empty root if no messages exist.
   */
  getRoot(tenant: string): Promise<Hash>;

  /**
   * Get the SMT root hash for a specific protocol's state within a tenant.
   *
   * @param tenant - the tenant's DID
   * @param protocol - the protocol URI
   * @returns the root hash. Returns the default empty root if no messages exist for this protocol.
   */
  getProtocolRoot(tenant: string, protocol: string): Promise<Hash>;

  /**
   * Get the hash of a subtree at a given bit prefix within a tenant's global tree.
   * Used by the sync protocol for tree walking during set reconciliation.
   *
   * @param tenant - the tenant's DID
   * @param prefix - array of booleans representing the path (false=left, true=right)
   */
  getSubtreeHash(tenant: string, prefix: boolean[]): Promise<Hash>;

  /**
   * Get the hash of a subtree at a given bit prefix within a protocol-scoped tree.
   *
   * @param tenant - the tenant's DID
   * @param protocol - the protocol URI
   * @param prefix - array of booleans representing the path (false=left, true=right)
   */
  getProtocolSubtreeHash(tenant: string, protocol: string, prefix: boolean[]): Promise<Hash>;

  /**
   * Get all leaf messageCids under a given prefix in the tenant's global tree.
   * Used by the sync protocol to enumerate leaves in a divergent subtree.
   *
   * @param tenant - the tenant's DID
   * @param prefix - array of booleans representing the path
   */
  getLeaves(tenant: string, prefix: boolean[]): Promise<string[]>;

  /**
   * Get all leaf messageCids under a given prefix in a protocol-scoped tree.
   *
   * @param tenant - the tenant's DID
   * @param protocol - the protocol URI
   * @param prefix - array of booleans representing the path
   */
  getProtocolLeaves(tenant: string, protocol: string, prefix: boolean[]): Promise<string[]>;
}
