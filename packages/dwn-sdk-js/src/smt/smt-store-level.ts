/**
 * LevelDB-backed implementation of SMTNodeStore.
 *
 * Storage layout:
 * - Nodes are stored under the 'nodes' sublevel, keyed by hex-encoded hash
 * - The root hash is stored under the 'meta' sublevel with key 'root'
 * - Node values are JSON-serialized, with Uint8Array fields encoded as hex strings
 *
 * This store wraps a LevelWrapper sublevel provided by the parent (e.g. StateIndexLevel).
 * The parent manages the LevelDB lifecycle; open()/close() here only handle partition setup.
 */

import type { Hash, SMTInternalNode, SMTLeafNode, SMTNode, SMTNodeStore } from '../types/smt-types.js';

import type { LevelWrapper } from '../store/level-wrapper.js';

import { hashToHex, hexToHash } from './smt-utils.js';

type SerializedInternalNode = {
  type : 'internal';
  leftHash : string;
  rightHash : string;
};

type SerializedLeafNode = {
  type : 'leaf';
  keyHash : string;
  valueCid : string;
};

type SerializedNode = SerializedInternalNode | SerializedLeafNode;

export class SMTStoreLevel implements SMTNodeStore {
  private readonly db: LevelWrapper<string>;
  private nodesPartition!: LevelWrapper<string>;
  private metaPartition!: LevelWrapper<string>;
  private initialized = false;

  constructor(sublevel: LevelWrapper<string>) {
    this.db = sublevel;
  }

  async open(): Promise<void> {
    this.nodesPartition = await this.db.partition('nodes');
    this.metaPartition = await this.db.partition('meta');
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async clear(): Promise<void> {
    await this.db.clear();
    // Re-create partitions after clear
    this.nodesPartition = await this.db.partition('nodes');
    this.metaPartition = await this.db.partition('meta');
  }

  async getNode(hash: Hash): Promise<SMTNode | undefined> {
    this.ensureInitialized();

    const key = hashToHex(hash);
    const value = await this.nodesPartition.get(key);
    if (value === undefined) {
      return undefined;
    }

    return this.deserializeNode(JSON.parse(value) as SerializedNode);
  }

  async putNode(hash: Hash, node: SMTNode): Promise<void> {
    this.ensureInitialized();

    const key = hashToHex(hash);
    const serialized = this.serializeNode(node);
    await this.nodesPartition.put(key, JSON.stringify(serialized));
  }

  async deleteNode(hash: Hash): Promise<void> {
    this.ensureInitialized();

    const key = hashToHex(hash);
    await this.nodesPartition.delete(key);
  }

  async getRoot(): Promise<Hash | undefined> {
    this.ensureInitialized();

    const rootHex = await this.metaPartition.get('root');
    if (rootHex === undefined) {
      return undefined;
    }

    return hexToHash(rootHex);
  }

  async setRoot(hash: Hash): Promise<void> {
    this.ensureInitialized();

    await this.metaPartition.put('root', hashToHex(hash));
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SMTStoreLevel not initialized. Call open() first.');
    }
  }

  private serializeNode(node: SMTNode): SerializedNode {
    if (node.type === 'internal') {
      return {
        type      : 'internal',
        leftHash  : hashToHex(node.leftHash),
        rightHash : hashToHex(node.rightHash),
      };
    }

    return {
      type     : 'leaf',
      keyHash  : hashToHex(node.keyHash),
      valueCid : node.valueCid,
    };
  }

  private deserializeNode(serialized: SerializedNode): SMTNode {
    if (serialized.type === 'internal') {
      const node: SMTInternalNode = {
        type      : 'internal',
        leftHash  : hexToHash(serialized.leftHash),
        rightHash : hexToHash(serialized.rightHash),
      };
      return node;
    }

    const node: SMTLeafNode = {
      type     : 'leaf',
      keyHash  : hexToHash(serialized.keyHash),
      valueCid : serialized.valueCid,
    };
    return node;
  }
}
