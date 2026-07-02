import * as Block from 'multiformats/block';
import * as Raw from 'multiformats/codecs/raw';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

import { BlockstoreMock } from '../../src/store/blockstore-mock.js';
import { DataStream } from '../../src/index.js';
import { importer } from 'ipfs-unixfs-importer';
import { MemoryBlockstore } from 'blockstore-core';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { beforeEach, describe, expect, it } from 'bun:test';

async function collectBytes(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

describe('BlockstoreMock', () => {
  let blockstore: BlockstoreMock;

  beforeEach(() => {
    blockstore = new BlockstoreMock();
  });

  it('should implement open and close methods', async () => {
    await blockstore.open();
    await blockstore.close();
  });

  it('should facilitate the same CID computation as other implementations', async () => {

    let dataSizeInBytes = 10;

    // iterate through order of magnitude in size until hitting 10MB
    // to ensure that the same CID is computed for the same data with the MockBlockstore as with the MemoryBlockstore
    while (dataSizeInBytes <= 10_000_000) {
      const dataBytes = TestDataGenerator.randomBytes(dataSizeInBytes);
      const dataStreamForMemoryBlockstore = DataStream.fromBytes(dataBytes);
      const dataStreamForMockBlockstore = DataStream.fromBytes(dataBytes);

      const asyncDataBlocksByMemoryBlockstore = importer(
        [{ content: DataStream.asAsyncIterable(dataStreamForMemoryBlockstore) }], new MemoryBlockstore(), { cidVersion: 1 }
      );
      const asyncDataBlocksByMockBlockstore = importer(
        [{ content: DataStream.asAsyncIterable(dataStreamForMockBlockstore) }], new BlockstoreMock(), { cidVersion: 1 }
      );

      // NOTE: the last block contains the root CID
      let blockByMemoryBlockstore;
      for await (blockByMemoryBlockstore of asyncDataBlocksByMemoryBlockstore) { ; }
      const dataCidByMemoryBlockstore = blockByMemoryBlockstore ? blockByMemoryBlockstore.cid.toString() : '';

      let blockByMockBlockstore;
      for await (blockByMockBlockstore of asyncDataBlocksByMockBlockstore) { ; }
      const dataCidByMockBlockstore = blockByMockBlockstore ? blockByMockBlockstore.cid.toString() : '';

      expect(dataCidByMockBlockstore).toBeDefined();
      expect(dataCidByMockBlockstore.length).toBeGreaterThan(0);
      expect(dataCidByMockBlockstore).toBe(dataCidByMemoryBlockstore);

      dataSizeInBytes *= 10;
    }
  });

  it('should implement get method', async () => {
    const cid = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    const result = await collectBytes(blockstore.get(cid));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it('should implement has method', async () => {
    const cid = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    const result = await blockstore.has(cid);
    expect(result).toBe(false);
  });

  it('should implement delete method', async () => {
    const cid = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    await blockstore.delete(cid);
  });

  it('should implement isEmpty method', async () => {
    const result = await blockstore.isEmpty();
    expect(result).toBe(true);
  });

  it('should implement putMany method', async () => {
    const block1 = await Block.encode({ value: new TextEncoder().encode('test1'), codec: Raw, hasher: sha256 });
    const block2 = await Block.encode({ value: new TextEncoder().encode('test2'), codec: Raw, hasher: sha256 });
    const source = [
      { cid: block1.cid, bytes: block1.bytes },
      { cid: block2.cid, bytes: block2.bytes }
    ];

    const results = [];
    for await (const cid of blockstore.putMany(source)) {
      results.push(cid);
    }

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(block1.cid);
    expect(results[1]).toEqual(block2.cid);
  });

  it('should implement getMany method', async () => {
    const cid1 = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    const cid2 = CID.parse('bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4');
    const source = [cid1, cid2];

    const results = [];
    for await (const pair of blockstore.getMany(source)) {
      results.push(pair);
    }

    expect(results).toHaveLength(2);
    expect(results[0].cid).toEqual(cid1);
    const bytes1 = await collectBytes(results[0].bytes);
    expect(bytes1).toBeInstanceOf(Uint8Array);
    expect(bytes1.length).toBe(0);
    expect(results[1].cid).toEqual(cid2);
    const bytes2 = await collectBytes(results[1].bytes);
    expect(bytes2).toBeInstanceOf(Uint8Array);
    expect(bytes2.length).toBe(0);
  });

  it('should implement deleteMany method', async () => {
    const cid1 = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    const cid2 = CID.parse('bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4');
    const source = [cid1, cid2];

    const results = [];
    for await (const cid of blockstore.deleteMany(source)) {
      results.push(cid);
    }

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(cid1);
    expect(results[1]).toEqual(cid2);
  });

  it('should implement clear method', async () => {
    await blockstore.clear();
  });

});
