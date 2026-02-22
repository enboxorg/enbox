import type { Dialect } from '../dialect/dialect.js';
import type { Kysely } from 'kysely';
import type { Migration } from '../migration-runner.js';

import { sql } from 'kysely';

/**
 * Migration 002: Content-addressed DataStore with deduplication.
 *
 * Replaces the monolithic `dataStore` table (which stores entire blobs per
 * tenant+recordId+dataCid) with two tables that enable whole-file dedup:
 *
 * - `dataRefs`: reference table linking (tenant, recordId) to a dataCid.
 *   Multiple tenant/record pairs can reference the same dataCid. Includes
 *   `dataSize` for efficient size queries (fixes the existing admin store bug).
 *
 * - `dataBlocks`: content storage table keyed by (rootDataCid, blockCid).
 *   Stores individual ~256KB DAG-PB blocks produced by ipfs-unixfs-importer.
 *   Content is shared across all references to the same dataCid.
 *
 * Data migration strategy:
 * - For each row in the old `dataStore`, insert a ref into `dataRefs` and a
 *   single block into `dataBlocks` with blockCid = dataCid (treating the
 *   existing assembled blob as one block). This is a safe migration because
 *   the new DataStoreSql code will re-chunk via ipfs-unixfs-importer on the
 *   next write. Reads of migrated data use a fast path that detects the
 *   single-block case and returns the data directly without the exporter.
 *
 * NOTE: For large databases, the data migration may take significant time.
 * The migration runs in a single transaction for atomicity.
 */
export const migration002ContentAddressedDatastore: Migration = {
  name: '002-content-addressed-datastore',

  async up(db: Kysely<any>, dialect: Dialect): Promise<void> {

    // ─── Create dataRefs table ──────────────────────────────────────────
    if (!(await dialect.hasTable(db, 'dataRefs'))) {
      await db.schema
        .createTable('dataRefs')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('recordId', 'varchar(60)', (col) => col.notNull())
        .addColumn('dataCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('dataSize', 'bigint', (col) => col.notNull())
        .execute();

      // Unique constraint: one ref per (tenant, recordId, dataCid)
      await db.schema.createIndex('index_dataRefs_tenant_recordId_dataCid')
        .on('dataRefs').columns(['tenant', 'recordId', 'dataCid']).unique().execute();

      // Index for dataCid lookups (refcount queries, GC)
      await db.schema.createIndex('index_dataRefs_dataCid')
        .on('dataRefs').column('dataCid').execute();

      // Index for tenant-scoped size aggregation (admin queries)
      await db.schema.createIndex('index_dataRefs_tenant')
        .on('dataRefs').column('tenant').execute();
    }

    // ─── Create dataBlocks table ────────────────────────────────────────
    if (!(await dialect.hasTable(db, 'dataBlocks'))) {
      let table = db.schema
        .createTable('dataBlocks')
        .ifNotExists()
        .addColumn('rootDataCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('blockCid', 'varchar(60)', (col) => col.notNull());

      table = dialect.addBlobColumn(table, 'data', (col) => col.notNull());
      await table.execute();

      // Primary-like unique index on (rootDataCid, blockCid)
      await db.schema.createIndex('index_dataBlocks_rootDataCid_blockCid')
        .on('dataBlocks').columns(['rootDataCid', 'blockCid']).unique().execute();
    }

    // ─── Migrate data from old dataStore table ──────────────────────────
    const oldTableExists = await dialect.hasTable(db, 'dataStore');
    if (oldTableExists) {
      // Check if old table has any data to migrate
      const countResult = await sql`SELECT COUNT(*) as cnt FROM ${sql.table('dataStore')}`
        .execute(db);

      const count = Number((countResult.rows[0] as any)?.cnt ?? 0);
      if (count > 0) {
        // Column references must be quoted to preserve camelCase in PostgreSQL.
        const recordId = sql.ref('recordId');
        const dataCid = sql.ref('dataCid');
        const dataSize = sql.ref('dataSize');
        const rootDataCid = sql.ref('rootDataCid');
        const blockCid = sql.ref('blockCid');

        // Migrate refs: insert into dataRefs from dataStore
        // Use LENGTH/OCTET_LENGTH depending on dialect for blob size
        if (dialect.name === 'SQLite') {
          await sql`
            INSERT INTO ${sql.table('dataRefs')} (tenant, ${recordId}, ${dataCid}, ${dataSize})
            SELECT tenant, ${recordId}, ${dataCid}, LENGTH(data)
            FROM ${sql.table('dataStore')}
          `.execute(db);
        } else {
          // PostgreSQL uses OCTET_LENGTH for bytea, MySQL uses LENGTH for blob
          await sql`
            INSERT INTO ${sql.table('dataRefs')} (tenant, ${recordId}, ${dataCid}, ${dataSize})
            SELECT tenant, ${recordId}, ${dataCid}, OCTET_LENGTH(data)
            FROM ${sql.table('dataStore')}
          `.execute(db);
        }

        // Migrate blocks: treat each existing blob as a single block
        // where blockCid = dataCid (the root CID is the only block)
        // Skip duplicates: only insert blocks for dataCids not already in dataBlocks
        if (dialect.name === 'MySQL') {
          await sql`
            INSERT IGNORE INTO ${sql.table('dataBlocks')} (${rootDataCid}, ${blockCid}, data)
            SELECT ${dataCid}, ${dataCid}, data
            FROM ${sql.table('dataStore')}
          `.execute(db);
        } else if (dialect.name === 'SQLite') {
          await sql`
            INSERT OR IGNORE INTO ${sql.table('dataBlocks')} (${rootDataCid}, ${blockCid}, data)
            SELECT ${dataCid}, ${dataCid}, data
            FROM ${sql.table('dataStore')}
          `.execute(db);
        } else {
          // PostgreSQL
          await sql`
            INSERT INTO ${sql.table('dataBlocks')} (${rootDataCid}, ${blockCid}, data)
            SELECT ${dataCid}, ${dataCid}, data
            FROM ${sql.table('dataStore')}
            ON CONFLICT (${rootDataCid}, ${blockCid}) DO NOTHING
          `.execute(db);
        }
      }

      // Drop the old table after migration
      await db.schema.dropTable('dataStore').execute();
    }
  },
};
