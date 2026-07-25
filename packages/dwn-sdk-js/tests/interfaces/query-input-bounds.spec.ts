import type { MessagesFilter, Persona, RecordsFilter } from '../../src/index.js';

import { beforeAll, describe, expect, it } from 'bun:test';

import { DwnConstant } from '../../src/core/dwn-constant.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';

describe('query input bounds', () => {
  let author: Persona;

  const grantIdsAtLimit = Array.from(
    { length: DwnConstant.maxFilterValues },
    (_, index) => `grant-${index}`,
  );
  const messageFiltersAtLimit: MessagesFilter[] = Array.from(
    { length: DwnConstant.maxFilterValues },
    (_, index) => ({ protocol: `https://example.com/protocol/${index}` }),
  );
  const didsAtLimit = Array.from(
    { length: DwnConstant.maxFilterValues },
    (_, index) => `did:example:query-${index}`,
  );
  const tagsAtLimit = Object.fromEntries(
    Array.from({ length: DwnConstant.maxFilterValues }, (_, index) => [`tag${index}`, index]),
  );

  beforeAll(async () => {
    author = await TestDataGenerator.generateDidKeyPersona();
  });

  it('accepts bounded Records pages and rejects fractional or oversized limits', async () => {
    const query = await TestDataGenerator.generateRecordsQuery({
      author,
      filter     : { schema: 'https://example.com/schema' },
      pagination : { limit: DwnConstant.maxQueryPageSize },
    });
    expect(query.message.descriptor.pagination?.limit).toBe(DwnConstant.maxQueryPageSize);

    const subscribe = await TestDataGenerator.generateRecordsSubscribe({
      author,
      filter     : { schema: 'https://example.com/schema' },
      pagination : { limit: DwnConstant.maxQueryPageSize },
    });
    expect(subscribe.message.descriptor.pagination?.limit).toBe(DwnConstant.maxQueryPageSize);

    await expect(TestDataGenerator.generateRecordsQuery({
      author,
      filter     : { schema: 'https://example.com/schema' },
      pagination : { limit: DwnConstant.maxQueryPageSize + 1 },
    })).rejects.toThrow();
    await expect(TestDataGenerator.generateRecordsSubscribe({
      author,
      filter     : { schema: 'https://example.com/schema' },
      pagination : { limit: DwnConstant.maxQueryPageSize + 1 },
    })).rejects.toThrow();
    await expect(TestDataGenerator.generateRecordsQuery({
      author,
      filter     : { schema: 'https://example.com/schema' },
      pagination : { limit: 1.5 },
    })).rejects.toThrow();
  });

  it('accepts bounded Records filter collections and rejects larger or empty selections', async () => {
    const filtersAtLimit: RecordsFilter[] = [
      { author: didsAtLimit },
      { recipient: didsAtLimit },
      { parentId: didsAtLimit },
      { tags: tagsAtLimit },
    ];

    for (const filter of filtersAtLimit) {
      await expect(TestDataGenerator.generateRecordsQuery({ author, filter })).resolves.toBeDefined();
    }
    await expect(TestDataGenerator.generateRecordsCount({
      author,
      filter: { author: didsAtLimit },
    })).resolves.toBeDefined();

    const oneMoreDid = [...didsAtLimit, 'did:example:query-over-limit'];
    const oneMoreTag = { ...tagsAtLimit, overLimit: true };
    const filtersOverLimit: RecordsFilter[] = [
      { author: oneMoreDid },
      { recipient: oneMoreDid },
      { parentId: oneMoreDid },
      { tags: oneMoreTag },
    ];

    for (const filter of filtersOverLimit) {
      await expect(TestDataGenerator.generateRecordsQuery({ author, filter })).rejects.toThrow();
    }
    await expect(TestDataGenerator.generateRecordsCount({
      author,
      filter: { author: oneMoreDid },
    })).rejects.toThrow();

    await expect(TestDataGenerator.generateRecordsQuery({ author, filter: { author: [] } })).rejects.toThrow();
    await expect(TestDataGenerator.generateRecordsQuery({ author, filter: { recipient: [] } })).rejects.toThrow();
  });

  it('bounds Messages pages, filters, and invoked grant IDs while preserving the zero-entry probe', async () => {
    const messageCid = await TestDataGenerator.randomCborSha256Cid();
    const query = await TestDataGenerator.generateMessagesQuery({
      author,
      filters            : messageFiltersAtLimit,
      limit              : DwnConstant.maxQueryPageSize,
      permissionGrantIds : grantIdsAtLimit,
    });
    expect(query.message.descriptor.limit).toBe(DwnConstant.maxQueryPageSize);

    const probe = await TestDataGenerator.generateMessagesQuery({ author, limit: 0 });
    expect(probe.message.descriptor.limit).toBe(0);

    await expect(TestDataGenerator.generateMessagesQuery({
      author,
      limit: DwnConstant.maxQueryPageSize + 1,
    })).rejects.toThrow();
    await expect(TestDataGenerator.generateMessagesQuery({
      author,
      filters: [...messageFiltersAtLimit, { protocol: 'https://example.com/protocol/over-limit' }],
    })).rejects.toThrow();
    await expect(TestDataGenerator.generateMessagesQuery({
      author,
      permissionGrantIds: [...grantIdsAtLimit, 'grant-over-limit'],
    })).rejects.toThrow();

    await expect(TestDataGenerator.generateMessagesSubscribe({
      author,
      filters            : messageFiltersAtLimit,
      permissionGrantIds : grantIdsAtLimit,
    })).resolves.toBeDefined();
    await expect(TestDataGenerator.generateMessagesSubscribe({
      author,
      filters: [...messageFiltersAtLimit, { protocol: 'https://example.com/protocol/over-limit' }],
    })).rejects.toThrow();
    await expect(TestDataGenerator.generateMessagesSubscribe({
      author,
      permissionGrantIds: [...grantIdsAtLimit, 'grant-over-limit'],
    })).rejects.toThrow();

    await expect(TestDataGenerator.generateMessagesRead({
      author,
      messageCid,
      permissionGrantIds: grantIdsAtLimit,
    })).resolves.toBeDefined();
    await expect(TestDataGenerator.generateMessagesRead({
      author,
      messageCid,
      permissionGrantIds: [...grantIdsAtLimit, 'grant-over-limit'],
    })).rejects.toThrow();
  });
});
