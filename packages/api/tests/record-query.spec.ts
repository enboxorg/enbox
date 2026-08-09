import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { Record } from '../src/record.js';
import type { RecordQuery } from '../src/record-query.js';
import type { DwnApi, RecordsCountRequest, RecordsQueryRequest, RecordsQueryResponse } from '../src/dwn-api.js';

import { DateSort } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { compileRecordFilter, compileRecordQuery } from '../src/record-query.js';

const QueryDefinition = {
  protocol  : 'https://example.com/protocols/record-query',
  published : true,
  types     : {
    note: {
      schema      : 'https://example.com/schemas/note',
      dataFormats : ['application/json'],
    },
    attachment: {
      dataFormats: ['image/png'],
    },
  },
  structure: {
    note: {
      $actions : [{ who: 'anyone', can: ['read'] }],
      $tags    : {
        status   : { type: 'string', enum: ['draft', 'published'] },
        priority : { type: 'integer' },
      },
    },
    attachment: {
      $actions: [{ who: 'anyone', can: ['read'] }],
    },
  },
} as const satisfies ProtocolDefinition;

const QueryProtocol = defineProtocol(QueryDefinition, {
  attachment : recordCodecs.blob('image/png'),
  note       : recordCodecs.json<{ title: string }>(),
});

type CapturingDwn = {
  dwn: DwnApi;
  countRequests: RecordsCountRequest[];
  queryRequests: RecordsQueryRequest[];
};

function createCapturingDwn(queryResponses: RecordsQueryResponse[] = []): CapturingDwn {
  const countRequests: RecordsCountRequest[] = [];
  const queryRequests: RecordsQueryRequest[] = [];
  const dwn = {
    records: {
      count: async (request: RecordsCountRequest) => {
        countRequests.push(request);
        return { status: { code: 200, detail: 'OK' }, count: 7 };
      },
      query: async (request: RecordsQueryRequest) => {
        queryRequests.push(request);
        return queryResponses.shift() ?? { status: { code: 200, detail: 'OK' }, records: [] };
      },
    },
  } as unknown as DwnApi;

  return { dwn, countRequests, queryRequests };
}

function createTypedEnbox(dwn: DwnApi): TypedEnbox<typeof QueryDefinition, typeof QueryProtocol.codecs> {
  const typed = new TypedEnbox(dwn, QueryProtocol);
  (typed as unknown as { _configured: boolean })._configured = true;
  return typed;
}

describe('RecordQuery', () => {
  it('should compile the same canonical selection for query and count', async () => {
    const { dwn, countRequests, queryRequests } = createCapturingDwn();
    const typed = createTypedEnbox(dwn);
    const filter = {
      tags: { status: 'published' as const, priority: { gte: 2 } },
    };
    const query: RecordQuery<typeof QueryDefinition, 'note'> = {
      from         : 'did:example:remote',
      filter,
      dateSort     : DateSort.PublishedDescending,
      pagination   : { limit: 2 },
      protocolRole : 'editor',
      within       : 'root',
    };

    await typed.records.query('note', query);
    const count = await typed.records.count('note', query);

    const expectedFilter = {
      ...filter,
      contextId    : query.within,
      published    : true,
      protocol     : QueryDefinition.protocol,
      protocolPath : 'note',
      schema       : QueryDefinition.types.note.schema,
    };
    expect(queryRequests).toEqual([{
      from         : query.from,
      filter       : expectedFilter,
      dateSort     : query.dateSort,
      pagination   : query.pagination,
      protocolRole : query.protocolRole,
    }]);
    expect(countRequests).toEqual([{
      from         : query.from,
      filter       : expectedFilter,
      protocolRole : query.protocolRole,
    }]);
    expect(count).toBe(7);
    expect(filter).toEqual({ tags: { status: 'published', priority: { gte: 2 } } });
  });

  it('should continue the captured query without exposing its cursor state', async () => {
    const cursor = { messageCid: 'bafy-page-one', value: '2026-01-01T00:00:00Z' };
    const { dwn, queryRequests } = createCapturingDwn([
      { status: { code: 200, detail: 'OK' }, records: [], cursor },
      { status: { code: 200, detail: 'OK' }, records: [] },
    ]);
    const typed = createTypedEnbox(dwn);
    const request: RecordQuery<typeof QueryDefinition, 'note'> = {
      from         : 'did:example:remote',
      filter       : { tags: { status: 'published' } },
      dateSort     : DateSort.CreatedDescending,
      pagination   : { limit: 2 },
      protocolRole : 'editor',
      within       : 'root',
    };

    const firstPagePromise = typed.records.query('note', request);
    request.from = 'did:example:mutated';
    request.filter!.tags!.status = 'draft';
    request.pagination!.limit = 99;
    request.within = 'mutated';
    const firstPage = await firstPagePromise;

    const expectedRequest: RecordsQueryRequest = {
      from   : 'did:example:remote',
      filter : {
        contextId    : 'root',
        protocol     : QueryDefinition.protocol,
        protocolPath : 'note',
        schema       : QueryDefinition.types.note.schema,
        tags         : { status: 'published' },
      },
      dateSort     : DateSort.CreatedDescending,
      pagination   : { limit: 2 },
      protocolRole : 'editor',
    };
    expect(queryRequests[0]).toEqual(expectedRequest);

    const secondPage = await firstPage.next();
    expect(queryRequests[1]).toEqual({
      ...expectedRequest,
      pagination: { limit: 2, cursor },
    });
    expect(secondPage).toBeDefined();
    expect(await secondPage!.next()).toBeUndefined();
    expect(queryRequests).toHaveLength(2);
  });

  it('should reject a repeated continuation cursor across the page lineage', async () => {
    const firstCursor = { messageCid: 'bafy-first', value: 7 };
    const secondCursor = { messageCid: 'bafy-second', value: 8 };
    const { dwn, queryRequests } = createCapturingDwn([
      { status: { code: 200, detail: 'OK' }, records: [], cursor: firstCursor },
      { status: { code: 200, detail: 'OK' }, records: [], cursor: secondCursor },
      { status: { code: 200, detail: 'OK' }, records: [], cursor: firstCursor },
    ]);
    const firstPage = await createTypedEnbox(dwn).records.query('note', { pagination: { limit: 1 } });
    const secondPage = await firstPage.next();

    expect(secondPage).toBeDefined();
    await expect(secondPage!.next()).rejects.toThrow('query returned a repeated pagination cursor');
    expect(queryRequests).toHaveLength(3);
  });

  it('should iterate pages lazily', async () => {
    const first = { id: 'first' } as Record;
    const second = { id: 'second' } as Record;
    const { dwn, queryRequests } = createCapturingDwn([
      {
        status  : { code: 200, detail: 'OK' },
        records : [first],
        cursor  : { messageCid: 'next', value: 1 },
      },
      { status: { code: 200, detail: 'OK' }, records: [second] },
    ]);
    const page = await createTypedEnbox(dwn).records.query('note', { pagination: { limit: 1 } });

    for await (const _record of page) {
      break;
    }
    expect(queryRequests).toHaveLength(1);

    const records = [];
    for await (const record of page) {
      records.push(record);
    }
    expect(records).toEqual([first, second]);
    expect(queryRequests).toHaveLength(2);
  });

  it('should omit schema for a schema-less protocol type', () => {
    const filter = compileRecordFilter(QueryDefinition, 'attachment', { dataFormat: 'image/png' });

    expect(filter).toEqual({
      dataFormat   : 'image/png',
      protocol     : QueryDefinition.protocol,
      protocolPath : 'attachment',
    });
  });

  it('should lower within to the canonical DWN context selector', () => {
    const prefixParent = compileRecordQuery(QueryDefinition, 'root/note/attachment', { within: 'root/abc' });
    const prefixSharingSibling = compileRecordQuery(QueryDefinition, 'root/note/attachment', { within: 'root/abcd' });

    expect(prefixParent.filter.contextId).toBe('root/abc');
    expect(prefixParent.filter.parentId).toBeUndefined();
    expect(prefixSharingSibling.filter.contextId).toBe('root/abcd');
    expect(prefixSharingSibling.filter.parentId).toBeUndefined();
  });

  it('should validate within selectors before dispatch', () => {
    expect(() => compileRecordQuery(QueryDefinition, 'root/note/attachment'))
      .toThrow('nested protocol path \'root/note/attachment\' requires a within selector');
    expect(() => compileRecordQuery(QueryDefinition, 'root/note/attachment', {
      within: 'root/note/attachment/deeper',
    })).toThrow('within cannot be deeper than protocol path \'root/note/attachment\'');

    expect(compileRecordQuery(QueryDefinition, 'root/note/attachment', {
      within: 'root',
    }).filter.contextId).toBe('root');
  });

  it('should make datePublished filters select published records for count parity', () => {
    const compiled = compileRecordQuery(QueryDefinition, 'note', {
      filter: { datePublished: { from: '2026-01-01T00:00:00Z' } },
    });

    expect(compiled.filter.published).toBe(true);
  });

  it('should reject filters that would broaden or contradict the selection', () => {
    expect(() => compileRecordFilter(QueryDefinition, 'note', { author: [] }))
      .toThrow('RecordFilter: author must not be an empty array');
    expect(() => compileRecordFilter(QueryDefinition, 'note', { recipient: [] }))
      .toThrow('RecordFilter: recipient must not be an empty array');
    expect(() => compileRecordFilter(QueryDefinition, 'note', { tags: {} }))
      .toThrow('RecordFilter: tags must contain at least one tag filter');
    expect(() => compileRecordQuery(QueryDefinition, 'note', { within: '' }))
      .toThrow('Record scope: within must be at most 600 characters of alphanumeric path segments');
    expect(() => compileRecordQuery(QueryDefinition, 'root/note', { within: 'root//child' }))
      .toThrow('Record scope: within must be at most 600 characters of alphanumeric path segments');
    expect(() => compileRecordQuery(QueryDefinition, 'note', { within: 'root-child' }))
      .toThrow('Record scope: within must be at most 600 characters of alphanumeric path segments');
    expect(() => compileRecordQuery(QueryDefinition, 'note', { within: 'a'.repeat(601) }))
      .toThrow('Record scope: within must be at most 600 characters of alphanumeric path segments');
    expect(() => compileRecordQuery(QueryDefinition, 'root/note', {
      filter : { contextId: 'root' } as never,
      within : 'root',
    })).toThrow('RecordFilter: use the top-level within selector instead of contextId or parentId');
    expect(() => compileRecordQuery(QueryDefinition, 'root/note', {
      filter : { parentId: 'note' } as never,
      within : 'root',
    })).toThrow('RecordFilter: use the top-level within selector instead of contextId or parentId');
    expect(() => compileRecordQuery(QueryDefinition, 'note', {
      filter   : { published: false },
      dateSort : DateSort.PublishedAscending,
    })).toThrow('cannot be combined with published: false');
    expect(() => compileRecordFilter(QueryDefinition, 'note', {
      published     : false,
      datePublished : { to: '2026-01-01T00:00:00Z' },
    })).toThrow('cannot be combined with published: false');
  });

  it('should reject invalid record queries through both public operations', async () => {
    const { dwn, countRequests, queryRequests } = createCapturingDwn();
    const typed = createTypedEnbox(dwn);

    await expect(typed.records.query('note', { filter: { author: [] } }))
      .rejects.toThrow('RecordFilter: author must not be an empty array');
    await expect(typed.records.count('note', { filter: { author: [] } }))
      .rejects.toThrow('RecordFilter: author must not be an empty array');

    const invalidSort = { dateSort: 'unsupported' } as unknown as RecordQuery<typeof QueryDefinition, 'note'>;
    await expect(typed.records.query('note', invalidSort)).rejects.toThrow('unsupported dateSort');
    await expect(typed.records.count('note', invalidSort)).rejects.toThrow('unsupported dateSort');

    const invalidPagination = { pagination: { limit: 0 } } as RecordQuery<typeof QueryDefinition, 'note'>;
    await expect(typed.records.query('note', invalidPagination)).rejects.toThrow('pagination.limit');
    await expect(typed.records.count('note', invalidPagination)).rejects.toThrow('pagination.limit');

    const rawCursor = {
      pagination: { cursor: { messageCid: 'bafy-page', value: 1 } },
    } as unknown as RecordQuery<typeof QueryDefinition, 'note'>;
    await expect(typed.records.query('note', rawCursor)).rejects.toThrow('pagination must contain only limit');
    await expect(typed.records.count('note', rawCursor)).rejects.toThrow('pagination must contain only limit');

    expect(queryRequests).toHaveLength(0);
    expect(countRequests).toHaveLength(0);
  });

  it('should reject malformed runtime pagination at the shared compiler boundary', () => {
    const invalidPaginationValues = [
      [],
      { unexpected: true },
      { limit: 1.5 },
      { limit: Number.MAX_SAFE_INTEGER + 1 },
      { limit: Number.POSITIVE_INFINITY },
      { cursor: null },
      { limit: 1, cursor: { messageCid: 'bafy-page', value: 1 } },
    ];

    for (const pagination of invalidPaginationValues) {
      expect(() => compileRecordQuery(QueryDefinition, 'note', {
        pagination: pagination as never,
      })).toThrow('RecordQuery: pagination');
    }
  });
});
