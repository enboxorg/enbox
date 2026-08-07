import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { Record, RecordCodecValue, RecordQuery, RecordView, TypedEnbox } from '@enbox/api';

import { defineProtocol, recordCodecs } from '@enbox/api';

const QueryDefinition = {
  protocol  : 'https://example.com/protocols/query-types',
  published : true,
  types     : {
    note: {
      dataFormats: ['application/json'],
    },
    comment: {
      dataFormats: ['text/plain'],
    },
    attachment: {
      dataFormats: ['image/png'],
    },
    arrayTagged: {
      dataFormats: ['application/json'],
    },
    flexible: {
      dataFormats: ['application/json'],
    },
  },
  structure: {
    note: {
      $tags: {
        status   : { type: 'string', enum: ['draft', 'published'] },
        score    : { type: 'number' },
        position : { type: 'integer' },
        pinned   : { type: 'boolean' },
      },
      comment: {
        $tags: {
          kind: { type: 'string' },
        },
      },
    },
    attachment  : {},
    arrayTagged : {
      $tags: {
        labels: { type: 'array', items: { type: 'string' } },
      },
    },
    flexible: {
      $tags: {
        $allowUndefinedTags : true,
        known               : { type: 'string' },
      },
    },
  },
} as const satisfies ProtocolDefinition;

const QueryProtocol = defineProtocol(QueryDefinition, {
  arrayTagged : recordCodecs.json<{ value: string }>(),
  attachment  : recordCodecs.blob('image/png'),
  comment     : recordCodecs.text(),
  flexible    : recordCodecs.json<{ value: string }>(),
  note        : recordCodecs.json<{ title: string }>(),
});

type QueryCodecs = typeof QueryProtocol.codecs;
void QueryProtocol;

declare const typed: TypedEnbox<typeof QueryDefinition, QueryCodecs>;
declare const authors: string[];

const countResponse: Promise<number> = typed.records.count('note');
void countResponse;

const reusableQuery = {
  filter: {
    author     : ['did:example:alice'] as const,
    dataFormat : 'application/json',
    tags       : {
      status   : 'published',
      score    : { gte: 1, lt: 10 },
      position : { gt: 0 },
      pinned   : true,
    },
  },
} satisfies RecordQuery<typeof QueryDefinition, 'note'>;

void typed.records.query('note', reusableQuery);
void typed.records.count('note', reusableQuery);
const observedNotes: Promise<RecordView<Record<RecordCodecValue<QueryCodecs['note']>>>> = typed.records.observe('note', {
  ...reusableQuery,
  pagination: { limit: 20 },
});
void observedNotes;
void typed.records.query('note/comment', {
  filter : { tags: { kind: { startsWith: 'reply-' } } },
  within : 'note-context',
});
void typed.records.query('flexible', { filter: { tags: { known: 'value' } } });
void typed.records.query('note', { filter: { author: authors } });

// @ts-expect-error protocol paths are exact.
void typed.records.query('missing');

// @ts-expect-error count uses the same exact protocol paths.
void typed.records.count('missing');

void typed.records.observe('note', {
  from         : 'did:example:remote',
  pagination   : { limit: 20 },
  protocolRole : 'member',
});

// @ts-expect-error typed pagination continuations are private to RecordPage.next().
void typed.records.query('note', { pagination: { cursor: { messageCid: 'bafy-page', value: 1 } } });

void typed.records.observe('note', {
  // @ts-expect-error observed views start from their canonical selection rather than a raw cursor.
  pagination: { limit: 20, cursor: { messageCid: 'bafy-page', value: 1 } },
});

// @ts-expect-error observed views require an explicit retained-result bound.
void typed.records.observe('note', {});

// @ts-expect-error tags are derived for the selected path.
void typed.records.query('note', { filter: { tags: { kind: 'reply' } } });

// @ts-expect-error count uses the same path-derived tag filters.
void typed.records.count('note', { filter: { tags: { kind: 'reply' } } });

// @ts-expect-error enum-valued tags retain their literal values.
void typed.records.query('note', { filter: { tags: { status: 'archived' } } });

// @ts-expect-error numeric tags reject string filters.
void typed.records.query('note', { filter: { tags: { score: 'high' } } });

// @ts-expect-error numeric ranges require numeric boundaries.
void typed.records.query('note', { filter: { tags: { score: { gte: '1' } } } });

// @ts-expect-error numeric ranges require at least one boundary.
void typed.records.query('note', { filter: { tags: { score: {} } } });

// @ts-expect-error exclusive lower bounds cannot be combined.
void typed.records.query('note', { filter: { tags: { score: { gt: 1, gte: 2 } } } });

// @ts-expect-error boolean tags do not support range filters.
void typed.records.query('note', { filter: { tags: { pinned: { gt: false } } } });

// @ts-expect-error array-valued tags use the raw DWN API in this scalar surface.
void typed.records.query('arrayTagged', { filter: { tags: { labels: 'work' } } });

// @ts-expect-error undefined protocol tags remain an explicit raw-API escape hatch.
void typed.records.query('flexible', { filter: { tags: { custom: 'value' } } });

// @ts-expect-error paths without scalar tag definitions do not accept typed tag filters.
void typed.records.query('attachment', { filter: { tags: { status: 'published' } } });

// @ts-expect-error data formats are derived for the selected path.
void typed.records.query('attachment', { filter: { dataFormat: 'image/jpeg' } });

void typed.records.query('note/comment', { within: 'notecontext' });
void typed.records.read('note/comment', {
  filter       : { recordId: 'comment-id' },
  from         : 'did:example:remote',
  protocolRole : 'note/participant',
  within       : 'notecontext',
});
void typed.records.delete('note/comment', {
  from         : 'did:example:remote',
  protocolRole : 'note/participant',
  recordId     : 'comment-id',
  within       : 'notecontext',
});

// @ts-expect-error contextId is a raw DWN filter; typed queries use within.
void typed.records.query('note/comment', { filter: { contextId: 'root/note' }, within: 'root/note' });

// @ts-expect-error raw contextId filters are not exposed by typed reads.
void typed.records.read('note/comment', { filter: { contextId: 'root/note', recordId: 'comment-id' } });

// @ts-expect-error typed deletes use within instead of the raw contextId grant hint.
void typed.records.delete('note/comment', { contextId: 'root/note', recordId: 'comment-id' });

// @ts-expect-error parentContextId creates a child; typed queries use within.
void typed.records.query('note/comment', { filter: { parentContextId: 'root/note' } });

// @ts-expect-error parentId is a raw structural edge, not a typed context selector.
void typed.records.query('note/comment', { filter: { parentId: 'note' } });

const InlineProtocol = defineProtocol({
  protocol  : 'https://example.com/protocols/inline-query-types',
  published : true,
  types     : {
    item: { dataFormats: ['application/json'] },
  },
  structure: {
    item: {
      $tags: {
        state: { type: 'string', enum: ['open', 'closed'] },
      },
    },
  },
}, {
  item: recordCodecs.json<{ id: string }>(),
});
void InlineProtocol;

declare const inlineTyped: TypedEnbox<typeof InlineProtocol.definition, typeof InlineProtocol.codecs>;
void inlineTyped.records.query('item', { filter: { tags: { state: 'open' } } });

// @ts-expect-error const generic inference preserves inline tag enums.
void inlineTyped.records.query('item', { filter: { tags: { state: 'unknown' } } });

// @ts-expect-error const generic inference preserves inline data formats.
void inlineTyped.records.query('item', { filter: { dataFormat: 'text/plain' } });
