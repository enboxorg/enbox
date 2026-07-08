import type { Dialect } from '@enbox/dwn-sql-store';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { Kysely } from 'kysely';
import { tmpdir } from 'os';
import {
  DataStoreSql,
  MessageStoreSql,
  ResumableTaskStoreSql,
  runDwnStoreMigrations,
} from '@enbox/dwn-sql-store';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { Dwn, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { mkdtempSync, rmSync } from 'fs';

import { AdminStore } from '../../src/admin/admin-store.js';
import { getDialectFromUrl } from '../../src/storage.js';
import { RegistrationStore } from '../../src/registration/registration-store.js';
import { runServerMigrations } from '../../src/server-migration-runner.js';

/**
 * Minimal Kysely type for direct SQL verification queries.
 */
interface TestDatabase {
  messageStoreMessages: { tenant: string; dataSize: number | null };
  dataRefs: { tenant: string; recordId: string; dataCid: string; dataSize: number };
  dataBlocks: { rootDataCid: string; blockCid: string; data: Uint8Array };
  replicationCounters: { tenant: string; seq: number | string | bigint };
  replicationFingerprints: { tenant: string; scope: string; fingerprint: string };
}

describe('AdminStore', () => {
  let adminStore: AdminStore;
  let registrationStore: RegistrationStore;
  let dwn: Dwn;
  let tmpDir: string;
  /** Direct SQL access for verification queries against dataRefs/dataBlocks. */
  let rawDb: Kysely<TestDatabase>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-store-test-'));
    const sqliteUrl = new URL(`sqlite://${tmpDir}/admin-store.db`);

    // All stores MUST share the same dialect instance so they share the same
    // underlying SQLite database connection (file-based SQLite).
    const sharedDialect: Dialect = getDialectFromUrl(sqliteUrl);

    // Run both DWN and server migrations before creating stores.
    const migrationDb = new Kysely<Record<string, unknown>>({ dialect: sharedDialect });
    await runDwnStoreMigrations(migrationDb, sharedDialect);
    await runServerMigrations(migrationDb, sharedDialect);

    const dataStore = new DataStoreSql(sharedDialect);
    const messageStore = new MessageStoreSql(sharedDialect);
    const resumableTaskStore = new ResumableTaskStoreSql(sharedDialect);

    const didResolver = new UniversalResolver({ didResolvers: [DidKey] });

    dwn = await Dwn.create({
      dataStore,
      messageStore,
      resumableTaskStore,
      didResolver,
    });

    adminStore = AdminStore.createFromDialect(sharedDialect, 100)!;
    registrationStore = await RegistrationStore.create(sharedDialect);
    rawDb = new Kysely<TestDatabase>({ dialect: sharedDialect });
  });

  afterAll(async () => {
    await dwn.close();
    await adminStore.close();
    await rawDb.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Factory methods
  // ---------------------------------------------------------------------------

  describe('create()', () => {
    it('should return undefined for level:// URLs', () => {
      const store = AdminStore.create('level://data');
      expect(store).toBeUndefined();
    });

    it('should return undefined for file-path URLs', () => {
      expect(AdminStore.create('/some/path')).toBeUndefined();
      expect(AdminStore.create('./relative/path')).toBeUndefined();
      expect(AdminStore.create('../parent/path')).toBeUndefined();
    });

    it('should return undefined for invalid URLs', () => {
      const store = AdminStore.create('not-a-url');
      expect(store).toBeUndefined();
    });

    it('should create an AdminStore for a valid sqlite:// URL', () => {
      const store = AdminStore.create(`sqlite://${tmpDir}/factory-test.db`);
      expect(store).toBeDefined();
    });
  });

  describe('createFromDialect()', () => {
    it('should create an AdminStore from a dialect', () => {
      const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/dialect-test.db`));
      const store = AdminStore.createFromDialect(dialect);
      expect(store).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // isAvailable()
  // ---------------------------------------------------------------------------

  describe('isAvailable()', () => {
    it('should return true when DWN SQL tables exist', async () => {
      const available = await adminStore.isAvailable();
      expect(available).toBe(true);
    });

    it('should return false when tables do not exist', async () => {
      // Create an admin store against an empty database with no DWN tables.
      const emptyDir = mkdtempSync(join(tmpdir(), 'admin-store-empty-'));
      const emptyDialect = getDialectFromUrl(new URL(`sqlite://${emptyDir}/empty.db`));
      const emptyStore = AdminStore.createFromDialect(emptyDialect);

      const available = await emptyStore.isAvailable();
      expect(available).toBe(false);

      await emptyStore.close();
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  // ---------------------------------------------------------------------------
  // getDistinctTenants()
  // ---------------------------------------------------------------------------

  describe('getDistinctTenants()', () => {
    it('should return distinct tenant DIDs from the message store', async () => {
      // Write messages for several tenants.
      for (let i = 0; i < 5; i++) {
        const persona = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
        const result = await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
        expect(result.status.code).toBe(202);
      }

      const result = await adminStore.getDistinctTenants();
      expect(result.tenants.length).toBeGreaterThanOrEqual(5);
      // All entries should be unique.
      const unique = new Set(result.tenants);
      expect(unique.size).toBe(result.tenants.length);
    });

    it('should support pagination with limit', async () => {
      const page1 = await adminStore.getDistinctTenants({ limit: 2 });
      expect(page1.tenants).toHaveLength(2);
      expect(page1.cursor).toBeDefined();
    });

    it('should support cursor-based pagination', async () => {
      const page1 = await adminStore.getDistinctTenants({ limit: 2 });
      expect(page1.cursor).toBeDefined();

      const page2 = await adminStore.getDistinctTenants({ limit: 2, cursor: page1.cursor });
      expect(page2.tenants.length).toBeGreaterThan(0);

      // No overlap between pages.
      for (const did of page1.tenants) {
        expect(page2.tenants).not.toContain(did);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // purgeTenantData()
  // ---------------------------------------------------------------------------

  describe('purgeTenantData()', () => {
    it('should delete all data for a tenant and return the message count', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      // Write a record for this tenant.
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
      const writeResult = await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      expect(writeResult.status.code).toBe(202);

      // Verify messages exist.
      const countBefore = await adminStore.getTenantMessageCount(persona.did);
      expect(countBefore).toBeGreaterThan(0);

      // Purge.
      const deleted = await adminStore.purgeTenantData(persona.did);
      expect(deleted).toBeGreaterThan(0);

      // Verify messages are gone.
      const countAfter = await adminStore.getTenantMessageCount(persona.did);
      expect(countAfter).toBe(0);
    });

    it('should return 0 when purging a tenant with no data', async () => {
      const deleted = await adminStore.purgeTenantData('did:key:nonexistent');
      expect(deleted).toBe(0);
    });

    it('should invalidate the global stats cache', async () => {
      // Prime the cache.
      await adminStore.getGlobalStats();

      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
      await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });

      // Purge should invalidate cache, so next getGlobalStats recalculates.
      await adminStore.purgeTenantData(persona.did);
      const stats = await adminStore.getGlobalStats();
      expect(stats.tenantCount).toBeDefined();
    });

    it('should delete replication fingerprints and preserve replication counters', async () => {
      const tenant = await TestDataGenerator.generateDidKeyPersona();
      const otherTenant = await TestDataGenerator.generateDidKeyPersona();

      await rawDb
        .insertInto('replicationCounters')
        .values([
          { tenant: tenant.did, seq: 42 },
          { tenant: otherTenant.did, seq: 7 },
        ])
        .execute();

      await rawDb
        .insertInto('replicationFingerprints')
        .values([
          { tenant: tenant.did, scope: 'global', fingerprint: '1'.repeat(64) },
          { tenant: tenant.did, scope: 'protocol:example', fingerprint: '2'.repeat(64) },
          { tenant: otherTenant.did, scope: 'global', fingerprint: '3'.repeat(64) },
        ])
        .execute();

      await adminStore.purgeTenantData(tenant.did);

      const tenantFingerprints = await rawDb
        .selectFrom('replicationFingerprints')
        .selectAll()
        .where('tenant', '=', tenant.did)
        .execute();
      expect(tenantFingerprints).toHaveLength(0);

      const tenantCounter = await rawDb
        .selectFrom('replicationCounters')
        .selectAll()
        .where('tenant', '=', tenant.did)
        .executeTakeFirst();
      expect(tenantCounter?.seq).toBe(42);

      const otherTenantFingerprints = await rawDb
        .selectFrom('replicationFingerprints')
        .selectAll()
        .where('tenant', '=', otherTenant.did)
        .execute();
      expect(otherTenantFingerprints).toHaveLength(1);

      const otherTenantCounter = await rawDb
        .selectFrom('replicationCounters')
        .selectAll()
        .where('tenant', '=', otherTenant.did)
        .executeTakeFirst();
      expect(otherTenantCounter?.seq).toBe(7);
    });
  });

  // ---------------------------------------------------------------------------
  // getSuspendedTenantCount()
  // ---------------------------------------------------------------------------

  describe('getSuspendedTenantCount()', () => {
    it('should return the count of suspended tenants', async () => {
      // Register and suspend a tenant.
      await registrationStore.insertOrUpdateTenantRegistration({
        did                : 'did:key:suspended1',
        termsOfServiceHash : 'hash',
      });
      await registrationStore.suspendTenant('did:key:suspended1');

      const count = await adminStore.getSuspendedTenantCount();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('should return 0 when no tenants are suspended', async () => {
      // Unsuspend all we might have created.
      await registrationStore.unsuspendTenant('did:key:suspended1');

      const count = await adminStore.getSuspendedTenantCount();
      expect(count).toBe(0);
    });

    it('should return 0 when the registeredTenants table does not exist', async () => {
      // Create a store pointing at a DB without registeredTenants table.
      const emptyDir = mkdtempSync(join(tmpdir(), 'admin-store-no-reg-'));
      const emptyDialect = getDialectFromUrl(new URL(`sqlite://${emptyDir}/noreg.db`));
      const store = AdminStore.createFromDialect(emptyDialect);

      const count = await store.getSuspendedTenantCount();
      expect(count).toBe(0);

      await store.close();
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  // ---------------------------------------------------------------------------
  // getGlobalStats() caching
  // ---------------------------------------------------------------------------

  describe('getGlobalStats()', () => {
    it('should cache results within the TTL', async () => {
      const stats1 = await adminStore.getGlobalStats();
      const stats2 = await adminStore.getGlobalStats();
      // Same object reference when cached.
      expect(stats1).toBe(stats2);
    });

    it('should refresh when refresh option is true', async () => {
      const stats1 = await adminStore.getGlobalStats();
      const stats2 = await adminStore.getGlobalStats({ refresh: true });
      // Different object when forced refresh.
      expect(stats1).not.toBe(stats2);
    });
  });

  // ---------------------------------------------------------------------------
  // getTenantMessages()
  // ---------------------------------------------------------------------------

  describe('getTenantMessages()', () => {
    it('should return message metadata for a tenant', async () => {
      // Create a persona and write a message.
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
      const result = await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      expect(result.status.code).toBe(202);

      const { messages } = await adminStore.getTenantMessages(persona.did);
      expect(messages.length).toBeGreaterThanOrEqual(1);

      // Verify metadata fields are present and encodedMessageBytes is not.
      const msg = messages[0];
      expect(msg.messageCid).toBeDefined();
      expect(typeof msg.messageCid).toBe('string');
      expect((msg as any).encodedMessageBytes).toBeUndefined();
      expect(msg.interface).toBeDefined();
      expect(msg.method).toBeDefined();
    });

    it('should return empty results for a tenant with no messages', async () => {
      const { messages } = await adminStore.getTenantMessages('did:key:nonexistent-tenant');
      expect(messages).toBeInstanceOf(Array);
      expect(messages).toHaveLength(0);
    });

    it('should support pagination with limit and cursor', async () => {
      // Create a persona with multiple messages.
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      for (let i = 0; i < 5; i++) {
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
        await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      }

      // Fetch first page.
      const page1 = await adminStore.getTenantMessages(persona.did, { limit: 2 });
      expect(page1.messages).toHaveLength(2);
      expect(page1.cursor).toBeDefined();

      // Fetch second page.
      const page2 = await adminStore.getTenantMessages(persona.did, { limit: 2, cursor: page1.cursor });
      expect(page2.messages).toHaveLength(2);

      // No overlap (compare messageCids).
      const page1Cids = page1.messages.map((m): string => m.messageCid);
      const page2Cids = page2.messages.map((m): string => m.messageCid);
      for (const cid of page2Cids) {
        expect(page1Cids).not.toContain(cid);
      }
    });

    it('should filter by interface', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
      await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });

      // Filter for Records interface messages.
      const { messages } = await adminStore.getTenantMessages(persona.did, { interface: 'Records' });
      for (const msg of messages) {
        expect(msg.interface).toBe('Records');
      }

      // Filter for Protocols interface — should include the protocol install.
      const { messages: protoMsgs } = await adminStore.getTenantMessages(persona.did, { interface: 'Protocols' });
      expect(protoMsgs.length).toBeGreaterThanOrEqual(1);
      for (const msg of protoMsgs) {
        expect(msg.interface).toBe('Protocols');
      }
    });

    it('should filter by method', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
      await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });

      const { messages } = await adminStore.getTenantMessages(persona.did, { method: 'Write' });
      for (const msg of messages) {
        expect(msg.method).toBe('Write');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getTenantProtocolCounts()
  // ---------------------------------------------------------------------------

  describe('getTenantProtocolCounts()', () => {
    it('should return per-protocol message counts', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
      await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });

      const protocols = await adminStore.getTenantProtocolCounts(persona.did);
      expect(protocols.length).toBeGreaterThanOrEqual(1);

      for (const proto of protocols) {
        expect(proto.protocol).toBeDefined();
        expect(typeof proto.protocol).toBe('string');
        expect(typeof proto.messageCount).toBe('number');
        expect(proto.messageCount).toBeGreaterThan(0);
      }
    });

    it('should return empty array for tenant with no protocol messages', async () => {
      const protocols = await adminStore.getTenantProtocolCounts('did:key:no-protocols');
      expect(protocols).toBeInstanceOf(Array);
      expect(protocols).toHaveLength(0);
    });

    it('should order by messageCount descending', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      // Write multiple records to increase the protocol message count.
      for (let i = 0; i < 3; i++) {
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
        await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      }

      const protocols = await adminStore.getTenantProtocolCounts(persona.did);
      for (let i = 1; i < protocols.length; i++) {
        expect(protocols[i - 1].messageCount).toBeGreaterThanOrEqual(protocols[i].messageCount);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getTenantStorageSize() — uses messageStoreMessages.dataSize
  // ---------------------------------------------------------------------------

  // Data must exceed DwnConstant.maxDataSizeAllowedToBeEncoded (30_000 bytes) to be
  // stored in the DataStore (dataRefs/dataBlocks). Smaller data is stored inline in
  // messageStoreMessages.encodedData and never touches dataRefs.
  const LARGE_DATA_SIZE = 40_000;
  const SMALL_DATA_SIZE = 1_000;

  describe('getTenantStorageSize()', () => {
    it('should return the correct byte total for a tenant with large data records', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      const data = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
      const result = await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      expect(result.status.code).toBe(202);

      const storageSize = await adminStore.getTenantStorageSize(persona.did);
      expect(storageSize).toBe(data.length);
    });

    it('should include small inline data that never reaches the data store', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      // Small data is stored inline in encodedData, NOT in dataRefs.
      const data = TestDataGenerator.randomBytes(SMALL_DATA_SIZE);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
      const result = await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      expect(result.status.code).toBe(202);

      // Verify no rows in dataRefs — the data is inline.
      const refs = await rawDb.selectFrom('dataRefs').select('dataCid').where('tenant', '=', persona.did).execute();
      expect(refs).toHaveLength(0);

      // Storage size should still reflect the small data.
      const storageSize = await adminStore.getTenantStorageSize(persona.did);
      expect(storageSize).toBe(data.length);
    });

    it('should return 0 for a tenant with no data records', async () => {
      const storageSize = await adminStore.getTenantStorageSize('did:key:no-data-at-all');
      expect(storageSize).toBe(0);
    });

    it('should sum storage across multiple data records for one tenant', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      const sizes = [LARGE_DATA_SIZE, LARGE_DATA_SIZE + 1000, LARGE_DATA_SIZE + 2000];
      for (const size of sizes) {
        const data = TestDataGenerator.randomBytes(size);
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
        const result = await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
        expect(result.status.code).toBe(202);
      }

      const expectedTotal = sizes.reduce((a, b): number => a + b, 0);
      const storageSize = await adminStore.getTenantStorageSize(persona.did);
      expect(storageSize).toBe(expectedTotal);
    });

    it('should count storage independently per tenant when sharing the same dataCid', async () => {
      const tenantA = await TestDataGenerator.generateDidKeyPersona();
      const tenantB = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantA);
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantB);

      // Write the exact same bytes to both tenants — same dataCid.
      const sharedData = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const writeA = await TestDataGenerator.generateRecordsWrite({ author: tenantA, data: sharedData });
      const writeB = await TestDataGenerator.generateRecordsWrite({ author: tenantB, data: sharedData });
      expect((await dwn.processMessage(tenantA.did, writeA.recordsWrite.message, { dataStream: writeA.dataStream })).status.code).toBe(202);
      expect((await dwn.processMessage(tenantB.did, writeB.recordsWrite.message, { dataStream: writeB.dataStream })).status.code).toBe(202);

      // Each tenant should report its own storage independently.
      const sizeA = await adminStore.getTenantStorageSize(tenantA.did);
      const sizeB = await adminStore.getTenantStorageSize(tenantB.did);
      expect(sizeA).toBe(sharedData.length);
      expect(sizeB).toBe(sharedData.length);
    });
  });

  // ---------------------------------------------------------------------------
  // getTenantCount() — dedicated tests
  // ---------------------------------------------------------------------------

  describe('getTenantCount()', () => {
    it('should return the correct count of distinct tenants', async () => {
      // Create N fresh tenants.
      const countBefore = await adminStore.getTenantCount();
      const newTenantCount = 3;
      for (let i = 0; i < newTenantCount; i++) {
        const persona = await TestDataGenerator.generateDidKeyPersona();
        await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona });
        await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      }

      const countAfter = await adminStore.getTenantCount();
      expect(countAfter).toBe(countBefore + newTenantCount);
    });
  });

  // ---------------------------------------------------------------------------
  // getTenantStats() — dedicated store-level tests
  // ---------------------------------------------------------------------------

  describe('getTenantStats()', () => {
    it('should return correct aggregated stats for a tenant', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      const data = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
      const result = await dwn.processMessage(persona.did, recordsWrite.message, { dataStream });
      expect(result.status.code).toBe(202);

      const stats = await adminStore.getTenantStats(persona.did);

      // Protocol install (ProtocolsConfigure) + RecordsWrite = at least 2 messages.
      expect(stats.messageCount).toBeGreaterThanOrEqual(2);
      expect(stats.dataStorageBytes).toBe(data.length);
      expect(stats.protocolCount).toBeGreaterThanOrEqual(1);
      expect(stats.protocols).toHaveLength(stats.protocolCount);
    });

    it('should return all-zero stats for a nonexistent tenant', async () => {
      const stats = await adminStore.getTenantStats('did:key:does-not-exist-stats');
      expect(stats.messageCount).toBe(0);
      expect(stats.dataStorageBytes).toBe(0);
      expect(stats.protocolCount).toBe(0);
      expect(stats.protocols).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getGlobalStats() — value correctness
  // ---------------------------------------------------------------------------

  describe('getGlobalStats() — value correctness', () => {
    it('should return correct totalMessages and tenantCount', async () => {
      // Force a fresh calculation.
      const stats = await adminStore.getGlobalStats({ refresh: true });
      expect(typeof stats.totalMessages).toBe('number');
      expect(stats.totalMessages).toBeGreaterThan(0);
      expect(stats.tenantCount).toBeGreaterThan(0);
    });

    it('should return correct totalDataBytes from messageStoreMessages', async () => {
      // Sum all dataSize values from messageStoreMessages as ground truth
      // (includes both inline and data-store-backed records).
      const groundTruth = await rawDb
        .selectFrom('messageStoreMessages')
        .select(rawDb.fn.sum<number>('dataSize').as('total'))
        .executeTakeFirstOrThrow();

      const stats = await adminStore.getGlobalStats({ refresh: true });
      expect(stats.totalDataBytes).toBe(Number(groundTruth.total) || 0);
    });

    it('should include per-tenant data in totalDataBytes when tenants share a dataCid', async () => {
      const statsBefore = await adminStore.getGlobalStats({ refresh: true });

      const tenantA = await TestDataGenerator.generateDidKeyPersona();
      const tenantB = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantA);
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantB);

      // Write the same large data to both tenants (must exceed 30KB to use dataStore).
      const sharedData = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const writeA = await TestDataGenerator.generateRecordsWrite({ author: tenantA, data: sharedData });
      const writeB = await TestDataGenerator.generateRecordsWrite({ author: tenantB, data: sharedData });
      expect((await dwn.processMessage(tenantA.did, writeA.recordsWrite.message, { dataStream: writeA.dataStream })).status.code).toBe(202);
      expect((await dwn.processMessage(tenantB.did, writeB.recordsWrite.message, { dataStream: writeB.dataStream })).status.code).toBe(202);

      const statsAfter = await adminStore.getGlobalStats({ refresh: true });

      // Both refs are counted — total should increase by 2 * sharedData.length.
      expect(statsAfter.totalDataBytes).toBe(statsBefore.totalDataBytes + (2 * sharedData.length));
    });
  });

  // ---------------------------------------------------------------------------
  // purgeTenantData() — content-addressed GC
  // ---------------------------------------------------------------------------

  describe('purgeTenantData() — content-addressed GC', () => {
    it('should delete dataRefs for the purged tenant', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      const data = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
      expect((await dwn.processMessage(persona.did, recordsWrite.message, { dataStream })).status.code).toBe(202);

      // Verify data exists before purge.
      expect(await adminStore.getTenantStorageSize(persona.did)).toBe(data.length);

      await adminStore.purgeTenantData(persona.did);

      // Storage should be 0 after purge (messages deleted).
      expect(await adminStore.getTenantStorageSize(persona.did)).toBe(0);
    });

    it('should garbage-collect dataBlocks when the last ref is deleted', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      const data = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
      expect((await dwn.processMessage(persona.did, recordsWrite.message, { dataStream })).status.code).toBe(202);

      // Find the dataCid to verify block cleanup.
      const refs = await rawDb
        .selectFrom('dataRefs')
        .select('dataCid')
        .where('tenant', '=', persona.did)
        .execute();
      expect(refs.length).toBeGreaterThan(0);
      const dataCid = refs[0].dataCid;

      // Confirm blocks exist.
      const blocksBefore = await rawDb
        .selectFrom('dataBlocks')
        .select('blockCid')
        .where('rootDataCid', '=', dataCid)
        .execute();
      expect(blocksBefore.length).toBeGreaterThan(0);

      // Purge the only tenant referencing this dataCid.
      await adminStore.purgeTenantData(persona.did);

      // Blocks should be garbage-collected.
      const blocksAfter = await rawDb
        .selectFrom('dataBlocks')
        .select('blockCid')
        .where('rootDataCid', '=', dataCid)
        .execute();
      expect(blocksAfter).toHaveLength(0);
    });

    it('should NOT garbage-collect dataBlocks when another tenant still references the same dataCid', async () => {
      const tenantA = await TestDataGenerator.generateDidKeyPersona();
      const tenantB = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantA);
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantB);

      // Write identical large data to both tenants — produces the same dataCid.
      const sharedData = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const writeA = await TestDataGenerator.generateRecordsWrite({ author: tenantA, data: sharedData });
      const writeB = await TestDataGenerator.generateRecordsWrite({ author: tenantB, data: sharedData });
      expect((await dwn.processMessage(tenantA.did, writeA.recordsWrite.message, { dataStream: writeA.dataStream })).status.code).toBe(202);
      expect((await dwn.processMessage(tenantB.did, writeB.recordsWrite.message, { dataStream: writeB.dataStream })).status.code).toBe(202);

      // Find the shared dataCid.
      const refsA = await rawDb
        .selectFrom('dataRefs')
        .select('dataCid')
        .where('tenant', '=', tenantA.did)
        .execute();
      const refsB = await rawDb
        .selectFrom('dataRefs')
        .select('dataCid')
        .where('tenant', '=', tenantB.did)
        .execute();
      expect(refsA.length).toBeGreaterThan(0);
      expect(refsB.length).toBeGreaterThan(0);
      // Same dataCid (same bytes).
      expect(refsA[0].dataCid).toBe(refsB[0].dataCid);
      const dataCid = refsA[0].dataCid;

      // Purge tenant A only.
      await adminStore.purgeTenantData(tenantA.did);

      // Blocks should still exist because tenant B still references the dataCid.
      const blocksAfter = await rawDb
        .selectFrom('dataBlocks')
        .select('blockCid')
        .where('rootDataCid', '=', dataCid)
        .execute();
      expect(blocksAfter.length).toBeGreaterThan(0);

      // Tenant B's storage should still be intact.
      expect(await adminStore.getTenantStorageSize(tenantB.did)).toBe(sharedData.length);
    });

    it('should garbage-collect after both tenants sharing a dataCid are purged', async () => {
      const tenantA = await TestDataGenerator.generateDidKeyPersona();
      const tenantB = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantA);
      await TestDataGenerator.installDefaultTestProtocol(dwn, tenantB);

      const sharedData = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const writeA = await TestDataGenerator.generateRecordsWrite({ author: tenantA, data: sharedData });
      const writeB = await TestDataGenerator.generateRecordsWrite({ author: tenantB, data: sharedData });
      expect((await dwn.processMessage(tenantA.did, writeA.recordsWrite.message, { dataStream: writeA.dataStream })).status.code).toBe(202);
      expect((await dwn.processMessage(tenantB.did, writeB.recordsWrite.message, { dataStream: writeB.dataStream })).status.code).toBe(202);

      const refs = await rawDb
        .selectFrom('dataRefs')
        .select('dataCid')
        .where('tenant', '=', tenantA.did)
        .execute();
      const dataCid = refs[0].dataCid;

      // Purge tenant A — blocks should remain.
      await adminStore.purgeTenantData(tenantA.did);
      let blocks = await rawDb.selectFrom('dataBlocks').select('blockCid').where('rootDataCid', '=', dataCid).execute();
      expect(blocks.length).toBeGreaterThan(0);

      // Purge tenant B — now blocks should be garbage-collected.
      await adminStore.purgeTenantData(tenantB.did);
      blocks = await rawDb.selectFrom('dataBlocks').select('blockCid').where('rootDataCid', '=', dataCid).execute();
      expect(blocks).toHaveLength(0);
    });

    it('should handle multiple records with different dataCids for one tenant', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      const dataCids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const data = TestDataGenerator.randomBytes(LARGE_DATA_SIZE + i * 1000);
        const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
        expect((await dwn.processMessage(persona.did, recordsWrite.message, { dataStream })).status.code).toBe(202);
      }

      // Collect all dataCids for this tenant.
      const refs = await rawDb.selectFrom('dataRefs').select('dataCid').where('tenant', '=', persona.did).execute();
      for (const ref of refs) {
        dataCids.push(ref.dataCid);
      }
      expect(dataCids).toHaveLength(3);

      // Purge.
      await adminStore.purgeTenantData(persona.did);

      // All refs and blocks should be gone.
      for (const cid of dataCids) {
        const remaining = await rawDb.selectFrom('dataBlocks').select('blockCid').where('rootDataCid', '=', cid).execute();
        expect(remaining).toHaveLength(0);
      }
      expect(await adminStore.getTenantStorageSize(persona.did)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // exportTenantData() — with real data
  // ---------------------------------------------------------------------------

  describe('exportTenantData()', () => {
    it('should export messages and dataRecords for a tenant', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);

      const data = TestDataGenerator.randomBytes(LARGE_DATA_SIZE);
      const { recordsWrite, dataStream } = await TestDataGenerator.generateRecordsWrite({ author: persona, data });
      expect((await dwn.processMessage(persona.did, recordsWrite.message, { dataStream })).status.code).toBe(202);

      const exported = await adminStore.exportTenantData(persona.did);

      // Metadata.
      expect(exported.metadata.tenant).toBe(persona.did);
      expect(exported.metadata.exportedAt).toBeDefined();
      expect(exported.metadata.messageCount).toBeGreaterThanOrEqual(2); // ProtocolsConfigure + RecordsWrite
      expect(exported.metadata.dataRecordCount).toBeGreaterThanOrEqual(1);

      // Messages should include expected fields.
      expect(exported.messages).toHaveLength(exported.metadata.messageCount);
      const recordsMsg = exported.messages.find((m): boolean => m.method === 'Write' && m.interface === 'Records');
      expect(recordsMsg).toBeDefined();
      expect(recordsMsg!.messageCid).toBeDefined();
      expect(recordsMsg!.recordId).toBeDefined();

      // Data records from dataRefs.
      expect(exported.dataRecords).toHaveLength(exported.metadata.dataRecordCount);
      const dataRec = exported.dataRecords[0];
      expect(dataRec.recordId).toBeDefined();
      expect(dataRec.dataCid).toBeDefined();
      expect(dataRec.dataSize).toBe(data.length);
    });

    it('should return empty results for a nonexistent tenant', async () => {
      const exported = await adminStore.exportTenantData('did:key:totally-nonexistent');
      expect(exported.metadata.messageCount).toBe(0);
      expect(exported.metadata.dataRecordCount).toBe(0);
      expect(exported.messages).toEqual([]);
      expect(exported.dataRecords).toEqual([]);
    });

    it('should return empty dataRecords when tenant has only protocol messages', async () => {
      const persona = await TestDataGenerator.generateDidKeyPersona();
      await TestDataGenerator.installDefaultTestProtocol(dwn, persona);
      // No RecordsWrite — only ProtocolsConfigure messages.

      const exported = await adminStore.exportTenantData(persona.did);
      expect(exported.metadata.messageCount).toBeGreaterThanOrEqual(1);
      expect(exported.metadata.dataRecordCount).toBe(0);
      expect(exported.dataRecords).toEqual([]);
    });
  });
});
