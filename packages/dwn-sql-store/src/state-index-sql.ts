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
import { SMTStoreSql } from './smt-store-sql.js';
import { SparseMerkleTree } from '@enbox/dwn-sdk-js';
import { Kysely, sql } from 'kysely';

export class StateIndexSql implements StateIndex {
  readonly #dialect: Dialect;
  #db: Kysely<DwnDatabaseType> | null = null;

  /**
   * Cache of per-tenant global SMTs. Lazily populated on first access.
   * Stores promises to avoid race conditions when multiple concurrent operations
   * trigger lazy initialization for the same tenant.
   */
  readonly #globalTrees: Map<string, Promise<SparseMerkleTree>> = new Map();

  /**
   * Cache of per-tenant, per-protocol SMTs. Key format: `{tenant}\x00{protocol}`.
   * Stores promises to avoid race conditions.
   */
  readonly #protocolTrees: Map<string, Promise<SparseMerkleTree>> = new Map();

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

    // Fail fast if migrations have not been run — tables must already exist.
    await this.#assertTablesExist();
  }

  /**
   * Verifies that the required tables exist by executing a zero-row SELECT.
   * Throws a clear error directing the caller to run migrations first.
   */
  async #assertTablesExist(): Promise<void> {
    const tables = ['stateIndexNodes', 'stateIndexRoots', 'stateIndexMeta'] as const;
    for (const table of tables) {
      try {
        await sql`SELECT 1 FROM ${sql.table(table)} LIMIT 0`.execute(this.#db!);
      } catch {
        throw new Error(
          `StateIndexSql: table '${table}' does not exist. Run DWN store migrations before opening stores.`
        );
      }
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

    // Insert into the protocol-scoped tree if the message has a protocol (e.g. RecordsWrite).
    // Non-record messages like ProtocolsConfigure do not have a protocol.
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

      // Delete from protocol tree if the message had a protocol
      if (meta && meta.protocol !== null) {
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

}


