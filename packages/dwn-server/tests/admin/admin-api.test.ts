import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

import { config as defaultConfig } from '../../src/config.js';
import { DwnServer } from '../../src/dwn-server.js';

const adminToken = 'test-admin-token-secret';

function adminFetch(
  server: { port: number },
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `http://localhost:${server.port}/admin/api${path}`;
  return fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...options.headers,
    },
  });
}

/**
 * Creates a DwnServer config pointing at a file-based SQLite database so that
 * the DWN stores and the AdminStore share the same tables.
 */
function createTestConfig(port: number, dbDir: string): typeof defaultConfig {
  const sqliteUrl = `sqlite://${dbDir}/test.db`;
  return {
    ...defaultConfig,
    port,
    adminToken,
    registrationStoreUrl   : sqliteUrl,
    messageStore           : sqliteUrl,
    dataStore              : sqliteUrl,
    stateIndex             : sqliteUrl,
    resumableTaskStore     : sqliteUrl,
    ttlCacheUrl            : sqliteUrl,
    webSocketSupport       : false,
    logLevel               : 'error',
    // Explicitly unset termsOfServiceFilePath to avoid inheriting a mutated
    // value from other test files that modify the shared default config object.
    // See: https://github.com/enboxorg/enbox/issues/144
    termsOfServiceFilePath : undefined,
  };
}

describe('AdminApi', () => {
  let dwnServer: DwnServer;
  let port: number;
  let tmpDir: string;

  beforeAll(async () => {
    port = 9100 + Math.floor(Math.random() * 900);
    tmpDir = mkdtempSync(join(tmpdir(), 'dwn-admin-test-'));
    dwnServer = new DwnServer({ config: createTestConfig(port, tmpDir) });
    await dwnServer.start();
  });

  afterAll(async () => {
    await dwnServer.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it('should return 401 when no authorization header is provided', async () => {
      const response = await fetch(`http://localhost:${port}/admin/api/info`);
      expect(response.status).toBe(401);
    });

    it('should return 401 when an invalid token is provided', async () => {
      const response = await fetch(`http://localhost:${port}/admin/api/info`, {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.status).toBe(401);
    });

    it('should return 401 when authorization header format is invalid', async () => {
      const response = await fetch(`http://localhost:${port}/admin/api/info`, {
        headers: { authorization: `Basic ${adminToken}` },
      });
      expect(response.status).toBe(401);
    });

    it('should return 200 when a valid token is provided', async () => {
      const response = await adminFetch({ port }, '/info');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.adminApi).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Admin disabled
  // ---------------------------------------------------------------------------

  describe('admin disabled', () => {
    let disabledServer: DwnServer;
    let disabledPort: number;
    let disabledTmpDir: string;

    beforeAll(async () => {
      disabledPort = 9200 + Math.floor(Math.random() * 900);
      disabledTmpDir = mkdtempSync(join(tmpdir(), 'dwn-admin-disabled-'));
      const cfg = createTestConfig(disabledPort, disabledTmpDir);
      cfg.adminToken = undefined;
      disabledServer = new DwnServer({ config: cfg });
      await disabledServer.start();
    });

    afterAll(async () => {
      await disabledServer.stop();
      rmSync(disabledTmpDir, { recursive: true, force: true });
    });

    it('should return 404 when admin API is disabled', async () => {
      const response = await fetch(`http://localhost:${disabledPort}/admin/api/info`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Info endpoint
  // ---------------------------------------------------------------------------

  describe('GET /admin/api/info', () => {
    it('should return admin info with uptime', async () => {
      const response = await adminFetch({ port }, '/info');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.adminApi).toBe(true);
      expect(typeof body.uptime).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // Health endpoint
  // ---------------------------------------------------------------------------

  describe('GET /admin/api/health', () => {
    it('should return health status', async () => {
      const response = await adminFetch({ port }, '/health');
      const body = await response.json();
      expect(body.status).toBeDefined();
      expect(typeof body.uptime).toBe('number');
      expect(body.checks).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Stats endpoint
  // ---------------------------------------------------------------------------

  describe('GET /admin/api/stats', () => {
    it('should return server statistics', async () => {
      const response = await adminFetch({ port }, '/stats');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tenants).toBeDefined();
      expect(typeof body.tenants.total).toBe('number');
      expect(body.storage).toBeDefined();
      expect(body.connections).toBeDefined();
      expect(typeof body.uptime).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // 404 for unknown admin routes
  // ---------------------------------------------------------------------------

  describe('unknown routes', () => {
    it('should return 404 for unknown admin API paths', async () => {
      const response = await adminFetch({ port }, '/nonexistent');
      expect(response.status).toBe(404);
    });
  });
});

describe('AdminApi — tenant management', () => {
  let dwnServer: DwnServer;
  let port: number;
  let tmpDir: string;

  beforeAll(async () => {
    port = 9300 + Math.floor(Math.random() * 900);
    tmpDir = mkdtempSync(join(tmpdir(), 'dwn-admin-tenants-'));
    dwnServer = new DwnServer({ config: createTestConfig(port, tmpDir) });
    await dwnServer.start();
  });

  afterAll(async () => {
    await dwnServer.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should list tenants (initially empty via registration store)', async () => {
    const response = await adminFetch({ port }, '/tenants');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(body.totalCount).toBe(0);
  });

  it('should register a tenant, then list it', async () => {
    // Register a tenant directly via the registration manager.
    await dwnServer.registrationManager.recordTenantRegistration({
      did                : 'did:test:tenant1',
      termsOfServiceHash : 'hash1',
    });

    const response = await adminFetch({ port }, '/tenants');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.totalCount).toBeGreaterThanOrEqual(1);

    const tenant = body.data.find((t: any): boolean => t.did === 'did:test:tenant1');
    expect(tenant).toBeDefined();
  });

  it('should return tenant detail', async () => {
    const response = await adminFetch({ port }, '/tenants/did:test:tenant1');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.did).toBe('did:test:tenant1');
    expect(body.isActive).toBeDefined();
    expect(body.storage).toBeDefined();
  });

  it('should return 404 for non-existent tenant', async () => {
    const response = await adminFetch({ port }, '/tenants/did:test:nonexistent');
    expect(response.status).toBe(404);
  });

  it('should suspend and unsuspend a tenant', async () => {
    // Suspend.
    const suspendResponse = await adminFetch({ port }, '/tenants/did:test:tenant1/suspend', {
      method: 'POST',
    });
    expect(suspendResponse.status).toBe(200);
    const suspendBody = await suspendResponse.json();
    expect(suspendBody.success).toBe(true);

    // Verify tenant is inactive.
    const activeCheck = await dwnServer.registrationManager.isActiveTenant('did:test:tenant1');
    expect(activeCheck.isActiveTenant).toBe(false);
    expect(activeCheck.detail).toContain('suspended');

    // Unsuspend.
    const unsuspendResponse = await adminFetch({ port }, '/tenants/did:test:tenant1/unsuspend', {
      method: 'POST',
    });
    expect(unsuspendResponse.status).toBe(200);

    // Verify tenant is active again (ToS hash check: registration has 'hash1', manager has no ToS = undefined).
    // When the registration manager has no ToS configured, it doesn't check the hash,
    // so the tenant should be active after unsuspension.
    const activeCheck2 = await dwnServer.registrationManager.isActiveTenant('did:test:tenant1');
    expect(activeCheck2.isActiveTenant).toBe(true);
  });

  it('should return 404 when suspending a non-existent tenant', async () => {
    const response = await adminFetch({ port }, '/tenants/did:test:ghost/suspend', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  it('should delete a tenant', async () => {
    // Register a tenant to delete.
    await dwnServer.registrationManager.recordTenantRegistration({
      did                : 'did:test:deleteme',
      termsOfServiceHash : 'hash2',
    });

    const deleteResponse = await adminFetch({ port }, '/tenants/did:test:deleteme', {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(200);
    const deleteBody = await deleteResponse.json();
    expect(deleteBody.success).toBe(true);

    // Verify tenant is gone.
    const detailResponse = await adminFetch({ port }, '/tenants/did:test:deleteme');
    expect(detailResponse.status).toBe(404);
  });

  it('should handle pagination with cursor and limit', async () => {
    // Register multiple tenants.
    for (let i = 0; i < 5; i++) {
      await dwnServer.registrationManager.recordTenantRegistration({
        did                : `did:test:page${String(i).padStart(2, '0')}`,
        termsOfServiceHash : 'hash',
      });
    }

    // Fetch page 1 with limit 2.
    const page1 = await adminFetch({ port }, '/tenants?limit=2');
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.data.length).toBe(2);
    expect(body1.cursor).toBeDefined();

    // Fetch page 2.
    const page2 = await adminFetch({ port }, `/tenants?limit=2&cursor=${body1.cursor}`);
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.data.length).toBeGreaterThan(0);

    // Ensure no overlap.
    const page1Dids = body1.data.map((t: any): string => t.did);
    const page2Dids = body2.data.map((t: any): string => t.did);
    for (const did of page1Dids) {
      expect(page2Dids).not.toContain(did);
    }
  });
});

describe('validateAdminAuth', () => {
  // Direct unit tests for the auth function.
  const { validateAdminAuth } = require('../../src/admin/admin-auth.js');

  it('should return 404 when admin token is not configured', () => {
    const req = new Request('http://localhost/admin/api/info');
    const result = validateAdminAuth(req, { ...defaultConfig, adminToken: undefined });
    expect(result).not.toBeNull();
    expect(result.status).toBe(404);
  });

  it('should return 401 when no authorization header is provided', () => {
    const req = new Request('http://localhost/admin/api/info');
    const result = validateAdminAuth(req, { ...defaultConfig, adminToken: 'secret' });
    expect(result).not.toBeNull();
    expect(result.status).toBe(401);
  });

  it('should return 401 when the token is wrong', () => {
    const req = new Request('http://localhost/admin/api/info', {
      headers: { authorization: 'Bearer wrong' },
    });
    const result = validateAdminAuth(req, { ...defaultConfig, adminToken: 'secret' });
    expect(result).not.toBeNull();
    expect(result.status).toBe(401);
  });

  it('should return null when the token is correct', () => {
    const req = new Request('http://localhost/admin/api/info', {
      headers: { authorization: 'Bearer secret' },
    });
    const result = validateAdminAuth(req, { ...defaultConfig, adminToken: 'secret' });
    expect(result).toBeNull();
  });
});
