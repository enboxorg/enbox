import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import {
  DataStoreSql,
  MessageStoreSql,
  ResumableTaskStoreSql,
  StateIndexSql,
} from '@enbox/dwn-sql-store';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { Dwn, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { mkdtempSync, rmSync } from 'fs';

import { AdminStore } from '../../src/admin/admin-store.js';
import { getDialectFromUrl } from '../../src/storage.js';
import { RegistrationStore } from '../../src/registration/registration-store.js';

describe('AdminStore', () => {
  let adminStore: AdminStore;
  let registrationStore: RegistrationStore;
  let dwn: Dwn;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'admin-store-test-'));
    const sqliteUrl = new URL(`sqlite://${tmpDir}/admin-store.db`);

    // All stores MUST share the same dialect instance so they share the same
    // underlying SQLite database connection (file-based SQLite).
    const sharedDialect = getDialectFromUrl(sqliteUrl);

    const dataStore = new DataStoreSql(sharedDialect);
    const messageStore = new MessageStoreSql(sharedDialect);
    const stateIndex = new StateIndexSql(sharedDialect);
    const resumableTaskStore = new ResumableTaskStoreSql(sharedDialect);

    const didResolver = new UniversalResolver({ didResolvers: [DidKey] });

    dwn = await Dwn.create({
      dataStore,
      messageStore,
      stateIndex,
      resumableTaskStore,
      didResolver,
    });

    adminStore = AdminStore.createFromDialect(sharedDialect, 100)!;
    registrationStore = await RegistrationStore.create(sharedDialect);
  });

  afterAll(async () => {
    await dwn.close();
    await adminStore.close();
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
      expect(page1.tenants.length).toBe(2);
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
});
