import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { Cid } from '../../src/utils/cid.js';
import { DataStoreLevel } from '../../src/store/data-store-level.js';
import { dataBlob, recordId, tenantDid } from './arbitraries/store.arbitrary.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

/** Helper to create a ReadableStream from a Uint8Array. */
function streamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(data);
      controller.close();
    }
  });
}

/** Helper to read all bytes from a ReadableStream. */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (result.value) {
      chunks.push(result.value);
    }
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe('DataStoreLevel — fuzz', () => {
  let dataStore: DataStoreLevel;
  const testDataPath = '__TESTDATA__/fuzz-data-store';
  const tenant = 'did:example:fuzz-data-tenant';

  beforeAll(async () => {
    dataStore = new DataStoreLevel({ blockstoreLocation: `${testDataPath}/blocks` });
    await dataStore.open();
  });

  afterEach(async () => {
    await dataStore.clear();
  });

  afterAll(async () => {
    await dataStore.close();
  });

  describe('binary data roundtrip', () => {
    it('should store and retrieve arbitrary binary data with correct size', async () => {
      await fc.assert(
        fc.asyncProperty(
          dataBlob({ minSize: 1, maxSize: 2048 }),
          async (data) => {
            await dataStore.clear();

            const dataCid = await Cid.computeDagPbCidFromBytes(data);
            const recId = 'rec_roundtrip';

            const putResult = await dataStore.put(tenant, recId, dataCid, streamFrom(data));
            expect(putResult.dataSize).toBe(data.length);

            const getResult = await dataStore.get(tenant, recId, dataCid);
            expect(getResult).toBeDefined();
            expect(getResult!.dataSize).toBe(data.length);

            const retrieved = await readStream(getResult!.dataStream);
            expect(retrieved).toEqual(data);
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('get returns undefined for missing data', () => {
    it('should return undefined for non-existent records', async () => {
      await fc.assert(
        fc.asyncProperty(recordId(), async (recId) => {
          const result = await dataStore.get(tenant, recId, 'bafkreinonexistent');
          expect(result).toBeUndefined();
        }),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('idempotent put', () => {
    it('should return the same dataSize when putting the same data twice', async () => {
      await fc.assert(
        fc.asyncProperty(
          dataBlob({ minSize: 10, maxSize: 512 }),
          async (data) => {
            await dataStore.clear();

            const dataCid = await Cid.computeDagPbCidFromBytes(data);
            const recId = 'rec_idempotent';

            const result1 = await dataStore.put(tenant, recId, dataCid, streamFrom(data));
            const result2 = await dataStore.put(tenant, recId, dataCid, streamFrom(data));

            expect(result1.dataSize).toBe(result2.dataSize);
            expect(result1.dataSize).toBe(data.length);
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });

  describe('tenant isolation', () => {
    it('should not allow one tenant to read another tenant\'s data', async () => {
      await fc.assert(
        fc.asyncProperty(
          tenantDid(),
          tenantDid(),
          dataBlob({ minSize: 10, maxSize: 256 }),
          async (tenant1, tenant2, data) => {
            // Skip if tenants are the same
            if (tenant1 === tenant2) { return; }

            await dataStore.clear();

            const dataCid = await Cid.computeDagPbCidFromBytes(data);
            const recId = 'rec_isolation';

            await dataStore.put(tenant1, recId, dataCid, streamFrom(data));

            // Tenant 2 should not be able to get tenant 1's data
            const result = await dataStore.get(tenant2, recId, dataCid);
            expect(result).toBeUndefined();
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });

  describe('delete removes data', () => {
    it('should return undefined after deleting a record', async () => {
      await fc.assert(
        fc.asyncProperty(
          dataBlob({ minSize: 10, maxSize: 512 }),
          async (data) => {
            await dataStore.clear();

            const dataCid = await Cid.computeDagPbCidFromBytes(data);
            const recId = 'rec_delete';

            await dataStore.put(tenant, recId, dataCid, streamFrom(data));
            await dataStore.delete(tenant, recId, dataCid);

            const result = await dataStore.get(tenant, recId, dataCid);
            expect(result).toBeUndefined();
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });

  describe('reference counting — shared blocks survive partial deletion', () => {
    it('should retain data while at least one reference exists', async () => {
      await fc.assert(
        fc.asyncProperty(
          dataBlob({ minSize: 10, maxSize: 256 }),
          fc.integer({ min: 2, max: 4 }),
          async (data, refCount) => {
            await dataStore.clear();

            const dataCid = await Cid.computeDagPbCidFromBytes(data);

            // Create multiple references to the same data
            const refs: { tenant: string; recId: string }[] = [];
            for (let i = 0; i < refCount; i++) {
              const t = `did:example:tenant${i}`;
              const r = `rec_ref${i}`;
              await dataStore.put(t, r, dataCid, streamFrom(data));
              refs.push({ tenant: t, recId: r });
            }

            // Delete all but the last reference
            for (let i = 0; i < refCount - 1; i++) {
              await dataStore.delete(refs[i].tenant, refs[i].recId, dataCid);
            }

            // The last reference should still be retrievable
            const lastRef = refs[refCount - 1];
            const result = await dataStore.get(lastRef.tenant, lastRef.recId, dataCid);
            expect(result).toBeDefined();
            expect(result!.dataSize).toBe(data.length);

            const retrieved = await readStream(result!.dataStream);
            expect(retrieved).toEqual(data);
          }
        ),
        { numRuns: Math.min(numRuns, 15) }
      );
    });
  });
});
