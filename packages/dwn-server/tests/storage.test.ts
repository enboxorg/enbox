import { describe, expect, it } from 'bun:test';

import { BackendTypes, getDialectFromUrl, makePostgresPoolEndIdempotent } from '../src/storage.js';

describe('storage', () => {
  describe('getDialectFromUrl()', () => {
    it.each([
      ['SqliteDialect', 'sqlite://'],
      ['MysqlDialect', 'mysql://user:pass@localhost:3306/db'],
      ['PostgresDialect', 'postgres://user:pass@localhost:5432/db'],
    ] as const)('should return a %s for its URL scheme', (_name, url) => {
      const dialect = getDialectFromUrl(new URL(url));
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

  describe('makePostgresPoolEndIdempotent()', () => {
    it('should share one shutdown across concurrent Kysely-style callers', async () => {
      let endCalls = 0;
      let releaseEnd!: () => void;
      const ending = new Promise<void>((resolve): void => {
        releaseEnd = resolve;
      });
      const fakePool = {
        end: (): Promise<void> => {
          endCalls++;
          return ending;
        },
      };

      makePostgresPoolEndIdempotent(fakePool);
      const first = fakePool.end();
      const second = fakePool.end();

      expect(first).toBe(second);
      expect(endCalls).toBe(1);
      releaseEnd();
      await Promise.all([first, second]);
    });

    it('should evict before ending and memoize a rejected shutdown', async () => {
      const order: string[] = [];
      const failure = new Error('shutdown failed');
      const fakePool = {
        end: (): Promise<void> => {
          order.push('end');
          return Promise.reject(failure);
        },
      };
      makePostgresPoolEndIdempotent(fakePool, (): void => {
        order.push('evict');
      });

      const first = fakePool.end();
      expect(order).toEqual(['evict', 'end']);
      await expect(first).rejects.toBe(failure);
      await expect(fakePool.end()).rejects.toBe(failure);
      expect(order).toEqual(['evict', 'end']);
    });
  });
});
