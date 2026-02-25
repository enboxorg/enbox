import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { createMigratedFileDialect } from '../utils.js';
import { RegistrationStore } from '../../src/registration/registration-store.js';

describe('RegistrationStore', () => {
  let store: RegistrationStore;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reg-store-test-'));
    const dialect = await createMigratedFileDialect(`sqlite://${tmpDir}/reg.db`);
    store = await RegistrationStore.create(dialect);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Provider-auth columns (#404)
  // -------------------------------------------------------------------------

  describe('provider-auth columns', () => {
    it('should store and retrieve accountId, registrationType, registeredAt, and metadata', async () => {
      const metadata = JSON.stringify({ plan: 'pro', quota: '50gb' });

      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:pa-full',
        termsOfServiceHash : 'hash-v1',
        accountId          : 'acct-42',
        registrationType   : 'provider-auth',
        metadata,
      });

      const tenant = await store.getTenantRegistration('did:key:pa-full');
      expect(tenant).toBeDefined();
      expect(tenant!.did).toBe('did:key:pa-full');
      expect(tenant!.accountId).toBe('acct-42');
      expect(tenant!.registrationType).toBe('provider-auth');
      expect(tenant!.metadata).toBe(metadata);
      expect(tenant!.registeredAt).toBeDefined();
      expect(tenant!.suspended).toBe(0);

      // Cleanup.
      await store.deleteTenant('did:key:pa-full');
    });

    it('should store a tenant with only the required fields (no provider-auth columns)', async () => {
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:pa-minimal',
        termsOfServiceHash : 'hash-v1',
      });

      const tenant = await store.getTenantRegistration('did:key:pa-minimal');
      expect(tenant).toBeDefined();
      expect(tenant!.accountId).toBeNull();
      expect(tenant!.registrationType).toBeNull();
      expect(tenant!.metadata).toBeNull();
      expect(tenant!.registeredAt).toBeDefined(); // always set

      // Cleanup.
      await store.deleteTenant('did:key:pa-minimal');
    });

    it('should update provider-auth columns on upsert without overwriting registeredAt', async () => {
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:pa-upsert',
        termsOfServiceHash : 'hash-v1',
        accountId          : 'acct-1',
        registrationType   : 'proof-of-work',
      });

      const original = await store.getTenantRegistration('did:key:pa-upsert');
      const originalRegisteredAt = original!.registeredAt;

      // Upsert with new values.
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:pa-upsert',
        termsOfServiceHash : 'hash-v2',
        accountId          : 'acct-2',
        registrationType   : 'provider-auth',
        metadata           : JSON.stringify({ upgraded: true }),
      });

      const updated = await store.getTenantRegistration('did:key:pa-upsert');
      expect(updated!.termsOfServiceHash).toBe('hash-v2');
      expect(updated!.accountId).toBe('acct-2');
      expect(updated!.registrationType).toBe('provider-auth');
      expect(updated!.metadata).toBe(JSON.stringify({ upgraded: true }));
      // registeredAt should NOT be overwritten on update.
      expect(updated!.registeredAt).toBe(originalRegisteredAt);

      // Cleanup.
      await store.deleteTenant('did:key:pa-upsert');
    });
  });

  describe('getTenantsForAccount()', () => {
    it('should return all tenants associated with an account', async () => {
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:acct-a-1',
        termsOfServiceHash : 'hash',
        accountId          : 'acct-a',
        registrationType   : 'provider-auth',
      });
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:acct-a-2',
        termsOfServiceHash : 'hash',
        accountId          : 'acct-a',
        registrationType   : 'provider-auth',
      });
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:acct-b-1',
        termsOfServiceHash : 'hash',
        accountId          : 'acct-b',
        registrationType   : 'provider-auth',
      });

      const tenantsA = await store.getTenantsForAccount('acct-a');
      expect(tenantsA).toHaveLength(2);
      expect(tenantsA.map((t) => t.did).sort()).toEqual(['did:key:acct-a-1', 'did:key:acct-a-2']);

      const tenantsB = await store.getTenantsForAccount('acct-b');
      expect(tenantsB).toHaveLength(1);
      expect(tenantsB[0].did).toBe('did:key:acct-b-1');

      const tenantsC = await store.getTenantsForAccount('nonexistent');
      expect(tenantsC).toHaveLength(0);

      // Cleanup.
      await store.deleteTenant('did:key:acct-a-1');
      await store.deleteTenant('did:key:acct-a-2');
      await store.deleteTenant('did:key:acct-b-1');
    });
  });

  describe('listTenants() — with provider-auth columns', () => {
    it('should include provider-auth columns in listed results', async () => {
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:list-pa',
        termsOfServiceHash : 'hash',
        accountId          : 'acct-list',
        registrationType   : 'provider-auth',
        metadata           : JSON.stringify({ tier: 'gold' }),
      });

      const { tenants } = await store.listTenants({ search: 'list-pa' });
      expect(tenants).toHaveLength(1);
      expect(tenants[0].accountId).toBe('acct-list');
      expect(tenants[0].registrationType).toBe('provider-auth');
      expect(tenants[0].metadata).toBe(JSON.stringify({ tier: 'gold' }));

      // Cleanup.
      await store.deleteTenant('did:key:list-pa');
    });
  });

  // -------------------------------------------------------------------------
  // Admin operations (existing)
  // -------------------------------------------------------------------------

  describe('deleteTenant()', () => {
    it('should delete an existing tenant and return true', async () => {
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:delete-me',
        termsOfServiceHash : 'hash',
      });

      const deleted = await store.deleteTenant('did:key:delete-me');
      expect(deleted).toBe(true);

      // Verify it's gone.
      const tenant = await store.getTenantRegistration('did:key:delete-me');
      expect(tenant).toBeUndefined();
    });

    it('should return false when the tenant does not exist', async () => {
      const deleted = await store.deleteTenant('did:key:nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('getSuspendedCount()', () => {
    it('should return 0 when no tenants are suspended', async () => {
      const count = await store.getSuspendedCount();
      expect(count).toBe(0);
    });

    it('should count suspended tenants correctly', async () => {
      // Register and suspend two tenants.
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:sus1',
        termsOfServiceHash : 'hash',
      });
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:sus2',
        termsOfServiceHash : 'hash',
      });
      await store.insertOrUpdateTenantRegistration({
        did                : 'did:key:active',
        termsOfServiceHash : 'hash',
      });

      await store.suspendTenant('did:key:sus1');
      await store.suspendTenant('did:key:sus2');

      const count = await store.getSuspendedCount();
      expect(count).toBe(2);

      // Cleanup.
      await store.deleteTenant('did:key:sus1');
      await store.deleteTenant('did:key:sus2');
      await store.deleteTenant('did:key:active');
    });
  });
});
