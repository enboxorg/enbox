import type { DwnServerConfig } from '../src/config.js';

import sinon from 'sinon';

import { config } from '../src/config.js';
import { DurableEventLog } from '@enbox/dwn-sdk-js';
import { InMemoryEventBus } from '../src/event-bus.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { getDialectFromUrl, getDwnConfig } from '../src/storage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(overrides: Partial<DwnServerConfig> = {}): DwnServerConfig {
  return {
    ...config,
    messageStore       : 'sqlite://',
    dataStore          : 'sqlite://',
    resumableTaskStore : 'sqlite://',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('storage — coverage', () => {
  afterEach(() => {
    sinon.restore();
  });

  // -----------------------------------------------------------------------
  // getDialectFromUrl — additional branches
  // -----------------------------------------------------------------------

  describe('getDialectFromUrl()', () => {
    it('should create SQLite dialect with a host path', () => {
      const dialect = getDialectFromUrl(new URL('sqlite://testdata/some.db'));
      expect(dialect).toBeDefined();
    });

    it('should create SQLite in-memory dialect when no path is provided', () => {
      const dialect = getDialectFromUrl(new URL('sqlite://'));
      expect(dialect).toBeDefined();
    });

    it('should throw for an unknown protocol', () => {
      expect(() => getDialectFromUrl(new URL('ftp://localhost/data'))).toThrow('Unsupported database protocol');
    });
  });

  // -----------------------------------------------------------------------
  // getDwnConfig — SQL migrations and store creation branches
  // -----------------------------------------------------------------------

  describe('getDwnConfig()', () => {
    it('should create stores using sqlite backend and run migrations', async () => {
      const cfg = testConfig({
        dataStore          : 'sqlite://',
        messageStore       : 'sqlite://',
        resumableTaskStore : 'sqlite://',
      });

      const dwnConfig = await getDwnConfig(cfg, {});

      expect(dwnConfig.dataStore).toBeDefined();
      expect(dwnConfig.messageStore).toBeDefined();
      expect(dwnConfig.resumableTaskStore).toBeDefined();
    });

    it('should create stores using level backend', async () => {
      const cfg = testConfig({
        dataStore          : 'level://test-data-store',
        messageStore       : 'level://test-message-store',
        resumableTaskStore : 'level://test-task-store',
      });

      const dwnConfig = await getDwnConfig(cfg, {});

      expect(dwnConfig.dataStore).toBeDefined();
      expect(dwnConfig.messageStore).toBeDefined();
      expect(dwnConfig.resumableTaskStore).toBeDefined();
    });

    it('should throw for unknown storage protocol', async () => {
      const cfg = testConfig({
        dataStore          : 'redis://localhost:6379',
        messageStore       : 'sqlite://',
        resumableTaskStore : 'sqlite://',
      });

      await expect(getDwnConfig(cfg, {})).rejects.toThrow('Unknown storage protocol');
    });

    it('should load store from a file path (plugin loader)', async () => {
      // File-path-based stores go through PluginLoader.loadPlugin which
      // tries to dynamically import the path. We test that the file-path
      // detection works by passing a relative path that doesn't exist.
      const cfg = testConfig({
        dataStore: './nonexistent-plugin.js',
      });

      // This should fail during plugin loading, not during URL parsing.
      await expect(getDwnConfig(cfg, {})).rejects.toThrow();
    });

    it('should skip SQL migrations for level:// backend', async () => {
      // level:// stores don't need SQL migrations — the function should
      // detect the non-SQL protocol and skip without error.
      const cfg = testConfig({
        dataStore          : 'level://migration-skip-data',
        messageStore       : 'level://migration-skip-msg',
        resumableTaskStore : 'level://migration-skip-task',
      });

      // Should not throw.
      const dwnConfig = await getDwnConfig(cfg, {});
      expect(dwnConfig.dataStore).toBeDefined();
    });

    it('should skip SQL migrations for file path configs', async () => {
      // When the dataStore config is a file path, runSqlMigrationsIfNeeded
      // returns early. We exercise this path by providing a file path for
      // dataStore but valid SQL for the other stores.
      const cfg = testConfig({
        dataStore: './some-plugin.js',
      });

      // Will fail at plugin load, but the migration skip path is exercised.
      await expect(getDwnConfig(cfg, {})).rejects.toThrow();
    });

    it('should pass through didResolver, tenantGate, and eventLog', async () => {
      const fakeTenantGate = { isTenant: sinon.stub() } as any;
      const fakeEventLog = { open: sinon.stub() } as any;
      const fakeDidResolver = { resolve: sinon.stub() } as any;

      const cfg = testConfig();

      const dwnConfig = await getDwnConfig(cfg, {
        didResolver : fakeDidResolver,
        tenantGate  : fakeTenantGate,
        eventLog    : fakeEventLog,
      });

      expect(dwnConfig.didResolver).toBe(fakeDidResolver);
      expect(dwnConfig.tenantGate).toBe(fakeTenantGate);
      expect(dwnConfig.eventLog).toBe(fakeEventLog);
    });

    it('should create a durable event log when an event bus is provided', async () => {
      const cfg = testConfig();
      const eventBus = new InMemoryEventBus();

      const dwnConfig = await getDwnConfig(cfg, {
        eventBus,
        enableEventLog: true,
      });

      expect(dwnConfig.eventLog).toBeInstanceOf(DurableEventLog);
    });
  });

  // -----------------------------------------------------------------------
  // Shared Postgres dialect caching
  // -----------------------------------------------------------------------

  describe('Postgres dialect caching', () => {
    it('should create a PostgresDialect for postgres:// URL via getDialectFromUrl', () => {
      const dialect = getDialectFromUrl(new URL('postgres://user:pass@localhost:5432/testdb'));
      expect(dialect).toBeDefined();
    });

    it('should create a MysqlDialect for mysql:// URL', () => {
      const dialect = getDialectFromUrl(new URL('mysql://user:pass@localhost:3306/testdb'));
      expect(dialect).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // invalidStorageSchemeMessage
  // -----------------------------------------------------------------------

  describe('invalid storage scheme', () => {
    it('should include available backend types in error message', async () => {
      const cfg = testConfig({
        dataStore          : 'redis://localhost',
        messageStore       : 'sqlite://',
        resumableTaskStore : 'sqlite://',
      });

      try {
        await getDwnConfig(cfg, {});
        expect(true).toBe(false); // should not reach here
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        // The error message is a string from invalidStorageSchemeMessage.
        expect(msg).toContain('level');
        expect(msg).toContain('sqlite');
        expect(msg).toContain('mysql');
        expect(msg).toContain('postgres');
      }
    });
  });
});
