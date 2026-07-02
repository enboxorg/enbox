import * as Block from 'multiformats/block';
import * as Raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

import { BlockstoreLevel } from '../../src/store/blockstore-level.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

let testCounter = 0;
function uniqueLocation(): string {
  return `TEST-BLOCKSTORE-LEVEL-${Date.now()}-${testCounter++}`;
}

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

describe('BlockstoreLevel', () => {
  let blockstore: BlockstoreLevel;

  beforeEach(async () => {
    blockstore = new BlockstoreLevel({ location: uniqueLocation() });
    await blockstore.open();
  });

  afterEach(async () => {
    await blockstore.clear();
    await blockstore.close();
  });

  it('should report isEmpty correctly', async () => {
    expect(await blockstore.isEmpty()).toBe(true);

    const block1 = await Block.encode({ value: new TextEncoder().encode('test'), codec: Raw, hasher: sha256 });
    await blockstore.put(block1.cid, block1.bytes);

    expect(await blockstore.isEmpty()).toBe(false);
  });

  it('should put and get blocks', async () => {
    const block1 = await Block.encode({ value: new TextEncoder().encode('hello'), codec: Raw, hasher: sha256 });
    await blockstore.put(block1.cid, block1.bytes);

    const result = await collectBytes(blockstore.get(block1.cid));
    expect(result).toEqual(block1.bytes);
  });

  it('should putMany blocks', async () => {
    const block1 = await Block.encode({ value: new TextEncoder().encode('put1'), codec: Raw, hasher: sha256 });
    const block2 = await Block.encode({ value: new TextEncoder().encode('put2'), codec: Raw, hasher: sha256 });
    const source = [
      { cid: block1.cid, bytes: block1.bytes },
      { cid: block2.cid, bytes: block2.bytes },
    ];

    const results = [];
    for await (const cid of blockstore.putMany(source)) {
      results.push(cid);
    }

    expect(results).toHaveLength(2);
    expect(await blockstore.has(block1.cid)).toBe(true);
    expect(await blockstore.has(block2.cid)).toBe(true);
  });

  it('should getMany blocks', async () => {
    const block1 = await Block.encode({ value: new TextEncoder().encode('get1'), codec: Raw, hasher: sha256 });
    const block2 = await Block.encode({ value: new TextEncoder().encode('get2'), codec: Raw, hasher: sha256 });
    await blockstore.put(block1.cid, block1.bytes);
    await blockstore.put(block2.cid, block2.bytes);

    const results = [];
    for await (const pair of blockstore.getMany([block1.cid, block2.cid])) {
      results.push(pair);
    }

    expect(results).toHaveLength(2);
    expect(results[0].cid.toString()).toBe(block1.cid.toString());
    expect(await collectBytes(results[0].bytes)).toEqual(block1.bytes);
    expect(results[1].cid.toString()).toBe(block2.cid.toString());
    expect(await collectBytes(results[1].bytes)).toEqual(block2.bytes);
  });

  // NOTE: getAll() is not tested because it assumes keys are binary-encoded CIDs
  // (via keyEncoding: 'buffer' + CID.decode), but put() stores keys as String(cid).
  // This mismatch means getAll() would fail with "Invalid CID version" when decoding
  // the string bytes. This appears to be a pre-existing bug in the codebase — getAll()
  // is never called by any production code.

  it('should deleteMany blocks', async () => {
    const block1 = await Block.encode({ value: new TextEncoder().encode('del1'), codec: Raw, hasher: sha256 });
    const block2 = await Block.encode({ value: new TextEncoder().encode('del2'), codec: Raw, hasher: sha256 });
    await blockstore.put(block1.cid, block1.bytes);
    await blockstore.put(block2.cid, block2.bytes);

    const deleted = [];
    for await (const cid of blockstore.deleteMany([block1.cid, block2.cid])) {
      deleted.push(cid);
    }

    expect(deleted).toHaveLength(2);
    expect(await blockstore.has(block1.cid)).toBe(false);
    expect(await blockstore.has(block2.cid)).toBe(false);
  });
});
