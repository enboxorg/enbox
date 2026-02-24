import { Database } from 'bun:sqlite';

import log from 'loglevel';

import type { DataMetadataEntry } from './relay-data-store.js';

/**
 * SQLite-backed persistent store for relay data metadata.
 *
 * Stores the same `DataMetadataEntry` fields that RelayDataStore tracks
 * in-memory, so that eviction state survives restarts. On `open()`, the
 * in-memory caches (totalBytes, tenantBytes, metadata Map) are seeded
 * from the database. Subsequent mutations are written through to both
 * the in-memory structures (for fast access) and the SQLite database
 * (for durability).
 *
 * Uses `bun:sqlite` directly — the queries are simple enough that Kysely
 * overhead is unnecessary.
 */
export class MetadataStore {
  #db: Database | undefined;
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Open (or create) the SQLite database and run migrations.
   */
  open(): void {
    this.#db = new Database(this.#path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#migrate();
    log.debug(`MetadataStore: opened ${this.#path}`);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.#db?.close();
    this.#db = undefined;
    log.debug('MetadataStore: closed');
  }

  // ─── Schema migrations ──────────────────────────────────────────────

  #migrate(): void {
    const db = this.#db!;

    db.exec(`
      CREATE TABLE IF NOT EXISTS relay_data_metadata (
        tenant    TEXT NOT NULL,
        recordId  TEXT NOT NULL,
        dataCid   TEXT NOT NULL,
        dataSize  INTEGER NOT NULL,
        storedAt  INTEGER NOT NULL,
        protocol  TEXT,
        synced    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, recordId, dataCid)
      )
    `);

    // Index for eviction candidate queries: synced status + age ordering.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_metadata_eviction
        ON relay_data_metadata (synced, storedAt)
    `);

    // Index for per-tenant aggregation.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_metadata_tenant
        ON relay_data_metadata (tenant)
    `);
  }

  // ─── Read operations ────────────────────────────────────────────────

  /**
   * Load all metadata entries from the database.
   * Used to seed the in-memory Map on startup.
   */
  getAll(): DataMetadataEntry[] {
    const db = this.#db!;
    const rows = db.query(
      'SELECT tenant, recordId, dataCid, dataSize, storedAt, protocol, synced FROM relay_data_metadata'
    ).all() as Array<{
      tenant: string; recordId: string; dataCid: string;
      dataSize: number; storedAt: number; protocol: string | null; synced: number;
    }>;

    return rows.map(row => ({
      tenant   : row.tenant,
      recordId : row.recordId,
      dataCid  : row.dataCid,
      dataSize : row.dataSize,
      storedAt : row.storedAt,
      protocol : row.protocol ?? undefined,
      synced   : row.synced === 1,
    }));
  }

  /**
   * Get aggregate storage bytes across all tenants.
   */
  getTotalBytes(): number {
    const db = this.#db!;
    const row = db.query('SELECT COALESCE(SUM(dataSize), 0) as total FROM relay_data_metadata').get() as { total: number };
    return row.total;
  }

  /**
   * Get aggregate storage bytes grouped by tenant.
   */
  getTenantBytes(): Map<string, number> {
    const db = this.#db!;
    const rows = db.query(
      'SELECT tenant, SUM(dataSize) as total FROM relay_data_metadata GROUP BY tenant'
    ).all() as Array<{ tenant: string; total: number }>;

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.tenant, row.total);
    }
    return map;
  }

  // ─── Write operations ───────────────────────────────────────────────

  /**
   * Insert or replace a metadata entry.
   */
  put(entry: DataMetadataEntry): void {
    const db = this.#db!;
    db.query(`
      INSERT OR REPLACE INTO relay_data_metadata
        (tenant, recordId, dataCid, dataSize, storedAt, protocol, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.tenant, entry.recordId, entry.dataCid,
      entry.dataSize, entry.storedAt, entry.protocol ?? null, entry.synced ? 1 : 0,
    );
  }

  /**
   * Delete a metadata entry.
   */
  delete(tenant: string, recordId: string, dataCid: string): void {
    const db = this.#db!;
    db.query(
      'DELETE FROM relay_data_metadata WHERE tenant = ? AND recordId = ? AND dataCid = ?'
    ).run(tenant, recordId, dataCid);
  }

  /**
   * Mark an entry as synced.
   */
  markSynced(tenant: string, recordId: string, dataCid: string): void {
    const db = this.#db!;
    db.query(
      'UPDATE relay_data_metadata SET synced = 1 WHERE tenant = ? AND recordId = ? AND dataCid = ?'
    ).run(tenant, recordId, dataCid);
  }

  /**
   * Mark ALL entries for a tenant as synced.
   * Called when SMT root convergence is confirmed with a full peer.
   */
  markTenantSynced(tenant: string): void {
    const db = this.#db!;
    db.query('UPDATE relay_data_metadata SET synced = 1 WHERE tenant = ?').run(tenant);
  }

  /**
   * Set the protocol for a specific entry.
   */
  setProtocol(tenant: string, recordId: string, dataCid: string, protocol: string): void {
    const db = this.#db!;
    db.query(
      'UPDATE relay_data_metadata SET protocol = ? WHERE tenant = ? AND recordId = ? AND dataCid = ?'
    ).run(protocol, tenant, recordId, dataCid);
  }

  /**
   * Delete all metadata entries.
   */
  clear(): void {
    const db = this.#db!;
    db.exec('DELETE FROM relay_data_metadata');
  }
}
