import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { QuerySpec } from '../src/query-spec.js';
import type { DwnApi, RecordsCountRequest, RecordsQueryRequest } from '../src/dwn-api.js';

import { DateSort } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import { defineProtocol } from '../src/define-protocol.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { compileQueryFilter, compileQuerySpec } from '../src/query-spec.js';

const QueryDefinition = {
  protocol  : 'https://example.com/protocols/query-spec',
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

type QuerySchemaMap = {
  note: { title: string };
  attachment: Blob;
};

const QueryProtocol = defineProtocol(QueryDefinition, {} as QuerySchemaMap);

type CapturingDwn = {
  dwn: DwnApi;
  countRequests: RecordsCountRequest[];
  queryRequests: RecordsQueryRequest[];
};

function createCapturingDwn(): CapturingDwn {
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
        return { status: { code: 200, detail: 'OK' }, records: [] };
      },
    },
  } as unknown as DwnApi;

  return { dwn, countRequests, queryRequests };
}

function createTypedEnbox(dwn: DwnApi): TypedEnbox<typeof QueryDefinition, QuerySchemaMap> {
  const typed = new TypedEnbox(dwn, QueryProtocol);
  (typed as unknown as { _configured: boolean })._configured = true;
  return typed;
}

describe('QuerySpec', () => {
  it('should compile one immutable selection for query and count', async () => {
    const { dwn, countRequests, queryRequests } = createCapturingDwn();
    const typed = createTypedEnbox(dwn);
    const filter = {
      contextId : 'root/parent',
      tags      : { status: 'published' as const, priority: { gte: 2 } },
    };
    const spec: QuerySpec<typeof QueryDefinition, 'note'> = {
      from         : 'did:example:remote',
      filter,
      dateSort     : DateSort.PublishedDescending,
      pagination   : { limit: 2, cursor: { messageCid: 'bafy-page', value: '2026-01-01T00:00:00Z' } },
      protocolRole : 'editor',
    };

    await typed.records.query('note', spec);
    const countResponse = await typed.records.count('note', spec);

    const expectedFilter = {
      ...filter,
      published    : true,
      protocol     : QueryDefinition.protocol,
      protocolPath : 'note',
      schema       : QueryDefinition.types.note.schema,
    };
    expect(queryRequests).toEqual([{
      from         : spec.from,
      filter       : expectedFilter,
      dateSort     : spec.dateSort,
      pagination   : spec.pagination,
      protocolRole : spec.protocolRole,
    }]);
    expect(countRequests).toEqual([{
      from         : spec.from,
      filter       : expectedFilter,
      protocolRole : spec.protocolRole,
    }]);
    expect(countResponse.count).toBe(7);
    expect(filter).toEqual({
      contextId : 'root/parent',
      tags      : { status: 'published', priority: { gte: 2 } },
    });
  });

  it('should omit schema for a schema-less protocol type', () => {
    const filter = compileQueryFilter(QueryDefinition, 'attachment', { dataFormat: 'image/png' });

    expect(filter).toEqual({
      dataFormat   : 'image/png',
      protocol     : QueryDefinition.protocol,
      protocolPath : 'attachment',
    });
  });

  it('should fence prefix-sharing direct-parent contexts by exact record ID', () => {
    const prefixParent = compileQueryFilter(QueryDefinition, 'root/note/attachment', { contextId: 'root/abc' });
    const prefixSharingSibling = compileQueryFilter(QueryDefinition, 'root/note/attachment', { contextId: 'root/abcd' });

    expect(prefixParent.contextId).toBe('root/abc');
    expect(prefixParent.parentId).toBe('abc');
    expect(prefixSharingSibling.contextId).toBe('root/abcd');
    expect(prefixSharingSibling.parentId).toBe('abcd');
  });

  it('should make datePublished filters select published records for count parity', () => {
    const compiled = compileQuerySpec(QueryDefinition, 'note', {
      filter: { datePublished: { from: '2026-01-01T00:00:00Z' } },
    });

    expect(compiled.filter.published).toBe(true);
  });

  it('should reject filters that would broaden or contradict the selection', () => {
    expect(() => compileQueryFilter(QueryDefinition, 'note', { author: [] }))
      .toThrow('filter.author must not be an empty array');
    expect(() => compileQueryFilter(QueryDefinition, 'note', { recipient: [] }))
      .toThrow('filter.recipient must not be an empty array');
    expect(() => compileQueryFilter(QueryDefinition, 'note', { tags: {} }))
      .toThrow('filter.tags must contain at least one tag filter');
    expect(() => compileQuerySpec(QueryDefinition, 'note', {
      filter   : { published: false },
      dateSort : DateSort.PublishedAscending,
    })).toThrow('cannot be combined with published: false');
    expect(() => compileQueryFilter(QueryDefinition, 'note', {
      published     : false,
      datePublished : { to: '2026-01-01T00:00:00Z' },
    })).toThrow('cannot be combined with published: false');
  });

  it('should reject invalid shared specifications through both public operations', async () => {
    const { dwn, countRequests, queryRequests } = createCapturingDwn();
    const typed = createTypedEnbox(dwn);

    await expect(typed.records.query('note', { filter: { author: [] } }))
      .rejects.toThrow('filter.author must not be an empty array');
    await expect(typed.records.count('note', { filter: { author: [] } }))
      .rejects.toThrow('filter.author must not be an empty array');

    const invalidSort = { dateSort: 'unsupported' } as unknown as QuerySpec<typeof QueryDefinition, 'note'>;
    await expect(typed.records.query('note', invalidSort)).rejects.toThrow('unsupported dateSort');
    await expect(typed.records.count('note', invalidSort)).rejects.toThrow('unsupported dateSort');

    const invalidPagination = { pagination: { limit: 0 } } as QuerySpec<typeof QueryDefinition, 'note'>;
    await expect(typed.records.query('note', invalidPagination)).rejects.toThrow('pagination.limit');
    await expect(typed.records.count('note', invalidPagination)).rejects.toThrow('pagination.limit');

    expect(queryRequests).toHaveLength(0);
    expect(countRequests).toHaveLength(0);
  });

  it('should reject malformed runtime pagination at the shared compiler boundary', () => {
    const invalidPaginationValues = [
      [],
      { unexpected: true },
      { limit: Number.POSITIVE_INFINITY },
      { cursor: null },
      { cursor: { messageCid: 7, value: '2026-01-01T00:00:00Z' } },
      { cursor: { messageCid: 'bafy-page', value: Number.NaN } },
      { cursor: { messageCid: 'bafy-page', value: 1, unexpected: true } },
    ];

    for (const pagination of invalidPaginationValues) {
      expect(() => compileQuerySpec(QueryDefinition, 'note', {
        pagination: pagination as never,
      })).toThrow('QuerySpec: pagination');
    }
  });
});
