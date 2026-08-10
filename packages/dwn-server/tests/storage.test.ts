import { describe, expect, it } from 'bun:test';

import { BackendTypes, createCloseOncePool, getDialectFromUrl } from '../src/storage.js';

type FakePool = Parameters<typeof createCloseOncePool>[0];

describe('storage', () => {
  describe('getDialectFromUrl()', () => {
    it('should return a SqliteDialect for a sqlite:// URL', () => {
      const dialect = getDialectFromUrl(new URL('sqlite://'));
      expect(dialect).toBeDefined();
    });

    it('should return a MysqlDialect for a mysql:// URL', () => {
      const dialect = getDialectFromUrl(new URL('mysql://user:pass@localhost:3306/db'));
      expect(dialect).toBeDefined();
    });

    it('should return a PostgresDialect for a postgres:// URL', () => {
      const dialect = getDialectFromUrl(new URL('postgres://user:pass@localhost:5432/db'));
      expect(dialect).toBeDefined();
    });

    it('should throw for an unsupported protocol', () => {
      expect(() => getDialectFromUrl(new URL('redis://localhost:6379'))).toThrow('Unsupported database protocol');
    });
  });

  describe('BackendTypes', () => {
    it('should have the expected enum values', () => {
      expect(BackendTypes.LEVEL).toBe('level');
      expect(BackendTypes.SQLITE).toBe('sqlite');
      expect(BackendTypes.MYSQL).toBe('mysql');
      expect(BackendTypes.POSTGRES).toBe('postgres');
    });
  });

  describe('createCloseOncePool()', () => {
    it('should end the underlying pool exactly once and share the completion', async () => {
      let endCalls = 0;
      const fakePool = {
        connect : async (): Promise<string> => 'client',
        end     : async (): Promise<void> => {
          endCalls += 1;
        },
      } as unknown as FakePool;

      const pool = createCloseOncePool(fakePool);
      await Promise.all([pool.end(), pool.end()]);
      await pool.end();

      expect(endCalls).toBe(1);
      // Non-end members still delegate to the underlying pool.
      expect(await (pool as unknown as { connect(): Promise<string> }).connect()).toBe('client');
    });

    it('should invoke onFirstEnd exactly once before ending', async () => {
      const order: string[] = [];
      const fakePool = {
        end: async (): Promise<void> => {
          order.push('end');
        },
      } as unknown as FakePool;

      const pool = createCloseOncePool(fakePool, (): void => {
        order.push('evict');
      });
      await pool.end();
      await pool.end();

      expect(order).toEqual(['evict', 'end']);
    });
  });
});
