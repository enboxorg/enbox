import type { DwnDatabaseType } from './types.js';
import type { Kysely } from 'kysely';
import type { Blockstore, InputPair, Pair } from 'interface-blockstore';

import { CID } from 'multiformats';
import { isDuplicateKeyError } from './utils/duplicate-key-error.js';

type AbortOptions = { signal?: AbortSignal };
type BlockstoreInput = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
type BlockstoreSource<T> = Iterable<T> | AsyncIterable<T>;

async function collectBytes(input: BlockstoreInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return input;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of input) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function* yieldBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * SQL-backed implementation of the `Blockstore` v5 interface, scoped to a
 * single `rootDataCid`. All block operations are constrained to the blocks
 * belonging to this root CID in the `dataBlocks` table.
 *
 * Used by `ipfs-unixfs-importer` (during `put()`) and `ipfs-unixfs-exporter`
 * (during `get()`) to store and retrieve individual DAG-PB blocks.
 *
 * The Kysely instance and database connection are managed externally by
 * `DataStoreSql`. This class does not own the connection lifecycle.
 */
export class BlockstoreSql implements Blockstore {
  readonly #db: Kysely<DwnDatabaseType>;
  readonly #rootDataCid: string;

  constructor(db: Kysely<DwnDatabaseType>, rootDataCid: string) {
    this.#db = db;
    this.#rootDataCid = rootDataCid;
  }

  public async open(): Promise<void> {
    // No-op: connection managed by DataStoreSql.
  }

  public async close(): Promise<void> {
    // No-op: connection managed by DataStoreSql.
  }

  public async put(key: CID, val: BlockstoreInput, _options?: AbortOptions): Promise<CID> {
    const blockCid = key.toString();
    const bytes = await collectBytes(val);

    try {
      await this.#db
        .insertInto('dataBlocks')
        .values({
          rootDataCid : this.#rootDataCid,
          blockCid,
          data        : Buffer.from(bytes),
        })
        .execute();
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      // Idempotent block put: overlapping writes of the same dataCid can
      // import the same content-addressed block concurrently.
    }

    return key;
  }

  public async * get(key: CID, _options?: AbortOptions): AsyncGenerator<Uint8Array> {
    const result = await this.#db
      .selectFrom('dataBlocks')
      .select('data')
      .where('rootDataCid', '=', this.#rootDataCid)
      .where('blockCid', '=', key.toString())
      .executeTakeFirst();

    if (!result) {
      throw new Error(`BlockstoreSql: block not found for rootDataCid=${this.#rootDataCid}, blockCid=${key}`);
    }

    yield new Uint8Array(result.data);
  }

  public async has(key: CID, _options?: AbortOptions): Promise<boolean> {
    const result = await this.#db
      .selectFrom('dataBlocks')
      .select('blockCid')
      .where('rootDataCid', '=', this.#rootDataCid)
      .where('blockCid', '=', key.toString())
      .executeTakeFirst();

    return result !== undefined;
  }

  public async delete(key: CID, _options?: AbortOptions): Promise<void> {
    await this.#db
      .deleteFrom('dataBlocks')
      .where('rootDataCid', '=', this.#rootDataCid)
      .where('blockCid', '=', key.toString())
      .execute();
  }

  public async isEmpty(_options?: AbortOptions): Promise<boolean> {
    const result = await this.#db
      .selectFrom('dataBlocks')
      .select('blockCid')
      .where('rootDataCid', '=', this.#rootDataCid)
      .executeTakeFirst();

    return result === undefined;
  }

  public async * putMany(source: BlockstoreSource<InputPair>, options?: AbortOptions): AsyncGenerator<CID> {
    for await (const entry of source) {
      await this.put(entry.cid, entry.bytes, options);
      yield entry.cid;
    }
  }

  public async * getMany(source: BlockstoreSource<CID>, options?: AbortOptions): AsyncGenerator<Pair> {
    for await (const key of source) {
      yield {
        cid   : key,
        bytes : this.get(key, options),
      };
    }
  }

  public async * getAll(_options?: AbortOptions): AsyncGenerator<Pair> {
    const rows = await this.#db
      .selectFrom('dataBlocks')
      .select(['blockCid', 'data'])
      .where('rootDataCid', '=', this.#rootDataCid)
      .execute();

    for (const row of rows) {
      yield {
        cid   : CID.parse(row.blockCid),
        bytes : yieldBytes(new Uint8Array(row.data)),
      };
    }
  }

  public async * deleteMany(source: BlockstoreSource<CID>, options?: AbortOptions): AsyncGenerator<CID> {
    for await (const key of source) {
      await this.delete(key, options);
      yield key;
    }
  }

  /**
   * Deletes all blocks for this rootDataCid.
   */
  public async clear(): Promise<void> {
    await this.#db
      .deleteFrom('dataBlocks')
      .where('rootDataCid', '=', this.#rootDataCid)
      .execute();
  }
}
