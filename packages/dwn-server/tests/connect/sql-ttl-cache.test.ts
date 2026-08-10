import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { createMigratedInMemoryDialect } from '../utils.js';
import { SqlTtlCache } from '../../src/connect/sql-ttl-cache.js';

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
