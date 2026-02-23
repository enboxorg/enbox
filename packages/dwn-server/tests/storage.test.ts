import { describe, expect, it } from 'bun:test';

import { BackendTypes, getDialectFromUrl } from '../src/storage.js';

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

    it('should return undefined for an unsupported protocol', () => {
      const dialect = getDialectFromUrl(new URL('redis://localhost:6379'));
      expect(dialect).toBeUndefined();
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
