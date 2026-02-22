import { ArrayUtility } from '../../src/utils/array.js';
import { Cid } from '../../src/utils/cid.js';
import { DataStoreLevel } from '../../src/store/data-store-level.js';
import { DataStream } from '../../src/index.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

let store: DataStoreLevel;

describe('DataStoreLevel Test Suite', () => {
  beforeAll(async () => {
    store = new DataStoreLevel({ blockstoreLocation: 'TEST-DATASTORE' });
    await store.open();
  });

  beforeEach(async () => {
    await store.clear(); // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
  });

  afterAll(async () => {
    await store.close();
  });

  describe('put', function () {
    it('should return the correct size of the data stored', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();

      let dataSizeInBytes = 10;

      // iterate through order of magnitude in size until hitting 10MB
      while (dataSizeInBytes <= 10_000_000) {
        const dataBytes = TestDataGenerator.randomBytes(dataSizeInBytes);
        const dataStream = DataStream.fromBytes(dataBytes);
        const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

        const { dataSize } = await store.put(tenant, recordId, dataCid, dataStream);

        expect(dataSize).toBe(dataSizeInBytes);

        const result = (await store.get(tenant, recordId, dataCid))!;
        const storedDataBytes = await DataStream.toBytes(result.dataStream);

        expect(storedDataBytes).toEqual(dataBytes);

        dataSizeInBytes *= 10;
      }
    });

    it('should deduplicate same data across tenants', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(100);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      // write data to alice's DWN
      const aliceRecordId = await TestDataGenerator.randomCborSha256Cid();
      await store.put(alice, aliceRecordId, dataCid, DataStream.fromBytes(dataBytes));

      // write same data to bob's DWN
      const bobRecordId = await TestDataGenerator.randomCborSha256Cid();
      await store.put(bob, bobRecordId, dataCid, DataStream.fromBytes(dataBytes));

      // verify blocks are shared — only one set of blocks in the blocks partition
      const blocksPartition = await store['getBlocksPartition'](dataCid);
      const blockKeys = await ArrayUtility.fromAsyncGenerator(blocksPartition.db.keys());
      expect(blockKeys).toEqual([ dataCid ]);

      // verify both tenants can read the data
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

      const dataBytes = TestDataGenerator.randomBytes(100);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      // first put
      const result1 = await store.put(tenant, recordId, dataCid, DataStream.fromBytes(dataBytes));
      expect(result1.dataSize).toBe(100);

      // second put — should be idempotent
      const result2 = await store.put(tenant, recordId, dataCid, DataStream.fromBytes(dataBytes));
      expect(result2.dataSize).toBe(100);

      // refcount should still be 1 (not 2)
      const refcountsPartition = await store['getRefcountsPartition']();
      const rawRefcount = await refcountsPartition.get(dataCid);
      const refcountData = JSON.parse(new TextDecoder().decode(rawRefcount!));
      expect(refcountData.count).toBe(1);
    });
  });

  describe('get', function () {
    it('should return `undefined if unable to find the data specified`', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();

      const randomCid = await TestDataGenerator.randomCborSha256Cid();
      const result = await store.get(tenant, recordId, randomCid);

      expect(result).toBeUndefined();
    });

    it('should return `undefined` if the dataCid is different than the dataStream`', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();

      const randomCid = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(10_000_000);
      const dataStream = DataStream.fromBytes(dataBytes);

      await store.put(tenant, recordId, randomCid, dataStream);

      const result = await store.get(tenant, recordId, randomCid);
      expect(result).toBeUndefined();
    });
  });

  describe('delete', function () {
    it('should not leave anything behind when deleting the root CID', async () => {
      const tenant = await TestDataGenerator.randomCborSha256Cid();
      const recordId = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(10_000_000);
      const dataStream = DataStream.fromBytes(dataBytes);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      await store.put(tenant, recordId, dataCid, dataStream);

      const keysBeforeDelete = await ArrayUtility.fromAsyncGenerator(store.blockstore.db.keys());
      // 40 block keys + 1 ref key + 1 refcount key = 42
      expect(keysBeforeDelete.length).toBe(42);

      await store.delete(tenant, recordId, dataCid);

      const keysAfterDelete = await ArrayUtility.fromAsyncGenerator(store.blockstore.db.keys());
      expect(keysAfterDelete.length).toBe(0);
    });

    it('should keep shared blocks when deleting one ref but other refs remain', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(100);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const aliceRecordId = await TestDataGenerator.randomCborSha256Cid();
      const bobRecordId = await TestDataGenerator.randomCborSha256Cid();

      await store.put(alice, aliceRecordId, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, bobRecordId, dataCid, DataStream.fromBytes(dataBytes));

      // delete alice's ref — bob should still be able to read
      await store.delete(alice, aliceRecordId, dataCid);

      const aliceResult = await store.get(alice, aliceRecordId, dataCid);
      expect(aliceResult).toBeUndefined();

      const bobResult = (await store.get(bob, bobRecordId, dataCid))!;
      expect(bobResult).toBeDefined();
      expect(await DataStream.toBytes(bobResult.dataStream)).toEqual(dataBytes);
    });

    it('should garbage-collect blocks when last ref is deleted', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(100);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      const aliceRecordId = await TestDataGenerator.randomCborSha256Cid();
      const bobRecordId = await TestDataGenerator.randomCborSha256Cid();

      await store.put(alice, aliceRecordId, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, bobRecordId, dataCid, DataStream.fromBytes(dataBytes));

      // verify blocks exist
      const blocksPartition = await store['getBlocksPartition'](dataCid);
      expect(await blocksPartition.db.isEmpty()).toBe(false);

      // delete alice's ref — blocks should still exist (bob still references them)
      await store.delete(alice, aliceRecordId, dataCid);
      expect(await blocksPartition.db.isEmpty()).toBe(false);

      // delete bob's ref — last ref gone, blocks should be garbage-collected
      await store.delete(bob, bobRecordId, dataCid);
      const blocksAfter = await store['getBlocksPartition'](dataCid);
      expect(await blocksAfter.db.isEmpty()).toBe(true);

      // refcount should be gone too
      const refcountsPartition = await store['getRefcountsPartition']();
      expect(await refcountsPartition.get(dataCid)).toBeUndefined();
    });

    it('should only delete the specified ref without affecting other records', async () => {
      const alice = await TestDataGenerator.randomCborSha256Cid();
      const bob = await TestDataGenerator.randomCborSha256Cid();

      const dataBytes = TestDataGenerator.randomBytes(100);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

      // alice writes two records with same data
      const recordId1 = await TestDataGenerator.randomCborSha256Cid();
      const recordId2 = await TestDataGenerator.randomCborSha256Cid();
      await store.put(alice, recordId1, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(alice, recordId2, dataCid, DataStream.fromBytes(dataBytes));

      // bob writes two records with same data
      const recordId3 = await TestDataGenerator.randomCborSha256Cid();
      const recordId4 = await TestDataGenerator.randomCborSha256Cid();
      await store.put(bob, recordId3, dataCid, DataStream.fromBytes(dataBytes));
      await store.put(bob, recordId4, dataCid, DataStream.fromBytes(dataBytes));

      // all four records should be readable
      expect(await store.get(alice, recordId1, dataCid)).toBeDefined();
      expect(await store.get(alice, recordId2, dataCid)).toBeDefined();
      expect(await store.get(bob, recordId3, dataCid)).toBeDefined();
      expect(await store.get(bob, recordId4, dataCid)).toBeDefined();

      // alice deletes one of the two records
      await store.delete(alice, recordId1, dataCid);
      expect(await store.get(alice, recordId1, dataCid)).toBeUndefined();
      expect(await store.get(alice, recordId2, dataCid)).toBeDefined();
      expect(await store.get(bob, recordId3, dataCid)).toBeDefined();
      expect(await store.get(bob, recordId4, dataCid)).toBeDefined();

      // alice deletes the other record
      await store.delete(alice, recordId2, dataCid);
      expect(await store.get(alice, recordId1, dataCid)).toBeUndefined();
      expect(await store.get(alice, recordId2, dataCid)).toBeUndefined();
      expect(await store.get(bob, recordId3, dataCid)).toBeDefined();
      expect(await store.get(bob, recordId4, dataCid)).toBeDefined();

      // bob deletes first record
      await store.delete(bob, recordId3, dataCid);
      expect(await store.get(bob, recordId3, dataCid)).toBeUndefined();
      expect(await store.get(bob, recordId4, dataCid)).toBeDefined();

      // bob deletes last record — everything should be cleaned up
      await store.delete(bob, recordId4, dataCid);
      expect(await store.get(bob, recordId4, dataCid)).toBeUndefined();

      const keysAfterDelete = await ArrayUtility.fromAsyncGenerator(store.blockstore.db.keys());
      expect(keysAfterDelete.length).toBe(0);
    });
  });
});
