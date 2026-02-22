import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { getDialectFromUrl } from '../../src/storage.js';
import { RegistrationStore } from '../../src/registration/registration-store.js';

describe('RegistrationStore — admin operations', () => {
  let store: RegistrationStore;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reg-store-test-'));
    const dialect = getDialectFromUrl(new URL(`sqlite://${tmpDir}/reg.db`));
    store = await RegistrationStore.create(dialect);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

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
