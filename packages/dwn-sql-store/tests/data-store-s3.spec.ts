/* eslint-disable mocha/no-top-level-hooks -- describe.skipIf() is not recognised by eslint-plugin-mocha */
import type { DataStoreGetResult } from '@enbox/dwn-sdk-js';

import { DataStoreS3 } from '../src/data-store-s3.js';
import { getTestSqliteDialect } from './test-dialects.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Cid, DataStream, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { CreateBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// MinIO / S3 test configuration
// ---------------------------------------------------------------------------

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
const S3_BUCKET = 'dwn-test-data';
const S3_CREDENTIALS = {
  accessKeyId     : process.env.S3_ACCESS_KEY ?? 'minioadmin',
  secretAccessKey : process.env.S3_SECRET_KEY ?? 'minioadmin',
};

/**
 * Probe whether a usable S3-compatible service is reachable at {@link S3_ENDPOINT}.
 * Returns `true` when the ListBuckets call succeeds within 2 seconds.
 */
async function isS3Available(): Promise<boolean> {
  const probe = new S3Client({
    region         : 'us-east-1',
    endpoint       : S3_ENDPOINT,
    forcePathStyle : true,
    credentials    : S3_CREDENTIALS,
    requestHandler : { requestTimeout: 2_000 } as any,
  });
  try {
    await probe.send(new ListBucketsCommand({}));
    return true;
  } catch {
    return false;
  } finally {
    probe.destroy();
  }
}

const s3Available = await isS3Available();

// Wrap entire suite: the `describe.skipIf(...)` call prevents every nested
// test from registering when MinIO is unreachable, so the suite passes
// cleanly and no coverage artefacts are distorted by "store is undefined" errors.
describe.skipIf(!s3Available)('DataStoreS3', () => {
  let store: DataStoreS3;
  let s3Client: S3Client;

  beforeAll(async () => {
    s3Client = new S3Client({
      region         : 'us-east-1',
      endpoint       : S3_ENDPOINT,
      forcePathStyle : true,
      credentials    : S3_CREDENTIALS,
    });

    // Ensure the test bucket exists.
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    } catch (error: any) {
      // BucketAlreadyOwnedByYou / BucketAlreadyExists are fine.
      if (!error.name?.includes('BucketAlready')) {
        throw error;
      }
    }

    const dialect = getTestSqliteDialect();

    store = new DataStoreS3({
      dialect,
      bucket         : S3_BUCKET,
      s3Client,
      forcePathStyle : true,
    });

    await store.open();
  });

  beforeEach(async () => {
    await store.clear();
  });

  afterAll(async () => {
    await store.clear();
    await store.close();
    s3Client.destroy();
  });

  // ---------------------------------------------------------------------------
  // put + get round-trip
  // ---------------------------------------------------------------------------

  describe('put', () => {
    it('should return the correct data size after storing', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(1_000);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const { dataSize } = await store.put(tenant, recordId, dataCid, DataStream.fromBytes(dataBytes));
      expect(dataSize).toBe(1_000);

      // Round-trip: read back and verify content.
      const result = (await store.get(tenant, recordId, dataCid))!;
      expect(result).toBeDefined();
      expect(result.dataSize).toBe(1_000);

      const storedBytes = await DataStream.toBytes(result.dataStream);
      expect(storedBytes).toEqual(dataBytes);
    });

    it('should handle large data via multipart upload', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();

      // 6 MB — exceeds the default 5 MB part size to trigger multipart.
      const dataBytes = TestDataGenerator.randomBytes(6 * 1024 * 1024);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const { dataSize } = await store.put(tenant, recordId, dataCid, DataStream.fromBytes(dataBytes));
      expect(dataSize).toBe(6 * 1024 * 1024);

      const result = (await store.get(tenant, recordId, dataCid))!;
      expect(result).toBeDefined();
      const storedBytes = await DataStream.toBytes(result.dataStream);
      expect(storedBytes).toEqual(dataBytes);
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  describe('get', () => {
    it('should return undefined for a non-existent record', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();
      const dataCid = await TestDataGenerator.randomCborSha256Cid();

      const result = await store.get(tenant, recordId, dataCid);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // dedup
  // ---------------------------------------------------------------------------

  describe('dedup', () => {
    it('should deduplicate same data across tenants', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(500);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const aliceRecordId = await TestDataGenerator.randomCborSha256Cid();
      const bobRecordId = await TestDataGenerator.randomCborSha256Cid();

      await store.put(alice, aliceRecordId, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, bobRecordId, dataCid, DataStream.fromBytes(dataBytes));

      // Both tenants can read the data.
      const aliceResult = (await store.get(alice, aliceRecordId, dataCid))!;
      expect(aliceResult).toBeDefined();
      expect(await DataStream.toBytes(aliceResult.dataStream)).toEqual(dataBytes);

      const bobResult = (await store.get(bob, bobRecordId, dataCid))!;
      expect(bobResult).toBeDefined();
      expect(await DataStream.toBytes(bobResult.dataStream)).toEqual(dataBytes);
    });

    it('should be idempotent for the same (tenant, recordId, dataCid)', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(500);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const result1 = await store.put(tenant, recordId, dataCid, DataStream.fromBytes(dataBytes));
      const result2 = await store.put(tenant, recordId, dataCid, DataStream.fromBytes(dataBytes));

      expect(result1.dataSize).toBe(500);
      expect(result2.dataSize).toBe(500);

      // Only one S3 object should exist — the same one.
      const readResult = (await store.get(tenant, recordId, dataCid))!;
      expect(readResult).toBeDefined();
      expect(await DataStream.toBytes(readResult.dataStream)).toEqual(dataBytes);
    });
  });

  // ---------------------------------------------------------------------------
  // delete + GC
  // ---------------------------------------------------------------------------

  describe('delete', () => {
    it('should keep S3 object when deleting one ref but other refs remain', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(500);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const aliceRecordId = await TestDataGenerator.randomCborSha256Cid();
      const bobRecordId = await TestDataGenerator.randomCborSha256Cid();

      await store.put(alice, aliceRecordId, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, bobRecordId, dataCid, DataStream.fromBytes(dataBytes));

      // Delete alice's ref — bob should still be able to read.
      await store.delete(alice, aliceRecordId, dataCid);

      expect(await store.get(alice, aliceRecordId, dataCid)).toBeUndefined();

      const bobResult = (await store.get(bob, bobRecordId, dataCid))!;
      expect(bobResult).toBeDefined();
      expect(await DataStream.toBytes(bobResult.dataStream)).toEqual(dataBytes);
    });

    it('should garbage-collect S3 object when last ref is deleted', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(500);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const aliceRecordId = await TestDataGenerator.randomCborSha256Cid();
      const bobRecordId = await TestDataGenerator.randomCborSha256Cid();

      await store.put(alice, aliceRecordId, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, bobRecordId, dataCid, DataStream.fromBytes(dataBytes));

      await store.delete(alice, aliceRecordId, dataCid);
      await store.delete(bob, bobRecordId, dataCid);

      // Both refs gone — S3 object should be deleted.
      expect(await store.get(alice, aliceRecordId, dataCid)).toBeUndefined();
      expect(await store.get(bob, bobRecordId, dataCid)).toBeUndefined();

      // A new put for the same dataCid should have to re-upload (not find an existing ref).
      const newTenant = await TestDataGenerator.randomCborSha256Cid();
      const newRecordId = await TestDataGenerator.randomCborSha256Cid();
      const result = await store.put(newTenant, newRecordId, dataCid, DataStream.fromBytes(dataBytes));
      expect(result.dataSize).toBe(500);
    });

    it('should be a no-op when deleting a non-existent ref', async () => {
      // Should not throw.
      await store.delete('did:key:nonexistent', 'no-record', 'no-cid');
    });

    it('should only delete the specified ref without affecting other records', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(500);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const recordId1 = await TestDataGenerator.randomCborSha256Cid();
      const recordId2 = await TestDataGenerator.randomCborSha256Cid();
      const recordId3 = await TestDataGenerator.randomCborSha256Cid();
      const recordId4 = await TestDataGenerator.randomCborSha256Cid();

      await store.put(alice, recordId1, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(alice, recordId2, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, recordId3, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, recordId4, dataCid, DataStream.fromBytes(dataBytes));

      // Delete one at a time, verifying others remain.
      await store.delete(alice, recordId1, dataCid);
      expect(await store.get(alice, recordId1, dataCid)).toBeUndefined();
      expect(await store.get(alice, recordId2, dataCid)).toBeDefined();
      expect(await store.get(bob, recordId3, dataCid)).toBeDefined();
      expect(await store.get(bob, recordId4, dataCid)).toBeDefined();

      // Consume remaining streams to avoid leaks.
      await DataStream.toBytes((await store.get(alice, recordId2, dataCid) as DataStoreGetResult).dataStream);
      await DataStream.toBytes((await store.get(bob, recordId3, dataCid) as DataStoreGetResult).dataStream);
      await DataStream.toBytes((await store.get(bob, recordId4, dataCid) as DataStoreGetResult).dataStream);
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe('clear', () => {
    it('should remove all refs and S3 objects', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();

      // Store two different pieces of data.
      const data1 = TestDataGenerator.randomBytes(100);
      const data2 = TestDataGenerator.randomBytes(200);
      const cid1 = await Cid.computeDagPbCidFromBytes(data1);
      const cid2 = await Cid.computeDagPbCidFromBytes(data2);
      const rec1 = await TestDataGenerator.randomCborSha256Cid();
      const rec2 = await TestDataGenerator.randomCborSha256Cid();

      await store.put(tenant, rec1, cid1, DataStream.fromBytes(data1));
      await store.put(tenant, rec2, cid2, DataStream.fromBytes(data2));

      await store.clear();

      expect(await store.get(tenant, rec1, cid1)).toBeUndefined();
      expect(await store.get(tenant, rec2, cid2)).toBeUndefined();
    });
  });
});
