import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { DataStoreSql } from '../src/data-store-sql.js';
import { MessageStoreSql } from '../src/message-store-sql.js';
import { ResumableTaskStoreSql } from '../src/resumable-task-store-sql.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { StateIndexSql } from '../src/state-index-sql.js';
import { describe, expect, it } from 'bun:test';

/**
 * Tests the "db not open" error guard paths across all store classes.
 * Each store method should throw when called before open().
 */

const dialect = new SqliteDialect({
  database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> =>
    createBunSqliteDatabase(':memory:', { create: true }),
});

describe('Store guards — db not open', () => {

  // ─── MessageStoreSql ──────────────────────────────────────────────────

  describe('MessageStoreSql', () => {
    const store = new MessageStoreSql(dialect);

    it('should throw on put() without open()', async () => {
      const message = { descriptor: { interface: 'Records', method: 'Write' } } as any;
      await expect(store.put('tenant', message, {})).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on get() without open()', async () => {
      await expect(store.get('tenant', 'cid-1')).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on query() without open()', async () => {
      await expect(store.query('tenant', [{}])).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on count() without open()', async () => {
      await expect(store.count('tenant', [{}])).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on delete() without open()', async () => {
      await expect(store.delete('tenant', 'cid-1')).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on clear() without open()', async () => {
      await expect(store.clear()).rejects.toThrow(
        'Connection to database not open'
      );
    });
  });

  // ─── DataStoreSql ─────────────────────────────────────────────────────

  describe('DataStoreSql', () => {
    const store = new DataStoreSql(dialect);

    it('should throw on get() without open()', async () => {
      await expect(store.get('tenant', 'record-1', 'cid-1')).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on put() without open()', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      await expect(store.put('tenant', 'record-1', 'cid-1', stream)).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on delete() without open()', async () => {
      await expect(store.delete('tenant', 'record-1', 'cid-1')).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on clear() without open()', async () => {
      await expect(store.clear()).rejects.toThrow(
        'Connection to database not open'
      );
    });
  });

  // ─── StateIndexSql ────────────────────────────────────────────────────

  describe('StateIndexSql', () => {
    const store = new StateIndexSql(dialect);

    it('should throw on insert() without open()', async () => {
      await expect(store.insert('tenant', 'cid-1', {})).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on delete() without open()', async () => {
      await expect(store.delete('tenant', ['cid-1'])).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on clear() without open()', async () => {
      await expect(store.clear()).rejects.toThrow(
        'Connection to database not open'
      );
    });
  });

  // ─── ResumableTaskStoreSql ────────────────────────────────────────────

  describe('ResumableTaskStoreSql', () => {
    const store = new ResumableTaskStoreSql(dialect);

    it('should throw on register() without open()', async () => {
      await expect(store.register({ type: 'test' }, 60)).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on grab() without open()', async () => {
      await expect(store.grab(5)).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on read() without open()', async () => {
      await expect(store.read('task-1')).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on extend() without open()', async () => {
      await expect(store.extend('task-1', 120)).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on delete() without open()', async () => {
      await expect(store.delete('task-1')).rejects.toThrow(
        'Connection to database not open'
      );
    });

    it('should throw on clear() without open()', async () => {
      await expect(store.clear()).rejects.toThrow(
        'Connection to database not open'
      );
    });
  });
});
