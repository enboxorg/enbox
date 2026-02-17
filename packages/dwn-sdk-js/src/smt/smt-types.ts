/**
 * Types for the Sparse Merkle Tree implementation.
 */

/**
 * A 32-byte hash (SHA-256 output).
 */
export type Hash = Uint8Array;

/**
 * Represents the path through the tree as a sequence of bits derived from the key hash.
 * Each bit determines whether to go left (0) or right (1) at each depth level.
 */
export type BitPath = boolean[];

/**
 * A node in the Sparse Merkle Tree.
 *
 * - `internal`: has left and right child hashes but no leaf data
 * - `leaf`: has a key hash and value (the messageCid) but no children
 * - empty subtrees are represented implicitly via precomputed default hashes
 */
export type SMTNode =
  | SMTInternalNode
  | SMTLeafNode;

export type SMTInternalNode = {
  type : 'internal';
  leftHash : Hash;
  rightHash : Hash;
};

export type SMTLeafNode = {
  type : 'leaf';
  keyHash : Hash;
  valueCid : string;
};

/**
 * An inclusion or non-inclusion proof for a key in the SMT.
 *
 * - `siblings`: the sibling hashes along the path from leaf to root
 * - `leafNode`: the leaf node at the path (undefined if non-inclusion proof for an empty slot)
 * - `depth`: the depth at which the proof terminates
 */
export type SMTProof = {
  siblings : Hash[];
  leafNode : SMTLeafNode | undefined;
  depth : number;
};

/**
 * Result of diffing two SMT roots.
 */
export type SMTDiffResult = {
  /** messageCids present in the local tree but not the remote tree */
  onlyLocal : string[];
  /** messageCids present in the remote tree but not the local tree */
  onlyRemote : string[];
};

/**
 * Interface for persisting SMT nodes. Implementations can use LevelDB, SQL, or in-memory maps.
 * Nodes are keyed by their hash. The root hash is stored separately.
 */
export interface SMTNodeStore {
  open(): Promise<void>;
  close(): Promise<void>;
  clear(): Promise<void>;

  /**
   * Get a node by its hash. Returns undefined if not found.
   */
  getNode(hash: Hash): Promise<SMTNode | undefined>;

  /**
   * Store a node, keyed by its hash.
   */
  putNode(hash: Hash, node: SMTNode): Promise<void>;

  /**
   * Delete a node by its hash.
   */
  deleteNode(hash: Hash): Promise<void>;

  /**
   * Get the current root hash. Returns undefined if no root has been set.
   */
  getRoot(): Promise<Hash | undefined>;

  /**
   * Set the root hash.
   */
  setRoot(hash: Hash): Promise<void>;
}
