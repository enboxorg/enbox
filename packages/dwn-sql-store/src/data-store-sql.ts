import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType } from './types.js';
import type { ImportResult } from 'ipfs-unixfs-importer';
import type { DataStore, DataStoreGetResult, DataStorePutResult } from '@enbox/dwn-sdk-js';

import { BlockstoreSql } from './blockstore-sql.js';
import { CID } from 'multiformats';
import { DataStream } from '@enbox/dwn-sdk-js';
import { exporter } from 'ipfs-unixfs-exporter';
import { importer } from 'ipfs-unixfs-importer';
import { isDuplicateKeyError } from './utils/duplicate-key-error.js';
import { Kysely, sql } from 'kysely';

/**
 * SQL-backed implementation of {@link DataStore} with content-addressed
 * deduplication.
 *
 * Data is stored as DAG-PB blocks (via `ipfs-unixfs-importer`) in the
 * `dataBlocks` table, keyed by `(rootDataCid, blockCid)`. A separate
 * `dataRefs` table maps `(tenant, recordId, dataCid)` to content. When
 * multiple records share the same `dataCid`, blocks are stored only once.
 *
 * On `delete()`, the ref is removed and blocks are garbage-collected only
 * when the last ref to a `dataCid` is gone.
 */
export class DataStoreSql implements DataStore {
  readonly #dialect: Dialect;
  #db: Kysely<DwnDatabaseType> | null = null;

  constructor(dialect: Dialect) {
    this.#dialect = dialect;
  }

  public async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new Kysely<DwnDatabaseType>({ dialect: this.#dialect });

    // Fail fast if migrations have not been run — tables must already exist.
    await this.#assertTablesExist();
  }

  public async close(): Promise<void> {
    await this.#db?.destroy();
    this.#db = null;
  }

  public async get(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<DataStoreGetResult | undefined> {
    const db = this.#getDb('get');

    // Look up the reference to confirm this tenant+record has this data.
    const ref = await db
      .selectFrom('dataRefs')
      .select('dataSize')
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    if (!ref) {
      return undefined;
    }

    const blockstore = new BlockstoreSql(db, dataCid);

    // Use ipfs-unixfs-exporter to stream data from DAG-PB blocks.
    const dataDagRoot = await exporter(dataCid, blockstore);
    const contentIterator = dataDagRoot.content();

    const dataStream = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        const result = await contentIterator.next();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      },
    });

    return {
      dataSize: Number(ref.dataSize),
      dataStream,
    };
  }

  public async put(
    tenant: string,
    recordId: string,
    dataCid: string,
    dataStream: ReadableStream<Uint8Array>,
  ): Promise<DataStorePutResult> {
    const db = this.#getDb('put');

    // Check if this exact ref already exists (idempotent put).
    const existingRef = await db
      .selectFrom('dataRefs')
      .select('dataSize')
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    if (existingRef) {
      // Drain the stream — caller expects it to be consumed.
      await DataStream.toBytes(dataStream);
      return { dataSize: Number(existingRef.dataSize) };
    }

    // Check if blocks for this dataCid already exist (dedup path).
    const blockstore = new BlockstoreSql(db, dataCid);
    const rootCid = CID.parse(dataCid);
    const blocksExist = await blockstore.has(rootCid);

    let dataSize: number;

    if (blocksExist) {
      // Blocks already stored by a previous ref with the same dataCid.
      // Get the data size from that existing ref.
      const otherRef = await db
        .selectFrom('dataRefs')
        .select('dataSize')
        .where('dataCid', '=', dataCid)
        .executeTakeFirst();

      if (otherRef) {
        dataSize = Number(otherRef.dataSize);
        // Drain the stream — caller expects it to be consumed.
        await DataStream.toBytes(dataStream);
      } else {
        // Edge case: blocks exist but no ref (interrupted previous put).
        // Count bytes without full buffering.
        dataSize = await DataStoreSql.#countStreamBytes(dataStream);
      }
    } else {
      // New data — clean up any partial blocks from interrupted imports,
      // then chunk the data into DAG-PB blocks via the importer.
      await blockstore.clear();

      const asyncDataBlocks = importer(
        [{ content: DataStream.asAsyncIterable(dataStream) }],
        blockstore,
        { cidVersion: 1 },
      );

      // The last block yielded contains the root CID and file size info.
      let dataDagRoot!: ImportResult;
      for await (dataDagRoot of asyncDataBlocks) { ; }

      dataSize = Number(dataDagRoot.unixfs?.fileSize() ?? dataDagRoot.size);
    }

    // Insert the reference. If an overlapping identical write inserted the
    // ref first, treat it as an idempotent put and return the stored size.
    try {
      await db
        .insertInto('dataRefs')
        .values({ tenant, recordId, dataCid, dataSize })
        .execute();
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const racedRef = await db
        .selectFrom('dataRefs')
        .select('dataSize')
        .where('tenant', '=', tenant)
        .where('recordId', '=', recordId)
        .where('dataCid', '=', dataCid)
        .executeTakeFirst();

      if (!racedRef) {
        throw error;
      }

      dataSize = Number(racedRef.dataSize);
    }

    return { dataSize };
  }

  public async delete(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<void> {
    const db = this.#getDb('delete');

    // Remove the reference.
    await db
      .deleteFrom('dataRefs')
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .execute();

    // Garbage-collect blocks if no more refs point to this dataCid.
    const remaining = await db
      .selectFrom('dataRefs')
      .select('dataCid')
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    if (!remaining) {
      await db
        .deleteFrom('dataBlocks')
        .where('rootDataCid', '=', dataCid)
        .execute();
    }
  }

  public async clear(): Promise<void> {
    const db = this.#getDb('clear');

    await db.deleteFrom('dataRefs').execute();
    await db.deleteFrom('dataBlocks').execute();
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Returns the open database instance, or throws if not yet opened.
   */
  #getDb(method: string): Kysely<DwnDatabaseType> {
    if (!this.#db) {
      throw new Error(
        `Connection to database not open. Call \`open\` before using \`${method}\`.`
      );
    }
    return this.#db;
  }

  /**
   * Verifies that the required tables exist by executing a zero-row SELECT.
   * Throws a clear error directing the caller to run migrations first.
   */
  async #assertTablesExist(): Promise<void> {
    const tables = ['dataRefs', 'dataBlocks'] as const;
    for (const table of tables) {
      try {
        await sql`SELECT 1 FROM ${sql.table(table)} LIMIT 0`.execute(this.#db!);
      } catch {
        throw new Error(
          `DataStoreSql: table '${table}' does not exist. Run DWN store migrations before opening stores.`
        );
      }
    }
  }

  /**
   * Counts the number of bytes in a stream without buffering the full content.
   */
  static async #countStreamBytes(stream: ReadableStream<Uint8Array>): Promise<number> {
    const reader = stream.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
    }
    return size;
  }
}
