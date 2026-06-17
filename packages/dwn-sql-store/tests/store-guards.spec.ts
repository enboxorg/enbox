import type { DwnDatabaseType } from '../src/types.js';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { DataStoreS3 } from '../src/data-store-s3.js';
import { DataStoreSql } from '../src/data-store-sql.js';
import { Kysely } from 'kysely';
import { MessageStoreSql } from '../src/message-store-sql.js';
import { ResumableTaskStoreSql } from '../src/resumable-task-store-sql.js';
import { runDwnStoreMigrations } from '../src/migration-runner.js';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
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

    it('should be idempotent — calling open() twice does not throw', async () => {
      // Use a shared in-memory database so migrations and the store see the same tables.
      const sharedDb = createBunSqliteDatabase(':memory:', { create: true });
      const freshDialect = new SqliteDialect({
        database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> => sharedDb,
      });
      const db = new Kysely<DwnDatabaseType>({ dialect: freshDialect });
      await runDwnStoreMigrations(db, freshDialect);

      const freshStore = new DataStoreSql(freshDialect);
      await freshStore.open();
      await freshStore.open(); // second call should be a no-op
      await freshStore.close();
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

  // ─── DataStoreS3 ──────────────────────────────────────────────────────

  describe('DataStoreS3', () => {
    const createStore = (config: { partSize?: number; queueSize?: number } = {}): DataStoreS3 => new DataStoreS3({
      dialect  : dialect,
      bucket   : 'test-bucket',
      s3Client : {} as any,
      ...config,
    });

    // Construct with a stub S3Client — the guard fires before any S3 call.
    const store = createStore();

    it('should reject partSize values below the multipart minimum', () => {
      const invalidPartSizes = [0, -1, 1, 5 * 1024 * 1024 - 1, 5 * 1024 * 1024 + 0.5];

      for (const partSize of invalidPartSizes) {
        expect(() => createStore({ partSize })).toThrow('DataStoreS3: partSize must be at least 5 MiB.');
      }

      expect(() => createStore({ partSize: 5 * 1024 * 1024 })).not.toThrow();
    });

    it('should reject invalid queueSize values', () => {
      const invalidQueueSizes = [0, -1, 1.5, Number.NaN];

      for (const queueSize of invalidQueueSizes) {
        expect(() => createStore({ queueSize })).toThrow('DataStoreS3: queueSize must be a positive integer.');
      }

      expect(() => createStore({ queueSize: 1 })).not.toThrow();
    });

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
});
