/**
 * SQL-backed implementation of SMTNodeStore.
 *
 * Storage layout:
 * - Nodes are stored in the `stateIndexNodes` table, keyed by hex-encoded hash
 * - The root hash is stored in the `stateIndexRoots` table
 * - Node values are serialized with Uint8Array fields encoded as hex strings
 *
 * Each SMTStoreSql instance represents a single tree (identified by a tenant + scope key).
 * Multiple instances share the same underlying Kysely database connection.
 */

import type { DwnDatabaseType } from './types.js';
import type { Kysely } from 'kysely';

import type { Hash, SMTInternalNode, SMTLeafNode, SMTNode, SMTNodeStore } from '@enbox/dwn-sdk-js';

import { hashToHex, hexToHash } from '@enbox/dwn-sdk-js';

export type SMTStoreSqlParams = {
  /** The shared Kysely database instance. */
  db: Kysely<DwnDatabaseType>;
  /** The tenant DID that owns this tree. */
  tenant: string;
  /** The scope key for this tree (e.g. '' for global, protocol URI for protocol-scoped). */
  scope: string;
};

export class SMTStoreSql implements SMTNodeStore {
  readonly #db: Kysely<DwnDatabaseType>;
  readonly #tenant: string;
  readonly #scope: string;

  constructor({ db, tenant, scope }: SMTStoreSqlParams) {
    this.#db = db;
    this.#tenant = tenant;
    this.#scope = scope;
  }

  async open(): Promise<void> {
    // No-op: the Kysely DB is already open and tables are created by StateIndexSql.
  }

  async close(): Promise<void> {
    // No-op: the Kysely DB lifecycle is managed by StateIndexSql.
  }

  async clear(): Promise<void> {
    await this.#db
      .deleteFrom('stateIndexNodes')
      .where('tenant', '=', this.#tenant)
      .where('scope', '=', this.#scope)
      .execute();

    await this.#db
      .deleteFrom('stateIndexRoots')
      .where('tenant', '=', this.#tenant)
      .where('scope', '=', this.#scope)
      .execute();
  }

  async getNode(hash: Hash): Promise<SMTNode | undefined> {
    const hexKey = hashToHex(hash);

    const result = await this.#db
      .selectFrom('stateIndexNodes')
      .selectAll()
      .where('tenant', '=', this.#tenant)
      .where('scope', '=', this.#scope)
      .where('nodeHash', '=', hexKey)
      .executeTakeFirst();

    if (!result) {
      return undefined;
    }

    return this.deserializeNode(result);
  }

  async putNode(hash: Hash, node: SMTNode): Promise<void> {
    const hexKey = hashToHex(hash);
    const values = this.serializeNodeToRow(hexKey, node);

    // Use INSERT ... ON CONFLICT REPLACE pattern.
    // Since different SQL dialects handle upsert differently, we use
    // delete-then-insert as a portable approach.
    await this.#db
      .deleteFrom('stateIndexNodes')
      .where('tenant', '=', this.#tenant)
      .where('scope', '=', this.#scope)
      .where('nodeHash', '=', hexKey)
      .execute();

    await this.#db
      .insertInto('stateIndexNodes')
      .values(values)
      .execute();
  }

  async deleteNode(hash: Hash): Promise<void> {
    const hexKey = hashToHex(hash);

    await this.#db
      .deleteFrom('stateIndexNodes')
      .where('tenant', '=', this.#tenant)
      .where('scope', '=', this.#scope)
      .where('nodeHash', '=', hexKey)
      .execute();
  }

  async getRoot(): Promise<Hash | undefined> {
    const result = await this.#db
      .selectFrom('stateIndexRoots')
      .select('rootHash')
      .where('tenant', '=', this.#tenant)
      .where('scope', '=', this.#scope)
      .executeTakeFirst();

    if (!result) {
      return undefined;
    }

    return hexToHash(result.rootHash);
  }

  async setRoot(hash: Hash): Promise<void> {
    const hexRoot = hashToHex(hash);

    // Delete-then-insert as a portable upsert.
    await this.#db
      .deleteFrom('stateIndexRoots')
      .where('tenant', '=', this.#tenant)
      .where('scope', '=', this.#scope)
      .execute();

    await this.#db
      .insertInto('stateIndexRoots')
      .values({
        tenant   : this.#tenant,
        scope    : this.#scope,
        rootHash : hexRoot,
      })
      .execute();
  }

  // ─── Serialization helpers ──────────────────────────────────────────────

  private serializeNodeToRow(hexKey: string, node: SMTNode): {
    tenant: string;
    scope: string;
    nodeHash: string;
    nodeType: string;
    leftHash: string | null;
    rightHash: string | null;
    leafKeyHash: string | null;
    leafValueCid: string | null;
  } {
    if (node.type === 'internal') {
      return {
        tenant       : this.#tenant,
        scope        : this.#scope,
        nodeHash     : hexKey,
        nodeType     : 'internal',
        leftHash     : hashToHex(node.leftHash),
        rightHash    : hashToHex(node.rightHash),
        leafKeyHash  : null,
        leafValueCid : null,
      };
    }

    return {
      tenant       : this.#tenant,
      scope        : this.#scope,
      nodeHash     : hexKey,
      nodeType     : 'leaf',
      leftHash     : null,
      rightHash    : null,
      leafKeyHash  : hashToHex(node.keyHash),
      leafValueCid : node.valueCid,
    };
  }

  private deserializeNode(row: {
    nodeType: string;
    leftHash: string | null;
    rightHash: string | null;
    leafKeyHash: string | null;
    leafValueCid: string | null;
  }): SMTNode {
    if (row.nodeType === 'internal') {
      const node: SMTInternalNode = {
        type      : 'internal',
        leftHash  : hexToHash(row.leftHash!),
        rightHash : hexToHash(row.rightHash!),
      };
      return node;
    }

    const node: SMTLeafNode = {
      type     : 'leaf',
      keyHash  : hexToHash(row.leafKeyHash!),
      valueCid : row.leafValueCid!,
    };
    return node;
  }
}
