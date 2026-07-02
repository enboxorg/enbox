import type { ImportResult } from 'ipfs-unixfs-importer';
import type { LevelWrapper } from './level-wrapper.js';
import type { DataStore, DataStoreGetResult, DataStorePutResult } from '../types/data-store.js';

import { BlockstoreLevel } from './blockstore-level.js';
import { createLevelDatabase } from './level-wrapper.js';
import { DataStream } from '../utils/data-stream.js';
import { exporter } from 'ipfs-unixfs-exporter';
import { importer } from 'ipfs-unixfs-importer';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * A simple implementation of {@link DataStore} that works in both the browser and server-side.
 * Leverages LevelDB under the hood.
 *
 * It has the following sublevel structure (`+` represents an additional sublevel):
 *   'refs'      + <tenant> + <recordId>  : key <dataCid>  → JSON { dataSize }
 *   'blocks'    + <dataCid>              : key <blockCid>  → block data (shared)
 *   'refcounts' : key <dataCid>                            → JSON { count, dataSize }
 *
 * Identical data (same dataCid) is stored only once in the blocks sublevel.
 * Multiple (tenant, recordId) pairs can reference the same blocks.
 */
export class DataStoreLevel implements DataStore {
  config: DataStoreLevelConfig;

  blockstore: BlockstoreLevel;

  constructor(config: DataStoreLevelConfig = {}) {
    this.config = {
      blockstoreLocation: 'DATASTORE',
      createLevelDatabase,
      ...config
    };

    this.blockstore = new BlockstoreLevel({
      location            : this.config.blockstoreLocation!,
      createLevelDatabase : this.config.createLevelDatabase,
    });
  }

  public async open(): Promise<void> {
    await this.blockstore.open();
  }

  async close(): Promise<void> {
    await this.blockstore.close();
  }

  async put(tenant: string, recordId: string, dataCid: string, dataStream: ReadableStream<Uint8Array>): Promise<DataStorePutResult> {
    // Check if this exact ref already exists (idempotent re-put).
    const refsPartition = await this.getRefsPartition(tenant, recordId);
    const existingRef = await refsPartition.get(dataCid);
    if (existingRef) {
      await dataStream.cancel();
      const { dataSize } = JSON.parse(textDecoder.decode(existingRef)) as { dataSize: number };
      return { dataSize };
    }

    // Check refcount — if > 0, blocks already exist for this dataCid.
    const refcountsPartition = await this.getRefcountsPartition();
    const rawRefcount = await refcountsPartition.get(dataCid);
    const refcountData = rawRefcount
      ? JSON.parse(textDecoder.decode(rawRefcount)) as { count: number; dataSize: number }
      : { count: 0, dataSize: 0 };

    let dataSize: number;

    if (refcountData.count > 0) {
      // Blocks already exist — skip import.
      await dataStream.cancel();
      dataSize = refcountData.dataSize;
    } else {
      // First write — import blocks into the shared blocks partition.
      const blocksPartition = await this.getBlocksPartition(dataCid);
      const asyncDataBlocks = importer(
        [{ content: DataStream.asAsyncIterable(dataStream) }],
        blocksPartition,
        { cidVersion: 1 }
      );

      // NOTE: the last block contains the root CID as well as info to derive the data size.
      let dataDagRoot!: ImportResult;
      for await (dataDagRoot of asyncDataBlocks) { ; }
      dataSize = Number(dataDagRoot.unixfs?.fileSize() ?? dataDagRoot.size);
    }

    // Write ref entry.
    await refsPartition.put(dataCid, textEncoder.encode(JSON.stringify({ dataSize })));

    // Increment refcount.
    await refcountsPartition.put(dataCid, textEncoder.encode(JSON.stringify({
      count: refcountData.count + 1,
      dataSize,
    })));

    return { dataSize };
  }

  public async get(tenant: string, recordId: string, dataCid: string): Promise<DataStoreGetResult | undefined> {
    // Check ref exists.
    const refsPartition = await this.getRefsPartition(tenant, recordId);
    const rawRef = await refsPartition.get(dataCid);
    if (!rawRef) {
      return undefined;
    }

    const { dataSize } = JSON.parse(textDecoder.decode(rawRef)) as { dataSize: number };

    // Export from the shared blocks partition.
    const blocksPartition = await this.getBlocksPartition(dataCid);
    const exists = await blocksPartition.has(dataCid);
    if (!exists) {
      return undefined;
    }

    // Data is chunked into DAG-PB UnixFS blocks. Re-inflate the chunks.
    const dataDagRoot = await exporter(dataCid, blocksPartition);
    if (dataDagRoot.type !== 'file' && dataDagRoot.type !== 'raw' && dataDagRoot.type !== 'identity') {
      throw new Error(`DataStoreLevel: Expected UnixFS file content for '${dataCid}', got '${dataDagRoot.type}'.`);
    }

    const contentIterator = dataDagRoot.content();

    const dataStream = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        const result = await contentIterator.next();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      }
    });

    return { dataSize, dataStream };
  }

  public async delete(tenant: string, recordId: string, dataCid: string): Promise<void> {
    // Check ref exists.
    const refsPartition = await this.getRefsPartition(tenant, recordId);
    const rawRef = await refsPartition.get(dataCid);
    if (!rawRef) {
      return;
    }

    // Remove ref.
    await refsPartition.delete(dataCid);

    // Decrement refcount and GC blocks if this was the last ref.
    const refcountsPartition = await this.getRefcountsPartition();
    const rawRefcount = await refcountsPartition.get(dataCid);
    if (!rawRefcount) {
      return;
    }

    const refcountData = JSON.parse(textDecoder.decode(rawRefcount)) as { count: number; dataSize: number };
    const newCount = refcountData.count - 1;

    if (newCount <= 0) {
      // Last reference removed — garbage-collect blocks and refcount entry.
      const blocksPartition = await this.getBlocksPartition(dataCid);
      await blocksPartition.clear();
      await refcountsPartition.delete(dataCid);
    } else {
      // Other references remain — update the count.
      await refcountsPartition.put(dataCid, textEncoder.encode(JSON.stringify({
        count    : newCount,
        dataSize : refcountData.dataSize,
      })));
    }
  }

  /**
   * Deletes everything in the store. Mainly used in tests.
   */
  public async clear(): Promise<void> {
    await this.blockstore.clear();
  }

  /**
   * Gets the refs sublevel for the given tenant and recordId.
   * Caller uses `dataCid` as the key within the returned partition.
   */
  private async getRefsPartition(tenant: string, recordId: string): Promise<LevelWrapper<Uint8Array>> {
    const refsRoot = await this.blockstore.db.partition('refs');
    const tenantPartition = await refsRoot.partition(tenant);
    return tenantPartition.partition(recordId);
  }

  /**
   * Gets the shared blocks sublevel for the given dataCid.
   * Used as a Blockstore for ipfs-unixfs-importer/exporter.
   */
  private async getBlocksPartition(dataCid: string): Promise<BlockstoreLevel> {
    const blocksRoot = await this.blockstore.partition('blocks');
    return blocksRoot.partition(dataCid);
  }

  /**
   * Gets the refcounts sublevel.
   * Key: `dataCid` → JSON `{ count, dataSize }`.
   */
  private async getRefcountsPartition(): Promise<LevelWrapper<Uint8Array>> {
    return this.blockstore.db.partition('refcounts');
  }

}

export type DataStoreLevelConfig = {
  blockstoreLocation?: string,
  createLevelDatabase?: typeof createLevelDatabase,
};
