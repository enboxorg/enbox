import type { BlockstoreAbortOptions, BlockstoreInput } from '../../src/store/blockstore-utils.js';

import { CID } from 'multiformats/cid';
import { describe, expect, it } from 'bun:test';

import {
  collectBlockstoreBytes,
  deleteManyBlockstoreItems,
  getManyBlockstoreItems,
  putManyBlockstoreItems,
  yieldBlockstoreBytes,
} from '../../src/store/blockstore-utils.js';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const entry of source) {
    results.push(entry);
  }

  return results;
}

async function* asyncSource<T>(entries: T[]): AsyncGenerator<T> {
  for (const entry of entries) {
    yield entry;
  }
}

describe('blockstore-utils', () => {
  describe('collectBlockstoreBytes()', () => {
    it('should return Uint8Array inputs directly', async () => {
      const bytes = new Uint8Array([1, 2, 3]);

      const result = await collectBlockstoreBytes(bytes);

      expect(result).toBe(bytes);
    });

    it('should return single iterable chunk inputs directly', async () => {
      const chunk = new Uint8Array([4, 5, 6]);

      const result = await collectBlockstoreBytes([chunk]);

      expect(result).toBe(chunk);
    });

    it('should concatenate multi-chunk async iterable inputs', async () => {
      const result = await collectBlockstoreBytes(asyncSource([
        new Uint8Array([1, 2]),
        new Uint8Array([3]),
        new Uint8Array([4, 5]),
      ]));

      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it('should return empty bytes for empty iterable inputs', async () => {
      const result = await collectBlockstoreBytes([]);

      expect(result).toEqual(new Uint8Array());
    });
  });

  describe('yieldBlockstoreBytes()', () => {
    it('should yield the supplied bytes', async () => {
      const bytes = new Uint8Array([7, 8, 9]);

      const result = await collect(yieldBlockstoreBytes(bytes));

      expect(result).toEqual([bytes]);
    });
  });

  describe('putManyBlockstoreItems()', () => {
    it('should put each source entry and yield each CID', async () => {
      const cid1 = CID.parse('bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4');
      const cid2 = CID.parse('bafkreidbkxwaqpz3uhsdvsgroxtlal5goeidgv55vtagm3mohxbia3r77y');
      const bytes1 = new Uint8Array([1]);
      const bytes2 = new Uint8Array([2]);
      const options: BlockstoreAbortOptions = { signal: new AbortController().signal };
      const calls: Array<{ cid: string; bytes: BlockstoreInput; options?: BlockstoreAbortOptions }> = [];
      const blockstore = {
        put: async (cid: CID, bytes: BlockstoreInput, putOptions?: BlockstoreAbortOptions): Promise<CID> => {
          calls.push({ cid: cid.toString(), bytes, options: putOptions });
          return cid;
        },
      };

      const result = await collect(putManyBlockstoreItems(blockstore, asyncSource([
        { cid: cid1, bytes: bytes1 },
        { cid: cid2, bytes: bytes2 },
      ]), options));

      expect(result.map((cid: CID): string => cid.toString())).toEqual([cid1.toString(), cid2.toString()]);
      expect(calls).toEqual([
        { cid: cid1.toString(), bytes: bytes1, options },
        { cid: cid2.toString(), bytes: bytes2, options },
      ]);
    });
  });

  describe('getManyBlockstoreItems()', () => {
    it('should yield pairs backed by delegate get generators', async () => {
      const cid1 = CID.parse('bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4');
      const cid2 = CID.parse('bafkreidbkxwaqpz3uhsdvsgroxtlal5goeidgv55vtagm3mohxbia3r77y');
      const options: BlockstoreAbortOptions = { signal: new AbortController().signal };
      const calls: Array<{ cid: string; options?: BlockstoreAbortOptions }> = [];
      const blockstore = {
        get: (cid: CID, getOptions?: BlockstoreAbortOptions): AsyncGenerator<Uint8Array> => {
          calls.push({ cid: cid.toString(), options: getOptions });
          return yieldBlockstoreBytes(new Uint8Array([cid.equals(cid1) ? 1 : 2]));
        },
      };

      const result = await collect(getManyBlockstoreItems(blockstore, asyncSource([cid1, cid2]), options));

      expect(result.map((pair): string => pair.cid.toString())).toEqual([cid1.toString(), cid2.toString()]);
      expect(await collectBlockstoreBytes(result[0].bytes)).toEqual(new Uint8Array([1]));
      expect(await collectBlockstoreBytes(result[1].bytes)).toEqual(new Uint8Array([2]));
      expect(calls).toEqual([
        { cid: cid1.toString(), options },
        { cid: cid2.toString(), options },
      ]);
    });
  });

  describe('deleteManyBlockstoreItems()', () => {
    it('should delete each source CID and yield each CID', async () => {
      const cid1 = CID.parse('bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4');
      const cid2 = CID.parse('bafkreidbkxwaqpz3uhsdvsgroxtlal5goeidgv55vtagm3mohxbia3r77y');
      const options: BlockstoreAbortOptions = { signal: new AbortController().signal };
      const calls: Array<{ cid: string; options?: BlockstoreAbortOptions }> = [];
      const blockstore = {
        delete: async (cid: CID, deleteOptions?: BlockstoreAbortOptions): Promise<void> => {
          calls.push({ cid: cid.toString(), options: deleteOptions });
        },
      };

      const result = await collect(deleteManyBlockstoreItems(blockstore, asyncSource([cid1, cid2]), options));

      expect(result.map((cid: CID): string => cid.toString())).toEqual([cid1.toString(), cid2.toString()]);
      expect(calls).toEqual([
        { cid: cid1.toString(), options },
        { cid: cid2.toString(), options },
      ]);
    });
  });
});
