/**
 * Sparse Merkle Tree (SMT) implementation.
 *
 * A 256-level binary trie where:
 * - Keys are SHA-256 hashes of messageCids (uniformly distributed across 2^256 key space)
 * - Leaves store the messageCid value
 * - Internal nodes store H(leftChild || rightChild)
 * - Empty subtrees are represented implicitly via precomputed default hashes
 *
 * Key properties:
 * - Deterministic: the same set of key-value pairs always produces the same root hash
 * - O(log n) insert, delete, and proof operations (practically O(256) worst case)
 * - Supports inclusion and non-inclusion proofs
 * - Root hash provides a fingerprint of the entire set for O(1) comparison
 */

import type { Hash, SMTDiffResult, SMTInternalNode, SMTLeafNode, SMTNodeStore, SMTProof } from './smt-types.js';

import { getBit, hashChildren, hashEquals, hashKey, hashLeaf, initDefaultHashes, SMT_DEPTH } from './smt-utils.js';

export class SparseMerkleTree {
  private store: SMTNodeStore;
  private defaultHashes!: Hash[];

  constructor(store: SMTNodeStore) {
    this.store = store;
  }

  /**
   * Initialize the SMT. Must be called before any operations.
   * Opens the store and precomputes default hashes.
   */
  async initialize(): Promise<void> {
    await this.store.open();
    this.defaultHashes = await initDefaultHashes();
  }

  /**
   * Close the underlying store.
   */
  async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * Clear all data from the tree.
   */
  async clear(): Promise<void> {
    await this.store.clear();
  }

  /**
   * Get the current root hash. Returns the default empty root if no root is set.
   */
  async getRoot(): Promise<Hash> {
    const root = await this.store.getRoot();
    if (root === undefined) {
      return this.defaultHashes[0];
    }
    return root;
  }

  /**
   * Insert a messageCid into the tree.
   * The key is SHA-256(messageCid), the value is the messageCid string.
   *
   * @returns the new root hash after insertion
   */
  async insert(messageCid: string): Promise<Hash> {
    const keyHash = await hashKey(messageCid);
    const leafHash = await hashLeaf(keyHash, messageCid);

    const leafNode: SMTLeafNode = {
      type     : 'leaf',
      keyHash  : keyHash,
      valueCid : messageCid,
    };

    // Store the leaf node
    await this.store.putNode(leafHash, leafNode);

    // Walk down the tree from root to leaf position, collecting the path
    const currentRoot = await this.getRoot();
    const newRoot = await this.insertAtNode(currentRoot, keyHash, leafHash, leafNode, 0);

    await this.store.setRoot(newRoot);
    return newRoot;
  }

  /**
   * Delete a messageCid from the tree.
   *
   * @returns the new root hash after deletion
   */
  async delete(messageCid: string): Promise<Hash> {
    const keyHash = await hashKey(messageCid);

    const currentRoot = await this.getRoot();
    const newRoot = await this.deleteAtNode(currentRoot, keyHash, 0);

    await this.store.setRoot(newRoot);
    return newRoot;
  }

  /**
   * Check if a messageCid exists in the tree.
   */
  async has(messageCid: string): Promise<boolean> {
    const keyHash = await hashKey(messageCid);
    const currentRoot = await this.getRoot();
    return this.existsAtNode(currentRoot, keyHash, 0);
  }

  /**
   * Generate a membership proof (inclusion or non-inclusion) for a messageCid.
   */
  async getProof(messageCid: string): Promise<SMTProof> {
    const keyHash = await hashKey(messageCid);
    const currentRoot = await this.getRoot();
    return this.generateProof(currentRoot, keyHash, 0);
  }

  /**
   * Get the hash of a subtree at a given bit prefix.
   * Used by the sync protocol for tree walking.
   *
   * @param prefix - array of booleans representing the path (false=left, true=right)
   * @returns the hash of the subtree at that prefix
   */
  async getSubtreeHash(prefix: boolean[]): Promise<Hash> {
    let currentHash = await this.getRoot();

    for (let i = 0; i < prefix.length; i++) {
      if (hashEquals(currentHash, this.defaultHashes[i])) {
        // Empty subtree — return the default hash at the target depth
        return this.defaultHashes[prefix.length];
      }

      const node = await this.store.getNode(currentHash);
      if (node === undefined || node.type === 'leaf') {
        // Leaf reached before prefix exhausted — need to compute what the
        // subtree hash would be if this leaf were pushed down to the prefix depth.
        // For simplicity, if we've hit a leaf, the subtree at this prefix
        // either contains this leaf or is empty.
        if (node !== undefined && node.type === 'leaf') {
          return this.computeSubtreeHashForLeaf(node, i, prefix);
        }
        return this.defaultHashes[prefix.length];
      }

      const internalNode = node as SMTInternalNode;
      if (prefix[i]) {
        currentHash = internalNode.rightHash;
      } else {
        currentHash = internalNode.leftHash;
      }
    }

    return currentHash;
  }

  /**
   * Get all leaf messageCids under a given prefix.
   * Used by the sync protocol for tree walking.
   */
  async getLeaves(prefix: boolean[]): Promise<string[]> {
    let currentHash = await this.getRoot();

    // Navigate to the subtree at the prefix
    for (let i = 0; i < prefix.length; i++) {
      if (hashEquals(currentHash, this.defaultHashes[i])) {
        return [];
      }

      const node = await this.store.getNode(currentHash);
      if (node === undefined) {
        return [];
      }

      if (node.type === 'leaf') {
        // Check if this leaf's key hash matches the prefix
        const leafMatchesPrefix = this.leafMatchesPrefix(node.keyHash, prefix);
        if (leafMatchesPrefix) {
          return [node.valueCid];
        }
        return [];
      }

      const internalNode = node as SMTInternalNode;
      if (prefix[i]) {
        currentHash = internalNode.rightHash;
      } else {
        currentHash = internalNode.leftHash;
      }
    }

    // Collect all leaves in this subtree
    return this.collectLeaves(currentHash, prefix.length);
  }

  /**
   * Compute a local diff between this tree and another tree's state,
   * given access to the other tree instance.
   *
   * This is used for same-process diffing (e.g., in tests or local operations).
   * For remote diffing, the sync protocol exchanges subtree hashes via messages.
   */
  async diff(other: SparseMerkleTree): Promise<SMTDiffResult> {
    const localRoot = await this.getRoot();
    const remoteRoot = await other.getRoot();

    if (hashEquals(localRoot, remoteRoot)) {
      return { onlyLocal: [], onlyRemote: [] };
    }

    const onlyLocal: string[] = [];
    const onlyRemote: string[] = [];

    await this.diffAtNode(localRoot, remoteRoot, 0, this, other, onlyLocal, onlyRemote);

    return { onlyLocal, onlyRemote };
  }

  // ─── Private methods ──────────────────────────────────────────────────────

  /**
   * Recursively insert a leaf into the tree, returning the new hash for the subtree at `depth`.
   */
  private async insertAtNode(
    currentHash: Hash,
    keyHash: Hash,
    leafHash: Hash,
    leafNode: SMTLeafNode,
    depth: number
  ): Promise<Hash> {
    // Base case: reached the maximum depth
    if (depth >= SMT_DEPTH) {
      return leafHash;
    }

    // If the current subtree is empty (default hash at this depth), just return the leaf hash.
    // But we need to handle the case where the leaf might need to be pushed down further
    // because we're at an intermediate depth.
    if (hashEquals(currentHash, this.defaultHashes[depth])) {
      // Place the leaf here — the leaf implicitly represents its position via keyHash
      return leafHash;
    }

    // Load the node at currentHash
    const node = await this.store.getNode(currentHash);
    if (node === undefined) {
      // Shouldn't happen for a well-formed tree, but handle gracefully
      return leafHash;
    }

    if (node.type === 'leaf') {
      // There's an existing leaf at this position
      if (hashEquals(node.keyHash, keyHash)) {
        // Same key — replace the value. Delete old leaf node.
        await this.store.deleteNode(currentHash);
        return leafHash;
      }

      // Different key — need to push both leaves down until their paths diverge
      return this.splitLeaves(node, currentHash, leafNode, leafHash, depth);
    }

    // Internal node — recurse into the appropriate child
    const internalNode = node as SMTInternalNode;
    const goRight = getBit(keyHash, depth);

    let newLeftHash: Hash;
    let newRightHash: Hash;

    if (goRight) {
      newLeftHash = internalNode.leftHash;
      newRightHash = await this.insertAtNode(internalNode.rightHash, keyHash, leafHash, leafNode, depth + 1);
    } else {
      newLeftHash = await this.insertAtNode(internalNode.leftHash, keyHash, leafHash, leafNode, depth + 1);
      newRightHash = internalNode.rightHash;
    }

    // Compute the new internal node hash
    const newHash = await hashChildren(newLeftHash, newRightHash);

    // Store the new internal node (if it differs from the old one)
    if (!hashEquals(newHash, currentHash)) {
      const newNode: SMTInternalNode = {
        type      : 'internal',
        leftHash  : newLeftHash,
        rightHash : newRightHash,
      };
      await this.store.putNode(newHash, newNode);

      // Clean up old internal node
      await this.store.deleteNode(currentHash);
    }

    return newHash;
  }

  /**
   * When two leaves collide at the same position in the tree, push them down
   * until their key paths diverge, creating internal nodes along the way.
   *
   * For example, if two leaves share the first 3 bits but diverge at bit 3,
   * and we're currently at depth 0, we need to create internal nodes at depths
   * 0, 1, and 2 (where one child is the chain and the other is a default hash),
   * plus the divergence node at depth 3 where the two leaves split.
   */
  private async splitLeaves(
    existingLeaf: SMTLeafNode,
    existingLeafHash: Hash,
    newLeaf: SMTLeafNode,
    newLeafHash: Hash,
    startDepth: number
  ): Promise<Hash> {
    // Find the depth where the two keys diverge
    let divergeDepth = startDepth;
    while (divergeDepth < SMT_DEPTH && getBit(existingLeaf.keyHash, divergeDepth) === getBit(newLeaf.keyHash, divergeDepth)) {
      divergeDepth++;
    }

    if (divergeDepth >= SMT_DEPTH) {
      // Keys are identical (shouldn't happen with SHA-256 on different inputs)
      return newLeafHash;
    }

    // At the divergence depth, the bits differ — one goes left, the other goes right
    const existingGoesRight = getBit(existingLeaf.keyHash, divergeDepth);

    let leftHash: Hash;
    let rightHash: Hash;

    if (existingGoesRight) {
      leftHash = newLeafHash;
      rightHash = existingLeafHash;
    } else {
      leftHash = existingLeafHash;
      rightHash = newLeafHash;
    }

    // Create the divergence node
    let currentHash = await hashChildren(leftHash, rightHash);
    await this.store.putNode(currentHash, {
      type      : 'internal',
      leftHash  : leftHash,
      rightHash : rightHash,
    });

    // Build internal nodes back up from (divergeDepth - 1) to startDepth.
    // At each intermediate depth, one child is the chain (currentHash) and
    // the other is the default empty hash for that depth + 1.
    for (let d = divergeDepth - 1; d >= startDepth; d--) {
      const bit = getBit(existingLeaf.keyHash, d); // both keys share this bit
      const defaultChild = this.defaultHashes[d + 1];

      let newLeft: Hash;
      let newRight: Hash;
      if (bit) {
        newLeft = defaultChild;
        newRight = currentHash;
      } else {
        newLeft = currentHash;
        newRight = defaultChild;
      }

      currentHash = await hashChildren(newLeft, newRight);
      await this.store.putNode(currentHash, {
        type      : 'internal',
        leftHash  : newLeft,
        rightHash : newRight,
      });
    }

    return currentHash;
  }

  /**
   * Recursively delete a key from the tree, returning the new hash for the subtree at `depth`.
   */
  private async deleteAtNode(currentHash: Hash, keyHash: Hash, depth: number): Promise<Hash> {
    if (depth >= SMT_DEPTH) {
      return this.defaultHashes[SMT_DEPTH];
    }

    // Empty subtree — nothing to delete
    if (hashEquals(currentHash, this.defaultHashes[depth])) {
      return currentHash;
    }

    const node = await this.store.getNode(currentHash);
    if (node === undefined) {
      return this.defaultHashes[depth];
    }

    if (node.type === 'leaf') {
      if (hashEquals(node.keyHash, keyHash)) {
        // Found the leaf to delete
        await this.store.deleteNode(currentHash);
        return this.defaultHashes[depth];
      }
      // Wrong leaf — key not in tree
      return currentHash;
    }

    // Internal node — recurse into the appropriate child
    const internalNode = node as SMTInternalNode;
    const goRight = getBit(keyHash, depth);

    let newLeftHash: Hash;
    let newRightHash: Hash;

    if (goRight) {
      newLeftHash = internalNode.leftHash;
      newRightHash = await this.deleteAtNode(internalNode.rightHash, keyHash, depth + 1);
    } else {
      newLeftHash = await this.deleteAtNode(internalNode.leftHash, keyHash, depth + 1);
      newRightHash = internalNode.rightHash;
    }

    // If both children are now default (empty), this node becomes empty too
    if (hashEquals(newLeftHash, this.defaultHashes[depth + 1]) && hashEquals(newRightHash, this.defaultHashes[depth + 1])) {
      await this.store.deleteNode(currentHash);
      return this.defaultHashes[depth];
    }

    // If one child is default and the other is a leaf, collapse upward
    // (the internal node is unnecessary — just return the leaf hash directly)
    const leftIsDefault = hashEquals(newLeftHash, this.defaultHashes[depth + 1]);
    const rightIsDefault = hashEquals(newRightHash, this.defaultHashes[depth + 1]);

    if (leftIsDefault || rightIsDefault) {
      const survivingHash = leftIsDefault ? newRightHash : newLeftHash;
      const survivingNode = await this.store.getNode(survivingHash);
      if (survivingNode !== undefined && survivingNode.type === 'leaf') {
        // Collapse: remove the internal node, return the leaf hash directly
        await this.store.deleteNode(currentHash);
        return survivingHash;
      }
    }

    // Recompute internal node hash
    const newHash = await hashChildren(newLeftHash, newRightHash);

    if (!hashEquals(newHash, currentHash)) {
      const newNode: SMTInternalNode = {
        type      : 'internal',
        leftHash  : newLeftHash,
        rightHash : newRightHash,
      };
      await this.store.putNode(newHash, newNode);
      await this.store.deleteNode(currentHash);
    }

    return newHash;
  }

  /**
   * Check if a key exists at the given node.
   */
  private async existsAtNode(currentHash: Hash, keyHash: Hash, depth: number): Promise<boolean> {
    if (depth >= SMT_DEPTH) {
      return false;
    }

    if (hashEquals(currentHash, this.defaultHashes[depth])) {
      return false;
    }

    const node = await this.store.getNode(currentHash);
    if (node === undefined) {
      return false;
    }

    if (node.type === 'leaf') {
      return hashEquals(node.keyHash, keyHash);
    }

    const internalNode = node as SMTInternalNode;
    const goRight = getBit(keyHash, depth);

    if (goRight) {
      return this.existsAtNode(internalNode.rightHash, keyHash, depth + 1);
    } else {
      return this.existsAtNode(internalNode.leftHash, keyHash, depth + 1);
    }
  }

  /**
   * Generate a proof for the given key at the given node.
   */
  private async generateProof(currentHash: Hash, keyHash: Hash, depth: number): Promise<SMTProof> {
    if (depth >= SMT_DEPTH) {
      return { siblings: [], leafNode: undefined, depth };
    }

    if (hashEquals(currentHash, this.defaultHashes[depth])) {
      return { siblings: [], leafNode: undefined, depth };
    }

    const node = await this.store.getNode(currentHash);
    if (node === undefined) {
      return { siblings: [], leafNode: undefined, depth };
    }

    if (node.type === 'leaf') {
      return { siblings: [], leafNode: node, depth };
    }

    const internalNode = node as SMTInternalNode;
    const goRight = getBit(keyHash, depth);

    let childHash: Hash;
    let siblingHash: Hash;

    if (goRight) {
      childHash = internalNode.rightHash;
      siblingHash = internalNode.leftHash;
    } else {
      childHash = internalNode.leftHash;
      siblingHash = internalNode.rightHash;
    }

    const childProof = await this.generateProof(childHash, keyHash, depth + 1);
    childProof.siblings.unshift(siblingHash);

    return childProof;
  }

  /**
   * Compute the subtree hash for a leaf that exists above the target prefix depth.
   * The leaf's effective position is determined by its keyHash bits.
   */
  private async computeSubtreeHashForLeaf(
    leaf: SMTLeafNode,
    currentDepth: number,
    prefix: boolean[]
  ): Promise<Hash> {
    // Check if the leaf's key matches the remaining prefix bits
    for (let i = currentDepth; i < prefix.length; i++) {
      if (getBit(leaf.keyHash, i) !== prefix[i]) {
        // Leaf is not under this prefix
        return this.defaultHashes[prefix.length];
      }
    }

    // Leaf is under this prefix — recompute its hash
    return await hashLeaf(leaf.keyHash, leaf.valueCid);
  }

  /**
   * Check if a leaf's keyHash matches a given prefix.
   */
  private leafMatchesPrefix(keyHash: Hash, prefix: boolean[]): boolean {
    for (let i = 0; i < prefix.length; i++) {
      if (getBit(keyHash, i) !== prefix[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Collect all leaf messageCids in the subtree rooted at the given hash.
   */
  private async collectLeaves(nodeHash: Hash, depth: number): Promise<string[]> {
    if (depth >= SMT_DEPTH || hashEquals(nodeHash, this.defaultHashes[depth])) {
      return [];
    }

    const node = await this.store.getNode(nodeHash);
    if (node === undefined) {
      return [];
    }

    if (node.type === 'leaf') {
      return [node.valueCid];
    }

    const internalNode = node as SMTInternalNode;
    const leftLeaves = await this.collectLeaves(internalNode.leftHash, depth + 1);
    const rightLeaves = await this.collectLeaves(internalNode.rightHash, depth + 1);

    return [...leftLeaves, ...rightLeaves];
  }

  /**
   * Recursively diff two subtrees, collecting leaves that exist only in one or the other.
   */
  private async diffAtNode(
    localHash: Hash,
    remoteHash: Hash,
    depth: number,
    localTree: SparseMerkleTree,
    remoteTree: SparseMerkleTree,
    onlyLocal: string[],
    onlyRemote: string[]
  ): Promise<void> {
    // If hashes match, subtrees are identical — skip
    if (hashEquals(localHash, remoteHash)) {
      return;
    }

    // If we've reached max depth, something is wrong — bail out
    if (depth >= SMT_DEPTH) {
      return;
    }

    const localIsDefault = hashEquals(localHash, this.defaultHashes[depth]);
    const remoteIsDefault = hashEquals(remoteHash, this.defaultHashes[depth]);

    // If local is empty but remote is not, all remote leaves are "onlyRemote"
    if (localIsDefault && !remoteIsDefault) {
      const remoteLeaves = await remoteTree.collectLeaves(remoteHash, depth);
      onlyRemote.push(...remoteLeaves);
      return;
    }

    // If remote is empty but local is not, all local leaves are "onlyLocal"
    if (!localIsDefault && remoteIsDefault) {
      const localLeaves = await localTree.collectLeaves(localHash, depth);
      onlyLocal.push(...localLeaves);
      return;
    }

    // Both are non-default and non-equal — load nodes and recurse
    const localNode = await localTree.store.getNode(localHash);
    const remoteNode = await remoteTree.store.getNode(remoteHash);

    // Handle cases where one or both are leaves
    if (localNode?.type === 'leaf' && remoteNode?.type === 'leaf') {
      if (!hashEquals(localNode.keyHash, remoteNode.keyHash)) {
        // Different keys — both are unique to their respective trees
        onlyLocal.push(localNode.valueCid);
        onlyRemote.push(remoteNode.valueCid);
      } else if (localNode.valueCid !== remoteNode.valueCid) {
        // Same key, different value — treat as update
        onlyLocal.push(localNode.valueCid);
        onlyRemote.push(remoteNode.valueCid);
      }
      return;
    }

    // One is a leaf and the other is internal — expand the leaf side
    if (localNode?.type === 'leaf') {
      // Local is a single leaf; remote is a subtree
      // All remote leaves are potentially onlyRemote; check if the local leaf exists in remote
      const remoteLeaves = await remoteTree.collectLeaves(remoteHash, depth);
      const localCid = localNode.valueCid;
      const remoteSet = new Set(remoteLeaves);

      if (!remoteSet.has(localCid)) {
        onlyLocal.push(localCid);
      }
      for (const cid of remoteLeaves) {
        if (cid !== localCid) {
          onlyRemote.push(cid);
        }
      }
      return;
    }

    if (remoteNode?.type === 'leaf') {
      // Remote is a single leaf; local is a subtree
      const localLeaves = await localTree.collectLeaves(localHash, depth);
      const remoteCid = remoteNode.valueCid;
      const localSet = new Set(localLeaves);

      if (!localSet.has(remoteCid)) {
        onlyRemote.push(remoteCid);
      }
      for (const cid of localLeaves) {
        if (cid !== remoteCid) {
          onlyLocal.push(cid);
        }
      }
      return;
    }

    // Both are internal nodes — recurse into children
    if (localNode?.type === 'internal' && remoteNode?.type === 'internal') {
      await this.diffAtNode(localNode.leftHash, remoteNode.leftHash, depth + 1, localTree, remoteTree, onlyLocal, onlyRemote);
      await this.diffAtNode(localNode.rightHash, remoteNode.rightHash, depth + 1, localTree, remoteTree, onlyLocal, onlyRemote);
      return;
    }

    // Fallback: if a node is missing, collect all from the other side
    if (localNode === undefined) {
      const remoteLeaves = await remoteTree.collectLeaves(remoteHash, depth);
      onlyRemote.push(...remoteLeaves);
    }
    if (remoteNode === undefined) {
      const localLeaves = await localTree.collectLeaves(localHash, depth);
      onlyLocal.push(...localLeaves);
    }
  }
}
