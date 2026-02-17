/**
 * In-memory implementation of SMTNodeStore.
 * Useful for tests and lightweight/ephemeral use cases.
 */

import type { Hash, SMTNode, SMTNodeStore } from './smt-types.js';

import { hashToHex } from './smt-utils.js';

export class SMTStoreMemory implements SMTNodeStore {
  private nodes: Map<string, SMTNode> = new Map();
  private root: Hash | undefined;

  async open(): Promise<void> {
    // no-op for in-memory store
  }

  async close(): Promise<void> {
    // no-op for in-memory store
  }

  async clear(): Promise<void> {
    this.nodes.clear();
    this.root = undefined;
  }

  async getNode(hash: Hash): Promise<SMTNode | undefined> {
    return this.nodes.get(hashToHex(hash));
  }

  async putNode(hash: Hash, node: SMTNode): Promise<void> {
    this.nodes.set(hashToHex(hash), node);
  }

  async deleteNode(hash: Hash): Promise<void> {
    this.nodes.delete(hashToHex(hash));
  }

  async getRoot(): Promise<Hash | undefined> {
    return this.root;
  }

  async setRoot(hash: Hash): Promise<void> {
    this.root = hash;
  }

  /**
   * Get the number of nodes currently stored (useful for tests).
   */
  get size(): number {
    return this.nodes.size;
  }
}
