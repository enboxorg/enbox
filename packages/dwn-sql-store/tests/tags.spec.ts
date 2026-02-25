import type { DwnDatabaseType } from '../src/types.js';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { Kysely } from 'kysely';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { TagTables } from '../src/utils/tags.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('TagTables', () => {
  const dialect = new SqliteDialect({
    database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> =>
      createBunSqliteDatabase(':memory:', { create: true }),
  });

  let db: Kysely<DwnDatabaseType>;
  let tagTables: TagTables;

  beforeAll(async () => {
    db = new Kysely<DwnDatabaseType>({ dialect });

    // Create the parent messageStoreMessages table (needed for FK reference).
    await db.schema
      .createTable('messageStoreMessages')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
      .addColumn('messageCid', 'varchar(60)', (col) => col.notNull())
      .addColumn('encodedMessageBytes', 'blob', (col) => col.notNull())
      .addColumn('encodedData', 'text')
      .execute();

    // Create the tags table matching the schema from MessageStoreSql.
    await db.schema
      .createTable('messageStoreRecordsTags')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('tag', 'varchar(30)', (col) => col.notNull())
      .addColumn('valueString', 'varchar(200)')
      .addColumn('valueNumber', 'decimal')
      .addColumn('messageInsertId', 'integer', (col) =>
        col.notNull().references('messageStoreMessages.id').onDelete('cascade')
      )
      .execute();

    tagTables = new TagTables(dialect);
  });

  beforeEach(async () => {
    await db.deleteFrom('messageStoreMessages').execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  /**
   * Helper: insert a parent message row and return its auto-generated id.
   */
  async function insertParentMessage(): Promise<number> {
    const result = await db
      .insertInto('messageStoreMessages')
      .values({
        tenant              : 'did:example:test',
        messageCid          : `cid-${Date.now()}`,
        encodedMessageBytes : Buffer.from('test'),
        encodedData         : null,
      })
      .returning('id as insertId')
      .executeTakeFirstOrThrow();

    return (result as any).insertId;
  }

  // ─── executeTagsInsert with string values ─────────────────────────────

  describe('executeTagsInsert()', () => {
    it('should insert string tag values', async () => {
      const parentId = await insertParentMessage();

      await db.transaction().execute(async (tx) => {
        await tagTables.executeTagsInsert(parentId, { color: 'red', shape: 'circle' }, tx);
      });

      const rows = await db
        .selectFrom('messageStoreRecordsTags')
        .selectAll()
        .where('messageInsertId', '=', parentId)
        .execute();

      expect(rows.length).toBe(2);

      const colorRow = rows.find((r) => r.tag === 'color');
      expect(colorRow).toBeDefined();
      expect(colorRow!.valueString).toBe('red');
      expect(colorRow!.valueNumber).toBeNull();

      const shapeRow = rows.find((r) => r.tag === 'shape');
      expect(shapeRow).toBeDefined();
      expect(shapeRow!.valueString).toBe('circle');
      expect(shapeRow!.valueNumber).toBeNull();
    });

    // ─── executeTagsInsert with number values ─────────────────────────

    it('should insert number tag values', async () => {
      const parentId = await insertParentMessage();

      await db.transaction().execute(async (tx) => {
        await tagTables.executeTagsInsert(parentId, { priority: 10, score: 99.5 }, tx);
      });

      const rows = await db
        .selectFrom('messageStoreRecordsTags')
        .selectAll()
        .where('messageInsertId', '=', parentId)
        .execute();

      expect(rows.length).toBe(2);

      const priorityRow = rows.find((r) => r.tag === 'priority');
      expect(priorityRow).toBeDefined();
      expect(priorityRow!.valueNumber).toBe(10);
      expect(priorityRow!.valueString).toBeNull();

      const scoreRow = rows.find((r) => r.tag === 'score');
      expect(scoreRow).toBeDefined();
      expect(scoreRow!.valueNumber).toBe(99.5);
      expect(scoreRow!.valueString).toBeNull();
    });

    // ─── executeTagsInsert with array-valued tags ─────────────────────

    it('should insert array-valued tags as separate rows', async () => {
      const parentId = await insertParentMessage();

      await db.transaction().execute(async (tx) => {
        await tagTables.executeTagsInsert(parentId, { colors: ['red', 'blue', 'green'] }, tx);
      });

      const rows = await db
        .selectFrom('messageStoreRecordsTags')
        .selectAll()
        .where('messageInsertId', '=', parentId)
        .execute();

      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.tag === 'colors')).toBe(true);

      const values = rows.map((r) => r.valueString).sort();
      expect(values).toEqual(['blue', 'green', 'red']);
    });

    it('should insert array-valued tags with mixed numbers', async () => {
      const parentId = await insertParentMessage();

      await db.transaction().execute(async (tx) => {
        await tagTables.executeTagsInsert(parentId, { levels: [1, 2, 3] }, tx);
      });

      const rows = await db
        .selectFrom('messageStoreRecordsTags')
        .selectAll()
        .where('messageInsertId', '=', parentId)
        .execute();

      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.tag === 'levels')).toBe(true);

      const values = rows.map((r) => r.valueNumber).sort();
      expect(values).toEqual([1, 2, 3]);
    });

    it('should handle boolean tag values by converting them to numbers', async () => {
      const parentId = await insertParentMessage();

      await db.transaction().execute(async (tx) => {
        await tagTables.executeTagsInsert(parentId, { active: true, deleted: false }, tx);
      });

      const rows = await db
        .selectFrom('messageStoreRecordsTags')
        .selectAll()
        .where('messageInsertId', '=', parentId)
        .execute();

      expect(rows.length).toBe(2);

      const activeRow = rows.find((r) => r.tag === 'active');
      expect(activeRow).toBeDefined();
      expect(activeRow!.valueNumber).toBe(1);
      expect(activeRow!.valueString).toBeNull();

      const deletedRow = rows.find((r) => r.tag === 'deleted');
      expect(deletedRow).toBeDefined();
      expect(deletedRow!.valueNumber).toBe(0);
      expect(deletedRow!.valueString).toBeNull();
    });

    it('should handle empty tags object without inserting anything', async () => {
      const parentId = await insertParentMessage();

      await db.transaction().execute(async (tx) => {
        await tagTables.executeTagsInsert(parentId, {}, tx);
      });

      const rows = await db
        .selectFrom('messageStoreRecordsTags')
        .selectAll()
        .where('messageInsertId', '=', parentId)
        .execute();

      expect(rows.length).toBe(0);
    });
  });
});
