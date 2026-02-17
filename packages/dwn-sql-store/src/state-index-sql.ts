/**
 * SQL-backed implementation of the StateIndex interface.
 *
 * Manages per-tenant Sparse Merkle Trees (global + per-protocol sub-trees) backed by SQL tables.
 *
 * Tables:
 * - `stateIndexNodes`: stores SMT nodes (internal + leaf), keyed by (tenant, scope, nodeHash)
 * - `stateIndexRoots`: stores the current root hash per (tenant, scope)
 * - `stateIndexMeta`:  reverse lookup from messageCid → protocol (for deletion)
 */

import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType } from './types.js';
import type { Hash } from '@enbox/dwn-sdk-js';
import type { KeyValues } from '@enbox/dwn-sdk-js';
import type { StateIndex } from '@enbox/dwn-sdk-js';

import { initDefaultHashes } from '@enbox/dwn-sdk-js';
import { Kysely } from 'kysely';
import { SMTStoreSql } from './smt-store-sql.js';
import { SparseMerkleTree } from '@enbox/dwn-sdk-js';

export class StateIndexSql implements StateIndex {
  #dialect: Dialect;
  #db: Kysely<DwnDatabaseType> | null = null;

  /**
   * Cache of per-tenant global SMTs. Lazily populated on first access.
   * Stores promises to avoid race conditions when multiple concurrent operations
   * trigger lazy initialization for the same tenant.
   */
  #globalTrees: Map<string, Promise<SparseMerkleTree>> = new Map();

  /**
   * Cache of per-tenant, per-protocol SMTs. Key format: `{tenant}\x00{protocol}`.
   * Stores promises to avoid race conditions.
   */
  #protocolTrees: Map<string, Promise<SparseMerkleTree>> = new Map();

  constructor(dialect: Dialect) {
    this.#dialect = dialect;
  }

  async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new Kysely<DwnDatabaseType>({ dialect: this.#dialect });

    // Ensure default hashes are initialized for the SMT
    await initDefaultHashes();

    // ─── Create stateIndexNodes table ─────────────────────────────────────
    const nodesTableName = 'stateIndexNodes';
    const nodesTableExists = await this.#dialect.hasTable(this.#db, nodesTableName);
    if (!nodesTableExists) {
      await this.#db.schema
        .createTable(nodesTableName)
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('scope', 'varchar(200)', (col) => col.notNull())
        .addColumn('nodeHash', 'varchar(64)', (col) => col.notNull())
        .addColumn('nodeType', 'varchar(10)', (col) => col.notNull())
        .addColumn('leftHash', 'varchar(64)')
        .addColumn('rightHash', 'varchar(64)')
        .addColumn('leafKeyHash', 'varchar(64)')
        .addColumn('leafValueCid', 'varchar(60)')
        .execute();

      await this.createIndexes(this.#db, nodesTableName, [
        ['tenant', 'scope', 'nodeHash'],
      ]);
    }

    // ─── Create stateIndexRoots table ─────────────────────────────────────
    const rootsTableName = 'stateIndexRoots';
    const rootsTableExists = await this.#dialect.hasTable(this.#db, rootsTableName);
    if (!rootsTableExists) {
      await this.#db.schema
        .createTable(rootsTableName)
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('scope', 'varchar(200)', (col) => col.notNull())
        .addColumn('rootHash', 'varchar(64)', (col) => col.notNull())
        .execute();

      await this.createIndexes(this.#db, rootsTableName, [
        ['tenant', 'scope'],
      ]);
    }

    // ─── Create stateIndexMeta table ──────────────────────────────────────
    const metaTableName = 'stateIndexMeta';
    const metaTableExists = await this.#dialect.hasTable(this.#db, metaTableName);
    if (!metaTableExists) {
      await this.#db.schema
        .createTable(metaTableName)
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('messageCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('protocol', 'varchar(200)')
        .execute();

      await this.createIndexes(this.#db, metaTableName, [
        ['tenant', 'messageCid'],
      ]);
    }
  }

  async close(): Promise<void> {
    this.#globalTrees.clear();
    this.#protocolTrees.clear();
    await this.#db?.destroy();
    this.#db = null;
  }

  async clear(): Promise<void> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `clear`.');
    }

    this.#globalTrees.clear();
    this.#protocolTrees.clear();

    await this.#db.deleteFrom('stateIndexNodes').execute();
    await this.#db.deleteFrom('stateIndexRoots').execute();
    await this.#db.deleteFrom('stateIndexMeta').execute();
  }

  async insert(tenant: string, messageCid: string, indexes: KeyValues): Promise<void> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `insert`.');
    }

    // Insert into the global tree
    const globalSmt = await this.getGlobalTree(tenant);
    await globalSmt.insert(messageCid);

    // If the message is associated with a protocol, insert into the protocol-scoped tree
    const protocol = indexes.protocol as string | undefined;
    if (protocol !== undefined) {
      const protoSmt = await this.getProtocolTree(tenant, protocol);
      await protoSmt.insert(messageCid);
    }

    // Store reverse lookup metadata for deletion
    await this.#db
      .insertInto('stateIndexMeta')
      .values({
        tenant,
        messageCid,
        protocol: protocol ?? null,
      })
      .execute();
  }

  async delete(tenant: string, messageCids: string[]): Promise<void> {
    if (!this.#db) {
      throw new Error('Connection to database not open. Call `open` before using `delete`.');
    }

    if (messageCids.length === 0) {
      return;
    }

    const globalSmt = await this.getGlobalTree(tenant);

    for (const messageCid of messageCids) {
      // Look up stored metadata to find the protocol
      const meta = await this.#db
        .selectFrom('stateIndexMeta')
        .select('protocol')
        .where('tenant', '=', tenant)
        .where('messageCid', '=', messageCid)
        .executeTakeFirst();

      // Delete from global tree
      await globalSmt.delete(messageCid);

      // Delete from protocol tree if applicable
      if (meta?.protocol) {
        const protoSmt = await this.getProtocolTree(tenant, meta.protocol);
        await protoSmt.delete(messageCid);
      }

      // Remove the reverse lookup
      await this.#db
        .deleteFrom('stateIndexMeta')
        .where('tenant', '=', tenant)
        .where('messageCid', '=', messageCid)
        .execute();
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
   * Uses a promise-based cache to prevent concurrent callers from racing.
   */
  private getGlobalTree(tenant: string): Promise<SparseMerkleTree> {
    let smtPromise = this.#globalTrees.get(tenant);
    if (smtPromise !== undefined) {
      return smtPromise;
    }

    smtPromise = this.createTree(tenant, '');
    this.#globalTrees.set(tenant, smtPromise);
    return smtPromise;
  }

  /**
   * Get or create a protocol-scoped SMT for a tenant.
   * Uses a promise-based cache to prevent concurrent callers from racing.
   */
  private getProtocolTree(tenant: string, protocol: string): Promise<SparseMerkleTree> {
    const cacheKey = `${tenant}\x00${protocol}`;
    let smtPromise = this.#protocolTrees.get(cacheKey);
    if (smtPromise !== undefined) {
      return smtPromise;
    }

    smtPromise = this.createTree(tenant, protocol);
    this.#protocolTrees.set(cacheKey, smtPromise);
    return smtPromise;
  }

  /**
   * Create and initialize a new SparseMerkleTree backed by SQL via SMTStoreSql.
   */
  private async createTree(tenant: string, scope: string): Promise<SparseMerkleTree> {
    const store = new SMTStoreSql({
      db: this.#db!,
      tenant,
      scope,
    });
    const smt = new SparseMerkleTree(store);
    await smt.initialize();
    return smt;
  }

  /**
   * Creates indexes on the given table.
   * Follows the same pattern used by MessageStoreSql.
   */
  private async createIndexes<T>(database: Kysely<T>, tableName: string, indexes: string[][]): Promise<void> {
    for (const columnNames of indexes) {
      const indexName = 'index_' + tableName + '_' + columnNames.join('_');
      await database.schema
        .createIndex(indexName)
        .on(tableName)
        .columns(columnNames)
        .execute();
    }
  }
}


