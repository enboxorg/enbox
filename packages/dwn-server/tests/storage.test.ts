import { describe, expect, it } from 'bun:test';

import { BackendTypes, getDialectFromUrl } from '../src/storage.js';

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
});
