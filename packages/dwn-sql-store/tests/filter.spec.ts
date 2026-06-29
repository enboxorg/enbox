import type { DwnDatabaseType } from '../src/types.js';
import type { Filter } from '@enbox/dwn-sdk-js';

import { createBunSqliteDatabase } from '../src/dialect/bun-sqlite-adapter.js';
import { filterSelectQuery } from '../src/utils/filter.js';
import { Kysely } from 'kysely';
import { SqliteDialect } from '../src/dialect/sqlite-dialect.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('filterSelectQuery', () => {
  const dialect = new SqliteDialect({
    database: async (): Promise<ReturnType<typeof createBunSqliteDatabase>> =>
      createBunSqliteDatabase(':memory:', { create: true }),
  });

  let db: Kysely<DwnDatabaseType>;

  beforeAll(async () => {
    db = new Kysely<DwnDatabaseType>({ dialect });

    // Create a test table that has the messageStoreMessages schema plus tag table for join.
    await db.schema
      .createTable('messageStoreMessages')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
      .addColumn('messageCid', 'varchar(60)', (col) => col.notNull())
      .addColumn('encodedMessageBytes', 'blob', (col) => col.notNull())
      .addColumn('encodedData', 'text')
      .addColumn('interface', 'varchar(20)')
      .addColumn('method', 'varchar(20)')
      .addColumn('recordId', 'varchar(60)')
      .addColumn('protocol', 'varchar(200)')
      .addColumn('protocolPath', 'varchar(200)')
      .addColumn('schema', 'varchar(200)')
      .addColumn('author', 'varchar(255)')
      .addColumn('messageTimestamp', 'varchar(30)')
      .addColumn('dateCreated', 'varchar(30)')
      .addColumn('dataFormat', 'varchar(30)')
      .addColumn('contextId', 'varchar(600)')
      .execute();

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
  });

  beforeEach(async () => {
    await db.deleteFrom('messageStoreMessages').execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  /**
   * Helper: insert a message row and return its auto-generated id.
   */
  async function insertMessage(values: {
    tenant: string;
    messageCid: string;
    interface?: string;
    method?: string;
    protocol?: string;
    author?: string;
    dataFormat?: string;
    messageTimestamp?: string;
    dateCreated?: string;
    contextId?: string;
  }): Promise<number> {
    const result = await db
      .insertInto('messageStoreMessages')
      .values({
        tenant              : values.tenant,
        messageCid          : values.messageCid,
        encodedMessageBytes : Buffer.from('test'),
        encodedData         : null,
        interface           : values.interface ?? null,
        method              : values.method ?? null,
        protocol            : values.protocol ?? null,
        author              : values.author ?? null,
        dataFormat          : values.dataFormat ?? null,
        messageTimestamp    : values.messageTimestamp ?? null,
        dateCreated         : values.dateCreated ?? null,
        contextId           : values.contextId ?? null,
      })
      .returning('id as insertId')
      .executeTakeFirstOrThrow();

    return (result as any).insertId;
  }

  /**
   * Helper: insert a tag row.
   */
  async function insertTag(messageInsertId: number, tag: string, valueString?: string, valueNumber?: number): Promise<void> {
    await db
      .insertInto('messageStoreRecordsTags')
      .values({
        messageInsertId,
        tag,
        valueString : valueString ?? null,
        valueNumber : valueNumber ?? null,
      })
      .execute();
  }

  // ─── EqualFilter ──────────────────────────────────────────────────────

  describe('EqualFilter', () => {
    it('should filter by exact string match', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', protocol: 'proto-a' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', protocol: 'proto-b' });

      const filters: Filter[] = [{ protocol: 'proto-a' }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(1);
      expect(results[0].messageCid).toBe('cid-1');
    });
  });

  // ─── OneOfFilter ──────────────────────────────────────────────────────

  describe('OneOfFilter', () => {
    it('should filter by array of values (IN clause)', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', method: 'Write' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', method: 'Read' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-3', method: 'Delete' });

      const filters: Filter[] = [{ method: ['Write', 'Delete'] }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(2);
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-1', 'cid-3']);
    });
  });

  // ─── RangeFilter ──────────────────────────────────────────────────────

  describe('RangeFilter', () => {
    it('should filter with gt (greater than)', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', dateCreated: '2024-01-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', dateCreated: '2024-06-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-3', dateCreated: '2024-12-01' });

      const filters: Filter[] = [{ dateCreated: { gt: '2024-06-01' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(1);
      expect(results[0].messageCid).toBe('cid-3');
    });

    it('should filter with gte (greater than or equal)', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', dateCreated: '2024-01-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', dateCreated: '2024-06-01' });

      const filters: Filter[] = [{ dateCreated: { gte: '2024-06-01' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(1);
      expect(results[0].messageCid).toBe('cid-2');
    });

    it('should filter with lt (less than)', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', dateCreated: '2024-01-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', dateCreated: '2024-12-01' });

      const filters: Filter[] = [{ dateCreated: { lt: '2024-06-01' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(1);
      expect(results[0].messageCid).toBe('cid-1');
    });

    it('should filter with lte (less than or equal)', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', dateCreated: '2024-01-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', dateCreated: '2024-06-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-3', dateCreated: '2024-12-01' });

      const filters: Filter[] = [{ dateCreated: { lte: '2024-06-01' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(2);
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-1', 'cid-2']);
    });
  });

  // ─── PrefixRangeFilter (collation-safe LIKE) ───────────────────────────

  describe('PrefixRangeFilter (contextId prefix matching)', () => {
    it('should match records whose contextId starts with the given prefix', async () => {
      // Simulate a nested protocol: root record `bafkA` with children `bafkA/bafkB` and `bafkA/bafkC`
      const rootContextId = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const childContextId1 = rootContextId + '/bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const childContextId2 = rootContextId + '/bafkreicccccccccccccccccccccccccccccccccccccccccccccccccc';
      const unrelatedContextId = 'bafkreidddddddddddddddddddddddddddddddddddddddddddddddddd/bafkreieeee';

      await insertMessage({ tenant: 't1', messageCid: 'cid-root', contextId: rootContextId });
      await insertMessage({ tenant: 't1', messageCid: 'cid-child-1', contextId: childContextId1 });
      await insertMessage({ tenant: 't1', messageCid: 'cid-child-2', contextId: childContextId2 });
      await insertMessage({ tenant: 't1', messageCid: 'cid-unrelated', contextId: unrelatedContextId });

      // This is the exact filter shape produced by constructPrefixFilterAsRangeFilter
      const filters: Filter[] = [{ contextId: { gte: rootContextId, lt: rootContextId + '\uffff' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(3); // root + 2 children
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-child-1', 'cid-child-2', 'cid-root']);
    });

    it('should match prefix filters with literal LIKE metacharacters', async () => {
      const rootContextId = 'ctx%_root';
      const childContextId = rootContextId + '/child';
      const wildcardLookalike = 'ctxAAroot/child';

      await insertMessage({ tenant: 't1', messageCid: 'cid-root', contextId: rootContextId });
      await insertMessage({ tenant: 't1', messageCid: 'cid-child', contextId: childContextId });
      await insertMessage({ tenant: 't1', messageCid: 'cid-lookalike', contextId: wildcardLookalike });

      const filters: Filter[] = [{ contextId: { gte: rootContextId, lt: rootContextId + '\uffff' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-child', 'cid-root']);
    });

    it('should NOT convert a range filter that does not use the \\uffff sentinel', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', dateCreated: '2024-01-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', dateCreated: '2024-06-01' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-3', dateCreated: '2024-12-01' });

      // Normal range filter (not a prefix filter) — should still work as gte + lt
      const filters: Filter[] = [{ dateCreated: { gte: '2024-01-01', lt: '2024-12-01' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(2);
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-1', 'cid-2']);
    });
  });

  // ─── Multiple filters (OR combination) ────────────────────────────────

  describe('multiple filters (OR)', () => {
    it('should combine multiple filters as OR', async () => {
      await insertMessage({ tenant: 't1', messageCid: 'cid-1', protocol: 'proto-a', method: 'Write' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-2', protocol: 'proto-b', method: 'Read' });
      await insertMessage({ tenant: 't1', messageCid: 'cid-3', protocol: 'proto-c', method: 'Delete' });

      // Filter 1: protocol = proto-a, Filter 2: method = Delete => OR => cid-1 and cid-3
      const filters: Filter[] = [
        { protocol: 'proto-a' },
        { method: 'Delete' },
      ];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(2);
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-1', 'cid-3']);
    });
  });

  // ─── processTags — number vs string ───────────────────────────────────

  describe('processTags', () => {
    it('should filter tags with string values', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });

      await insertTag(id1, 'color', 'red');
      await insertTag(id2, 'color', 'blue');

      const filters: Filter[] = [{ 'tag.color': 'red' }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(1);
      expect(results[0].messageCid).toBe('cid-1');
    });

    it('should filter tags with number values', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });

      await insertTag(id1, 'priority', undefined, 10);
      await insertTag(id2, 'priority', undefined, 20);

      const filters: Filter[] = [{ 'tag.priority': 10 }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(1);
      expect(results[0].messageCid).toBe('cid-1');
    });

    it('should require all tag predicates to match the same message', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });
      const id3 = await insertMessage({ tenant: 't1', messageCid: 'cid-3' });

      await insertTag(id1, 'protocol', 'https://example.com/chat');
      await insertTag(id1, 'contextId', 'thread1');
      await insertTag(id1, 'role', 'thread/participant');
      await insertTag(id1, 'epoch', undefined, 1);
      await insertTag(id1, 'keyId', 'key1');

      await insertTag(id2, 'protocol', 'https://example.com/chat');
      await insertTag(id2, 'contextId', 'thread1');
      await insertTag(id2, 'role', 'thread/moderator');
      await insertTag(id2, 'epoch', undefined, 1);
      await insertTag(id2, 'keyId', 'key1');

      await insertTag(id3, 'protocol', 'https://example.com/chat');
      await insertTag(id3, 'contextId', 'thread2');
      await insertTag(id3, 'role', 'thread/participant');
      await insertTag(id3, 'epoch', undefined, 1);
      await insertTag(id3, 'keyId', 'key1');

      const filters: Filter[] = [{
        'tag.contextId' : 'thread1',
        'tag.epoch'     : 1,
        'tag.keyId'     : 'key1',
        'tag.protocol'  : 'https://example.com/chat',
        'tag.role'      : 'thread/participant',
      }];

      let query = db
        .selectFrom('messageStoreMessages')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results).toEqual([{ messageCid: 'cid-1' }]);
    });

    it('should filter tags with range operators on numbers', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });
      const id3 = await insertMessage({ tenant: 't1', messageCid: 'cid-3' });

      await insertTag(id1, 'score', undefined, 5);
      await insertTag(id2, 'score', undefined, 15);
      await insertTag(id3, 'score', undefined, 25);

      const filters: Filter[] = [{ 'tag.score': { gt: 10, lte: 25 } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(2);
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-2', 'cid-3']);
    });

    it('should filter tags with range operators on strings', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });
      const id3 = await insertMessage({ tenant: 't1', messageCid: 'cid-3' });

      await insertTag(id1, 'version', 'v1.0');
      await insertTag(id2, 'version', 'v2.0');
      await insertTag(id3, 'version', 'v3.0');

      const filters: Filter[] = [{ 'tag.version': { gte: 'v2.0', lt: 'v3.0' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(1);
      expect(results[0].messageCid).toBe('cid-2');
    });

    it('should filter tag prefix ranges with literal LIKE metacharacters', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });
      const id3 = await insertMessage({ tenant: 't1', messageCid: 'cid-3' });

      await insertTag(id1, 'keyId', 'kid%_root');
      await insertTag(id2, 'keyId', 'kid%_root/child');
      await insertTag(id3, 'keyId', 'kidAAroot/child');

      const filters: Filter[] = [{ 'tag.keyId': { gte: 'kid%_root', lt: 'kid%_root' + '\uffff' } }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-1', 'cid-2']);
    });

    it('should filter tags with OneOfFilter containing numbers', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });
      const id3 = await insertMessage({ tenant: 't1', messageCid: 'cid-3' });

      await insertTag(id1, 'level', undefined, 1);
      await insertTag(id2, 'level', undefined, 2);
      await insertTag(id3, 'level', undefined, 3);

      const filters: Filter[] = [{ 'tag.level': [1, 3] }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(2);
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-1', 'cid-3']);
    });

    it('should filter tags with OneOfFilter containing strings', async () => {
      const id1 = await insertMessage({ tenant: 't1', messageCid: 'cid-1' });
      const id2 = await insertMessage({ tenant: 't1', messageCid: 'cid-2' });
      const id3 = await insertMessage({ tenant: 't1', messageCid: 'cid-3' });

      await insertTag(id1, 'status', 'active');
      await insertTag(id2, 'status', 'inactive');
      await insertTag(id3, 'status', 'pending');

      const filters: Filter[] = [{ 'tag.status': ['active', 'pending'] }];

      let query = db
        .selectFrom('messageStoreMessages')
        .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
        .select('messageCid')
        .distinct()
        .where('tenant', '=', 't1');

      query = filterSelectQuery(filters, query);
      const results = await query.execute();

      expect(results.length).toBe(2);
      const cids = results.map((r) => r.messageCid).sort();
      expect(cids).toEqual(['cid-1', 'cid-3']);
    });
  });
});
