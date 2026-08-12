import { createPool } from 'mysql2';
import { MysqlDialect } from '@enbox/dwn-sql-store';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';

import { createMigratedInMemoryDialect } from '../utils.js';
import { migration002WidenCacheValues } from '../../src/migrations/002-widen-cache-values.js';
import { SqlTtlCache } from '../../src/connect/sql-ttl-cache.js';

const MAX_CONNECT_FRAME_BYTES = 256 * 1024;

describe('SqlTtlCache', () => {
  let cache: SqlTtlCache;

  beforeAll(async () => {
    const dialect = await createMigratedInMemoryDialect();
    cache = await SqlTtlCache.create(dialect);
  });

  afterAll(async () => {
    // Clean up any remaining entries.
    await cache.cleanUpExpiredEntries();
  });

  describe('create()', () => {
    it('should create a SqlTtlCache instance via static factory', async () => {
      const dialect = await createMigratedInMemoryDialect();
      const instance = await SqlTtlCache.create(dialect);
      expect(instance).toBeInstanceOf(SqlTtlCache);
    });
  });

  describe('insert() and get()', () => {
    it('should store and retrieve a value by key', async () => {
      const key = 'test-key-insert';
      const value = { hello: 'world', nested: { num: 42 } };

      await cache.insert(key, value, 60);
      const result = await cache.get(key);

      expect(result).toEqual(value);

      // Clean up.
      await cache.delete(key);
    });

    it('should return undefined for a non-existent key', async () => {
      const result = await cache.get('does-not-exist');
      expect(result).toBeUndefined();
    });

    it('should allow only one concurrent insert for the same key', async () => {
      const key = 'test-key-insert-once';
      const results = await Promise.all([
        cache.insertIfAbsent(key, { claimant: 'first' }, 60),
        cache.insertIfAbsent(key, { claimant: 'second' }, 60),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await cache.get(key)).toEqual(results[0] ? { claimant: 'first' } : { claimant: 'second' });
      await cache.delete(key);
    });

    it('should replace an expired entry', async () => {
      const key = 'test-key-expired-insert-once';
      await cache.insert(key, { value: 'expired' }, 0);

      expect(await cache.insertIfAbsent(key, { value: 'current' }, 60)).toBe(true);
      expect(await cache.get(key)).toEqual({ value: 'current' });
      await cache.delete(key);
    });
  });

  describe('delete()', () => {
    it('should delete an entry and verify it is gone', async () => {
      const key = 'test-key-delete';
      await cache.insert(key, { data: 'to-delete' }, 60);

      // Verify it exists first.
      const before = await cache.get(key);
      expect(before).toEqual({ data: 'to-delete' });

      // Delete and verify.
      await cache.delete(key);
      const after = await cache.get(key);
      expect(after).toBeUndefined();
    });

    it('should not throw when deleting a non-existent key', async () => {
      await expect(cache.delete('non-existent-key')).resolves.toBeUndefined();
    });
  });

  describe('cleanUpExpiredEntries()', () => {
    it('should clear all expired entries', async () => {
      // Insert an already-expired entry (TTL of 0 seconds means it expires immediately).
      const key = 'test-key-expired-cleanup';
      await cache.insert(key, { expired: true }, 0);

      // Wait briefly for the expiry timestamp to be in the past.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 10));

      await cache.cleanUpExpiredEntries();

      const result = await cache.get(key);
      expect(result).toBeUndefined();
    });
  });

  describe('TTL expiration', () => {
    it('should return undefined for an expired entry', async () => {
      const key = 'test-key-ttl-expired';
      // Use a TTL of 0 seconds — entry expires at insertion time.
      await cache.insert(key, { shouldExpire: true }, 0);

      // Wait briefly for Date.now() to advance past the expiry.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 10));

      const result = await cache.get(key);
      expect(result).toBeUndefined();
    });

    it('should return the value when TTL has not expired', async () => {
      const key = 'test-key-ttl-valid';
      await cache.insert(key, { valid: true }, 300);

      const result = await cache.get(key);
      expect(result).toEqual({ valid: true });

      // Clean up.
      await cache.delete(key);
    });
  });
});

it.skipIf(process.env.ENBOX_TEST_MYSQL !== '1')(
  'stores a maximum-sized Connect frame in MySQL',
  async () => {
    const pool = createPool({
      host     : process.env.MYSQL_HOST ?? 'localhost',
      port     : Number(process.env.MYSQL_PORT ?? 3306),
      database : process.env.MYSQL_DATABASE ?? 'dwn',
      user     : process.env.MYSQL_USER ?? 'root',
      password : process.env.MYSQL_PASSWORD ?? 'dwn',
    });
    const dialect = new MysqlDialect({ pool: async (): Promise<typeof pool> => pool });
    const db = new Kysely<Record<string, unknown>>({ dialect });
    let mysqlCache: SqlTtlCache | undefined;

    try {
      await db.schema
        .createTable('cacheEntries')
        .ifNotExists()
        .addColumn('key', 'varchar(512)', (col) => col.primaryKey())
        .addColumn('value', 'text', (col) => col.notNull())
        .addColumn('expiry', 'bigint', (col) => col.notNull())
        .execute();
      await migration002WidenCacheValues(dialect).up(db);

      const column = await sql<{ dataType: string }>`
        SELECT DATA_TYPE AS dataType
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'cacheEntries'
          AND COLUMN_NAME = 'value'
      `.execute(db);
      expect(column.rows[0]?.dataType).toBe('mediumtext');

      mysqlCache = await SqlTtlCache.create(dialect);
      const key = `connect-frame-${crypto.randomUUID()}`;
      const value = { frame: 'x'.repeat(MAX_CONNECT_FRAME_BYTES) };

      await mysqlCache.insert(key, value, 60);
      expect(await mysqlCache.get(key)).toEqual(value);
      await mysqlCache.delete(key);
    } finally {
      mysqlCache?.close();
      await db.destroy();
    }
  },
  30_000,
);
