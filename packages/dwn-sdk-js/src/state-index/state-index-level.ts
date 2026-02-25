/**
 * LevelDB-backed implementation of the StateIndex interface.
 *
 * Manages per-tenant Sparse Merkle Trees (global + per-protocol sub-trees).
 *
 * All data lives within a single LevelDB instance, partitioned by sublevels:
 *   {tenant}/global/        -> SMT nodes + root for the tenant's global tree
 *   {tenant}/proto/{proto}/ -> SMT nodes + root for a protocol-scoped tree
 *   {tenant}/meta/{cid}     -> JSON(indexes) for reverse lookup during deletion
 */

import type { Hash } from '../types/smt-types.js';
import type { KeyValues } from '../types/query-types.js';
import type { StateIndex } from '../types/state-index.js';

import { initDefaultHashes } from '../smt/smt-utils.js';
import { SMTStoreLevel } from '../smt/smt-store-level.js';
import { SparseMerkleTree } from '../smt/sparse-merkle-tree.js';
import { createLevelDatabase, LevelWrapper } from '../store/level-wrapper.js';

export type StateIndexLevelConfig = {
  /**
   * Must be a directory path (relative or absolute) where LevelDB will store its files,
   * or in browsers, the name of the IDBDatabase to be opened.
   */
  location? : string;
  createLevelDatabase? : typeof createLevelDatabase;
};

export class StateIndexLevel implements StateIndex {
  private config: StateIndexLevelConfig;
  private db!: LevelWrapper<string>;

  /**
   * Cache of per-tenant global SMTs. Lazily populated on first access.
   * Stores promises to avoid race conditions when multiple concurrent operations
   * trigger lazy initialization of the same tenant's SMT.
   */
  private globalTrees: Map<string, Promise<SparseMerkleTree>> = new Map();

  /**
   * Cache of per-tenant, per-protocol SMTs. Key format: `{tenant}\x00{protocol}`
   * Stores promises to avoid race conditions (same reason as globalTrees).
   */
  private protocolTrees: Map<string, Promise<SparseMerkleTree>> = new Map();

  constructor(config?: StateIndexLevelConfig) {
    this.config = {
      location            : 'STATEINDEX',
      createLevelDatabase : createLevelDatabase,
      ...config,
    };
  }

  async open(): Promise<void> {
    this.db = new LevelWrapper<string>({
      location            : this.config.location!,
      createLevelDatabase : this.config.createLevelDatabase,
      keyEncoding         : 'utf8',
    });
    await this.db.open();

    // Ensure default hashes are initialized
    await initDefaultHashes();
  }

  async close(): Promise<void> {
    this.globalTrees.clear();
    this.protocolTrees.clear();

    await this.db.close();
  }

  async clear(): Promise<void> {
    this.globalTrees.clear();
    this.protocolTrees.clear();

    await this.db.clear();
  }

  async insert(tenant: string, messageCid: string, indexes: KeyValues): Promise<void> {
    // Insert into the global tree
    const globalSmt = await this.getGlobalTree(tenant);
    await globalSmt.insert(messageCid);

    // Insert into the protocol-scoped tree if the message has a protocol (e.g. RecordsWrite).
    // Non-record messages like ProtocolsConfigure do not have a protocol.
    const protocol = indexes.protocol as string | undefined;
    if (protocol !== undefined) {
      const protoSmt = await this.getProtocolTree(tenant, protocol);
      await protoSmt.insert(messageCid);
    }

    // Store the reverse lookup so we know the protocol during deletion
    await this.storeIndexes(tenant, messageCid, indexes);
  }

  async delete(tenant: string, messageCids: string[]): Promise<void> {
    const globalSmt = await this.getGlobalTree(tenant);

    for (const messageCid of messageCids) {
      // Look up stored indexes to find the protocol
      const indexes = await this.getStoredIndexes(tenant, messageCid);

      // Delete from global tree
      await globalSmt.delete(messageCid);

      // Delete from protocol tree if the message had a protocol
      if (indexes !== undefined) {
        const protocol = indexes.protocol as string | undefined;
        if (protocol !== undefined) {
          const protoSmt = await this.getProtocolTree(tenant, protocol);
          await protoSmt.delete(messageCid);
        }
      }

      // Remove the reverse lookup
      await this.deleteStoredIndexes(tenant, messageCid);
    }
  }

  async getRoot(tenant: string): Promise<Hash> {
    const smt = await this.getGlobalTree(tenant);
    return smt.getRoot();
  }

  async getProtocolRoot(tenant: string, protocol: string): Promise<Hash> {
    const smt = await this.getProtocolTree(tenant, protocol);
    return smt.getRoot();
  }

  async getSubtreeHash(tenant: string, prefix: boolean[]): Promise<Hash> {
    const smt = await this.getGlobalTree(tenant);
    return smt.getSubtreeHash(prefix);
  }

  async getProtocolSubtreeHash(tenant: string, protocol: string, prefix: boolean[]): Promise<Hash> {
    const smt = await this.getProtocolTree(tenant, protocol);
    return smt.getSubtreeHash(prefix);
  }

  async getLeaves(tenant: string, prefix: boolean[]): Promise<string[]> {
    const smt = await this.getGlobalTree(tenant);
    return smt.getLeaves(prefix);
  }

  async getProtocolLeaves(tenant: string, protocol: string, prefix: boolean[]): Promise<string[]> {
    const smt = await this.getProtocolTree(tenant, protocol);
    return smt.getLeaves(prefix);
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Get or create the global SMT for a tenant.
   * Uses a promise-based cache to prevent concurrent callers from racing to
   * initialize the same tenant's SMT twice.
   */
  private getGlobalTree(tenant: string): Promise<SparseMerkleTree> {
    let smtPromise = this.globalTrees.get(tenant);
    if (smtPromise !== undefined) {
      return smtPromise;
    }

    smtPromise = this.createTree(this.db, [tenant, 'global']);
    this.globalTrees.set(tenant, smtPromise);
    return smtPromise;
  }

  /**
   * Get or create a protocol-scoped SMT for a tenant.
   * Uses a promise-based cache to prevent concurrent callers from racing to
   * initialize the same tenant's SMT twice.
   */
  private getProtocolTree(tenant: string, protocol: string): Promise<SparseMerkleTree> {
    const cacheKey = `${tenant}\x00${protocol}`;
    let smtPromise = this.protocolTrees.get(cacheKey);
    if (smtPromise !== undefined) {
      return smtPromise;
    }

    smtPromise = this.createTree(this.db, [tenant, 'proto', protocol]);
    this.protocolTrees.set(cacheKey, smtPromise);
    return smtPromise;
  }

  /**
   * Create and initialize a new SparseMerkleTree backed by a sublevel chain
   * within the single LevelDB instance.
   */
  private async createTree(db: LevelWrapper<string>, sublevels: string[]): Promise<SparseMerkleTree> {
    let partition = db;
    for (const name of sublevels) {
      partition = await partition.partition(name);
    }

    const store = new SMTStoreLevel(partition);
    const smt = new SparseMerkleTree(store);
    await smt.initialize();
    return smt;
  }

  /**
   * Store the indexes for a messageCid so we can look up the protocol during deletion.
   */
  private async storeIndexes(tenant: string, messageCid: string, indexes: KeyValues): Promise<void> {
    const metaPartition = await this.getMetaPartition(tenant);
    // Store the protocol index needed for deletion
    const minimalIndexes: KeyValues = { protocol: indexes.protocol };
    await metaPartition.put(messageCid, JSON.stringify(minimalIndexes));
  }

  /**
   * Get the stored indexes for a messageCid.
   */
  private async getStoredIndexes(tenant: string, messageCid: string): Promise<KeyValues | undefined> {
    const metaPartition = await this.getMetaPartition(tenant);
    const value = await metaPartition.get(messageCid);
    if (value === undefined) {
      return undefined;
    }
    return JSON.parse(value) as KeyValues;
  }

  /**
   * Delete the stored indexes for a messageCid.
   */
  private async deleteStoredIndexes(tenant: string, messageCid: string): Promise<void> {
    const metaPartition = await this.getMetaPartition(tenant);
    await metaPartition.delete(messageCid);
  }

  /**
   * Get the metadata partition for a tenant.
   */
  private async getMetaPartition(tenant: string): Promise<LevelWrapper<string>> {
    return (await this.db.partition(tenant)).partition('meta');
  }
}
